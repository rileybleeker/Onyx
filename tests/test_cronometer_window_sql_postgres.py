"""PostgreSQL integration test for sql/cronometer_replace_servings_window.sql (PIPE-03).

tests/test_cronometer_empty_days.py models the SQL functions in Python (FakeDB). This
file runs the real migration in a throwaway PostgreSQL cluster it creates itself
(initdb into a temporary folder; on Linux and macOS the server listens only on a Unix
socket inside that folder, no TCP port) and checks what only the database can show
(Codex review PIPE03-R8):

  * the migration applies on top of the base schema, twice (it is idempotent), and
    anon / authenticated can neither call its functions nor read its two tables;
  * the importer's own calls (cronometer_import.run_import, through a small client
    that turns its RPC calls into SQL) record a day with no food on the first look,
    empty it only on a second look at least 6 h later, copy every removed row to
    pds.cronometer_cleared_rows first, and the restore block at the end of the SQL
    file puts the day back exactly;
  * the restore block also puts back a day the daily summary listed with no food: the
    copied totals replace the zero Total row the emptying left (Codex review, round 2),
    all or nothing (a failure inside it changes nothing), from one copy (the newest, or
    the one named), never over food a later import wrote, and in turn with an import
    that holds the lock;
  * a servings file whose header lost its Food Name column still starts the day's
    empty-day count over (Codex review PIPE03-R7), end to end;
  * a failure after the emptying (a test trigger that raises later in the same call)
    rolls back all four tables, and the retry then does the work once;
  * two overlapping sessions take turns on the shared advisory lock: the second one
    waits until the first commits and then sees its rows (window + manual writer,
    window + window, an emptying window + manual writer, an emptying window + a restore);
  * food seen starts the count over (a food-dates-only call, the manual writer), the
    function refuses dates it may not empty with nothing changed, and a daily row with
    no food never replaces stored food except on the day the function empties.

Nothing here can reach a real database: the cluster is created by this test, every
connection goes to its own socket (or 127.0.0.1 on Windows) with a clean environment,
no credential is read, and the data is synthetic. Without PostgreSQL binaries
(ONYX_PG_BIN, initdb on PATH, /usr/lib/postgresql/<n>/bin) the test is skipped, except
on a GitHub Actions Linux runner, where PostgreSQL is preinstalled: there a missing or
unusable one is a failure, so this coverage cannot vanish silently. It runs in the
scheduled suite after deployment (tests/run_offline_tests.py picks it up).

Run: python tests/test_cronometer_window_sql_postgres.py
"""
from __future__ import annotations

import glob
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import traceback
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")

import cronometer_import as ci  # noqa: E402

SCHEMA_SQL = ROOT / "cronometer_schema.sql"
LEGACY_SQL = ROOT / "sql" / "cronometer_replace_servings.sql"
WINDOW_SQL = ROOT / "sql" / "cronometer_replace_servings_window.sql"

WINDOW_FN = "replace_cronometer_servings_window"
COMBINED_FN = "replace_cronometer_servings_and_daily"
FUNCTIONS = ("cronometer_daily_rows_held", "cronometer_upsert_daily", "replace_cronometer_servings",
             "replace_cronometer_servings_and_daily", "replace_cronometer_servings_window")
NEW_TABLES = ("cronometer_cleared_rows", "cronometer_empty_day_candidates")

GATE = 8675309                 # advisory lock key the test holds to keep a session's transaction open
FAIL = "onyx-test-fail"        # onyx_tz_source value that makes the test trigger raise
CSV_DATE = "cronometer_csv_date"

# Dates well in the past: the function refuses a window that ends after current_date + 2.
BASE = date.today() - timedelta(days=60)


def D(n: int) -> str:
    return (BASE + timedelta(days=n)).isoformat()


WINDOW = (BASE + timedelta(days=1), BASE + timedelta(days=10))
OUTSIDE = D(-10)
STORED_SERVINGS = [(D(2), "test oats", 100.0), (D(2), "test tea", 100.0), (D(5), "test rice", 100.0),
                   (D(7), "test soup", 100.0), (OUTSIDE, "test outside", 100.0)]
STORED_DAILY = [(D(2), 200.0), (D(5), 100.0), (D(7), 100.0), (OUTSIDE, 100.0)]
UPSTREAM = [(D(2), "test oats", 100.0), (D(2), "test tea", 100.0), (D(7), "test soup", 100.0)]  # D5 removed
EMPTY_BETWEEN = [D(3), D(4), D(5), D(6)]

EXE = ".exe" if os.name == "nt" else ""


# ---------------------------------------------------------------------------
# The throwaway cluster
# ---------------------------------------------------------------------------

def _bin_dirs():
    if os.environ.get("ONYX_PG_BIN"):
        yield Path(os.environ["ONYX_PG_BIN"])
    on_path = shutil.which("initdb")
    if on_path:
        yield Path(on_path).resolve().parent

    def version(p: Path) -> int:
        try:
            return int(p.parent.name.split(".")[0])
        except ValueError:
            return 0

    for pattern in ("/usr/lib/postgresql/*/bin", "C:/Program Files/PostgreSQL/*/bin"):
        yield from sorted((Path(x) for x in glob.glob(pattern)), key=version, reverse=True)


def find_pg_bin() -> Path | None:
    for d in _bin_dirs():
        if all((d / f"{name}{EXE}").is_file() for name in ("initdb", "pg_ctl", "psql")):
            return d
    return None


def _env(app: str) -> dict[str, str]:
    """A clean environment: no PG* variable from the caller can point a client anywhere else."""
    keep = ("PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE")
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env.update(LC_ALL="C", LANG="C", PGAPPNAME=app, PGCONNECT_TIMEOUT="10", PGTZ="UTC",
               PGCLIENTENCODING="UTF8")
    return env


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class PgError(Exception):
    """A failed statement, shaped like postgrest's APIError (code + message)."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code, self.message = code, message


_ERROR = re.compile(r"ERROR:\s+([0-9A-Z]{5}):\s+(.*)")


def _pg_error(stderr: str) -> PgError:
    m = _ERROR.search(stderr or "")
    if m:
        return PgError(m.group(1), m.group(2).strip())
    return PgError("XX000", (stderr or "psql failed").strip()[-800:])


class Cluster:
    def __init__(self, bindir: Path):
        self.bin = bindir
        # A short folder: a Unix socket path must stay under ~100 characters.
        parent = "/tmp" if os.name != "nt" and os.path.isdir("/tmp") else None
        self.dir = tempfile.mkdtemp(prefix="onyxpg", dir=parent)
        self.data = os.path.join(self.dir, "data")
        self.log = os.path.join(self.dir, "server.log")
        self.host = "127.0.0.1" if os.name == "nt" else self.dir
        self.port = _free_port()
        self.n = 0
        self.procs: list[subprocess.Popen] = []
        self.started = False

    def exe(self, name: str) -> str:
        return str(self.bin / f"{name}{EXE}")

    def _run(self, cmd: list[str], what: str) -> None:
        proc = subprocess.run(cmd, env=_env("onyx_admin"), capture_output=True, text=True, timeout=180,
                              stdin=subprocess.DEVNULL)
        if proc.returncode != 0:
            log = Path(self.log).read_text(errors="replace")[-2000:] if os.path.exists(self.log) else ""
            raise RuntimeError(f"{what} failed ({proc.returncode}):\n{proc.stdout}\n{proc.stderr}\n{log}")

    def start(self) -> None:
        self._run([self.exe("initdb"), "-D", self.data, "-U", "postgres", "-A", "trust", "-E", "UTF8",
                   "--locale=C"], "initdb")
        opts = (f"-c port={self.port} -c fsync=off -c synchronous_commit=off -c full_page_writes=off "
                "-c max_connections=30 -c shared_buffers=16MB")
        if os.name == "nt":
            opts += " -c listen_addresses=127.0.0.1"
        else:
            opts += f" -c listen_addresses='' -c unix_socket_directories='{self.dir}'"
        self._run([self.exe("pg_ctl"), "-D", self.data, "-l", self.log, "-o", opts, "-w", "-t", "60", "start"],
                  "pg_ctl start")
        self.started = True

    def stop(self) -> None:
        for p in self.procs:
            if p.poll() is None:
                p.kill()
        if self.started:
            subprocess.run([self.exe("pg_ctl"), "-D", self.data, "-m", "immediate", "-w", "stop"],
                           env=_env("onyx_admin"), capture_output=True, timeout=60, stdin=subprocess.DEVNULL)
        shutil.rmtree(self.dir, ignore_errors=True)

    def _script(self, sql: str) -> str:
        self.n += 1
        path = os.path.join(self.dir, f"q{self.n}.sql")
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write("\\set VERBOSITY verbose\n" + sql)        # every error then carries its SQLSTATE
        return path

    def _psql(self, path: str) -> list[str]:
        return [self.exe("psql"), "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
                "-h", self.host, "-p", str(self.port), "-U", "postgres", "-d", "postgres", "-f", path]

    def psql(self, sql: str, app: str = "onyx_test") -> str:
        """Run a script as the superuser; its output (unaligned, tuples only). A failed
        statement raises PgError with the SQLSTATE."""
        proc = subprocess.run(self._psql(self._script(sql)), env=_env(app), capture_output=True, text=True,
                              encoding="utf-8", timeout=120, stdin=subprocess.DEVNULL)
        if proc.returncode != 0:
            raise _pg_error(proc.stderr)
        return proc.stdout

    def value(self, sql: str):
        """The JSON on the last line the script prints."""
        lines = [line for line in self.psql(sql).splitlines() if line.strip()]
        assert lines, f"no output from: {sql[:200]}"
        return json.loads(lines[-1])

    def spawn(self, sql: str, app: str) -> subprocess.Popen:
        proc = subprocess.Popen(self._psql(self._script(sql)), env=_env(app), stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, encoding="utf-8", stdin=subprocess.DEVNULL)
        self.procs.append(proc)
        return proc


# ---------------------------------------------------------------------------
# SQL helpers
# ---------------------------------------------------------------------------

ARG_TYPES = {"p_window_start": "date", "p_window_end": "date", "p_dates": "date[]",
             "p_empty_dates": "date[]", "p_servings_empty_dates": "date[]", "p_food_dates": "date[]",
             "p_serving_dates": "date[]", "p_rows": "jsonb", "p_daily_rows": "jsonb",
             "p_max_cleared_days": "integer"}


def q(text) -> str:
    return "'" + str(text).replace("'", "''") + "'"


def sql_arg(name: str, value) -> str:
    kind = ARG_TYPES[name]            # an argument the test does not know fails loudly
    if kind == "date[]":
        return "ARRAY[" + ", ".join(q(v) for v in value) + "]::date[]"
    if kind == "jsonb":
        return q(json.dumps(value)) + "::jsonb"
    if kind == "date":
        return q(value) + "::date"
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{name} must be an integer")
    return str(value)


def call_sql(fn: str, params: dict, role: str = "service_role") -> str:
    """The call PostgREST makes for supabase-py's rpc(fn, params): named arguments, as `role`."""
    args = ", ".join(f"{k} => {sql_arg(k, v)}" for k, v in params.items())
    return f"SET ROLE {role};\nSELECT pds.{fn}({args})::text;\n"


def srow(day, food, kcal=100.0, tz=CSV_DATE):
    return {"calendar_date": day, "food_name": food, "calories": kcal, "protein_g": kcal / 100,
            "onyx_et_date": day, "onyx_behavioral_date": day, "onyx_local_date": day, "onyx_tz_source": tz}


def drow(day, kcal, tz=CSV_DATE):
    return {"calendar_date": day, "calories": kcal, "protein_g": kcal / 100, "completed": False,
            "onyx_et_date": day, "onyx_behavioral_date": day, "onyx_local_date": day, "onyx_tz_source": tz}


def window_params(rows, drows, empty=(), s_empty=(), food=(), cap=3) -> dict:
    return {"p_window_start": WINDOW[0].isoformat(), "p_window_end": WINDOW[1].isoformat(),
            "p_dates": sorted({r["calendar_date"] for r in rows}), "p_rows": rows,
            "p_empty_dates": list(empty), "p_servings_empty_dates": list(s_empty), "p_food_dates": list(food),
            "p_daily_rows": drows, "p_max_cleared_days": cap}


def upstream_call(empty=tuple(EMPTY_BETWEEN), tz=CSV_DATE, daily_tz=CSV_DATE) -> dict:
    """The automated export of UPSTREAM (D5 has no food any more), as the importer sends it."""
    rows = [srow(D(2), "test oats"), srow(D(2), "test tea"), srow(D(7), "test soup", tz=tz)]
    return window_params(rows, [drow(D(2), 200.0), drow(D(7), 100.0, tz=daily_tz)], empty=empty,
                         food=[D(2), D(7)])


def servings_empty_call() -> dict:
    """The same export, but the daily summary lists D5 with zero totals (and no servings)."""
    rows = [srow(D(2), "test oats"), srow(D(2), "test tea"), srow(D(7), "test soup")]
    return window_params(rows, [drow(D(2), 200.0), drow(D(5), 0.0), drow(D(7), 100.0)],
                         empty=[D(3), D(4), D(6)], s_empty=[D(5)], food=[D(2), D(7)])


STATE_SQL = """SELECT jsonb_build_object(
  'servings',   (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.serving_id), '[]'::jsonb) FROM pds.cronometer_servings s),
  'daily',      (SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.calendar_date), '[]'::jsonb) FROM pds.cronometer_nutrition_daily n),
  'cleared',    (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.cleared_id), '[]'::jsonb) FROM pds.cronometer_cleared_rows c),
  'candidates', (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.calendar_date), '[]'::jsonb) FROM pds.cronometer_empty_day_candidates e)
)::text;"""


def state(pg: Cluster) -> dict:
    """Every row of the four tables the functions write (read as the superuser)."""
    return pg.value(STATE_SQL)


def names(st, day=None):
    return sorted(r["food_name"] for r in st["servings"] if day is None or r["calendar_date"] == day)


def day_rows(st, table, day):
    """Every stored row of one day ('servings' or 'daily'), exactly as stored."""
    return [r for r in st[table] if r["calendar_date"] == day]


def daily_days(st):
    return sorted(r["calendar_date"] for r in st["daily"])


def daily_kcal(st, day):
    (row,) = [r for r in st["daily"] if r["calendar_date"] == day]
    return float(row["calories"])


def cands(st) -> dict:
    return {r["calendar_date"]: r for r in st["candidates"]}


def seed(pg: Cluster, servings=STORED_SERVINGS, daily=STORED_DAILY, candidates=()) -> None:
    """Replace the four tables' contents. candidates: (day, hours since the first look)."""
    sql = ["DELETE FROM pds.cronometer_servings;", "DELETE FROM pds.cronometer_nutrition_daily;",
           "DELETE FROM pds.cronometer_cleared_rows;", "DELETE FROM pds.cronometer_empty_day_candidates;"]
    for day, food, kcal in servings:
        sql.append("INSERT INTO pds.cronometer_servings (calendar_date, food_name, calories, protein_g, "
                   "onyx_et_date, onyx_behavioral_date, onyx_local_date, onyx_tz_source) VALUES "
                   f"({q(day)}::date, {q(food)}, {kcal}, {kcal / 100}, {q(day)}::date, {q(day)}::date, "
                   f"{q(day)}::date, {q(CSV_DATE)});")
    for day, kcal in daily:
        sql.append("INSERT INTO pds.cronometer_nutrition_daily (calendar_date, calories, protein_g, completed, "
                   "onyx_et_date, onyx_behavioral_date, onyx_local_date, onyx_tz_source) VALUES "
                   f"({q(day)}::date, {kcal}, {kcal / 100}, false, {q(day)}::date, {q(day)}::date, "
                   f"{q(day)}::date, {q(CSV_DATE)});")
    for day, hours in candidates:
        sql.append("INSERT INTO pds.cronometer_empty_day_candidates (calendar_date, first_seen_at, last_seen_at) "
                   f"VALUES ({q(day)}::date, now() - interval '{int(hours)} hours', "
                   f"now() - interval '{int(hours)} hours');")
    pg.psql("\n".join(sql))


def age(pg: Cluster, hours: int = ci.EMPTY_CONFIRM_HOURS + 1) -> None:
    """The test's clock: make every recorded first look `hours` older."""
    pg.psql("UPDATE pds.cronometer_empty_day_candidates SET "
            f"first_seen_at = first_seen_at - interval '{hours} hours', "
            f"last_seen_at = last_seen_at - interval '{hours} hours';")


def expect_error(pg: Cluster, sql: str, code: str, text: str) -> PgError:
    try:
        pg.psql(sql)
    except PgError as e:
        assert e.code == code and text in e.message, (code, text, e.code, e.message)
        return e
    raise AssertionError(f"expected {code} ({text})")


AT_DEFAULT = re.compile(r"(v_at\s+timestamptz := )NULL;")


def restore_sql(day: str, cleared_at: str | None = None) -> str:
    """The restore block at the end of the SQL file, for one day, exactly as written
    there. cleared_at: put back that copy instead of the newest (as the file says to)."""
    text = WINDOW_SQL.read_text(encoding="utf-8")
    start = text.index("-- 6. Putting an emptied day back")
    lines = [line[len("--   "):] for line in text[start:].splitlines() if line.startswith("--   ")]
    sql = "\n".join(lines)
    assert sql.startswith("DO $restore$") and sql.rstrip().endswith("$restore$;"), sql
    assert sql.count("'<YYYY-MM-DD>'") == 1 and len(AT_DEFAULT.findall(sql)) == 1, sql
    sql = sql.replace("'<YYYY-MM-DD>'", q(day))
    if cleared_at is not None:
        sql = AT_DEFAULT.sub(lambda m: m.group(1) + q(cleared_at) + ";", sql)
    assert "<YYYY-MM-DD>" not in sql and sql.count("INSERT INTO") == 2, sql
    return sql + "\n"


BOOTSTRAP = """SET client_min_messages = warning;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA pds;
GRANT USAGE ON SCHEMA pds TO anon, authenticated, service_role;
-- The worst case for the file's own REVOKEs: everything new in pds granted to every role by default.
ALTER DEFAULT PRIVILEGES IN SCHEMA pds GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA pds GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA pds GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
"""

# A test-only trigger: raises when a row carries FAIL, reporting what the same call had
# already done at that point (rows copied away, empty-day records left).
FAIL_TRIGGER = f"""CREATE FUNCTION pds.onyx_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.onyx_tz_source = '{FAIL}' THEN
        RAISE EXCEPTION 'onyx test failure after % cleared row(s) and with % empty-day record(s)',
            (SELECT count(*) FROM pds.cronometer_cleared_rows),
            (SELECT count(*) FROM pds.cronometer_empty_day_candidates)
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER onyx_test_fail_servings BEFORE INSERT ON pds.cronometer_servings
    FOR EACH ROW EXECUTE FUNCTION pds.onyx_test_fail();
CREATE TRIGGER onyx_test_fail_daily BEFORE INSERT OR UPDATE ON pds.cronometer_nutrition_daily
    FOR EACH ROW EXECUTE FUNCTION pds.onyx_test_fail();
"""


def bootstrap(pg: Cluster) -> None:
    pg.psql(BOOTSTRAP)
    quiet = "SET client_min_messages = warning;\n"
    pg.psql(quiet + SCHEMA_SQL.read_text(encoding="utf-8"))
    pg.psql(quiet + LEGACY_SQL.read_text(encoding="utf-8"))
    for _ in range(2):                      # the migration is idempotent: applying it again is harmless
        pg.psql(quiet + WINDOW_SQL.read_text(encoding="utf-8"))
    pg.psql(FAIL_TRIGGER)


# ---------------------------------------------------------------------------
# The importer, against the cluster
# ---------------------------------------------------------------------------

class _Result:
    def __init__(self, data):
        self.data = data


class _Sink:
    def __init__(self, sink):
        self.sink = sink

    def insert(self, row):
        self.sink.append(row)
        return self

    def execute(self):
        return _Result(None)


class _Empty:
    def select(self, *_a, **_k):
        return self

    def order(self, *_a, **_k):
        return self

    def execute(self):
        return _Result([])


class _Rpc:
    def __init__(self, client, fn, params):
        self.client, self.fn, self.params = client, fn, params

    def execute(self):
        self.client.calls.append(self.fn)
        return _Result(self.client.pg.value(call_sql(self.fn, self.params)))


class PgClient:
    """The supabase-py calls cronometer_import makes on a real run: rpc() runs the
    function as service_role in the cluster, sync_log heartbeats are collected, the TZ
    ladder is empty. Any other table access fails the test (the importer writes the
    Cronometer tables only through the functions)."""

    def __init__(self, pg: Cluster):
        self.pg, self.sync_logs, self.calls = pg, [], []

    def schema(self, name):
        assert name == "pds", name
        return self

    def rpc(self, fn, params):
        return _Rpc(self, fn, params)

    def table(self, name):
        if name == "sync_log":
            return _Sink(self.sync_logs)
        if name == "user_tz_log":
            return _Empty()
        raise AssertionError(f"the importer touched pds.{name} directly")

    from_ = table

    def heartbeats(self) -> dict:
        return {r["data_type"]: r for r in self.sync_logs}      # the newest per data_type


S_HEADER = "Day,Time,Group,Food Name,Amount,Energy (kcal),Protein (g)"
D_HEADER = "Date,Group,Energy (kcal),Protein (g),Completed"


def export(folder, servings, daily=None, s_header=S_HEADER):
    """Write servings.csv + dailysummary.csv; daily defaults to the servings summed per day."""
    if daily is None:
        totals: dict[str, float] = {}
        for day, _food, kcal in servings:
            totals[day] = totals.get(day, 0.0) + kcal
        daily = sorted(totals.items())
    files = {"servings.csv": [s_header] + [f"{d},8:00 AM,Breakfast,{food},1.00 serving,{kcal},{kcal / 100}"
                                           for d, food, kcal in servings],
             "dailysummary.csv": [D_HEADER] + [f"{d},Total,{kcal},{kcal / 100},false" for d, kcal in daily]}
    paths = []
    for name, lines in files.items():
        path = os.path.join(folder, name)
        with open(path, "w", encoding="utf-8-sig", newline="") as f:
            f.write("\n".join(lines) + "\n")
        paths.append(path)
    return paths


def run(client: PgClient, paths) -> tuple[int, int]:
    """One automated run, called exactly as cronometer_etl.py calls the importer."""
    saved = ci.create_client
    ci.create_client = lambda *_a, **_k: client
    try:
        return ci.run_import(paths, window=WINDOW, roles=("servings", "daily"))
    finally:
        ci.create_client = saved


# ---------------------------------------------------------------------------
# Overlapping sessions
# ---------------------------------------------------------------------------

LOCKS_SQL = """SELECT coalesce(jsonb_agg(jsonb_build_object('app', a.application_name, 'granted', l.granted,
       'key', concat_ws(':', l.classid, l.objid, l.objsubid)) ORDER BY a.application_name, l.granted), '[]'::jsonb)::text
  FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
 WHERE l.locktype = 'advisory' AND a.application_name LIKE 'onyxlock%';"""
GATE_KEY = f"0:{GATE}:1"


def _wait(pred, what: str, procs=(), timeout: float = 60.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for p in procs:
            if p.poll() is not None:
                _out, err = p.communicate()
                raise AssertionError(f"a session ended while waiting for {what}: {err[-800:]}")
        if pred():
            return
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {what}")


def _has_lock(pg, app, granted, key) -> bool:
    return any(lk["app"] == app and lk["granted"] is granted and lk["key"] == key for lk in pg.value(LOCKS_SQL))


def _first_json(out: str):
    lines = [line for line in out.splitlines() if line.strip()]
    return json.loads(lines[0])


def overlap(pg: Cluster, a_call: str, b_call: str):
    """Session A runs a_call in a transaction it keeps open (it then waits on a lock the
    test holds); session B starts while A holds the import lock. Returns A's reply, B's
    reply and the state an observer saw while both were open."""
    gate = pg.spawn(f"SELECT pg_advisory_lock({GATE});\nSELECT pg_sleep(600);\n", "onyxlock_gate")
    try:
        _wait(lambda: _has_lock(pg, "onyxlock_gate", True, GATE_KEY), "the test's gate lock", [gate])
        a = pg.spawn("BEGIN;\n" + a_call + f"RESET ROLE;\nSELECT pg_advisory_xact_lock({GATE});\nCOMMIT;\n",
                     "onyxlock_a")
        _wait(lambda: _has_lock(pg, "onyxlock_a", False, GATE_KEY),
              "session A to finish its call and wait with its transaction open", [a])
        held = [lk["key"] for lk in pg.value(LOCKS_SQL) if lk["app"] == "onyxlock_a" and lk["granted"]]
        assert len(held) == 1, f"session A should hold exactly the import lock: {held}"
        b = pg.spawn(b_call, "onyxlock_b")
        _wait(lambda: _has_lock(pg, "onyxlock_b", False, held[0]), "session B to wait on the import lock", [b])
        during = state(pg)
        assert b.poll() is None and a.poll() is None
        pg.psql("SELECT pg_terminate_backend(pid)::text FROM pg_stat_activity "
                "WHERE application_name = 'onyxlock_gate';")
        a_out, a_err = a.communicate(timeout=120)
        b_out, b_err = b.communicate(timeout=120)
        gate.communicate(timeout=60)
        assert a.returncode == 0, f"session A failed: {a_err[-800:]}"
        assert b.returncode == 0, f"session B failed: {b_err[-800:]}"
        return _first_json(a_out), _first_json(b_out), during
    finally:
        for p in (gate,):
            if p.poll() is None:
                p.kill()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_migration_applies_twice_and_is_service_role_only(pg: Cluster) -> None:
    functions = ", ".join(q(f) for f in FUNCTIONS)
    tables = ", ".join(q(t) for t in NEW_TABLES)
    got = pg.value(f"""SELECT jsonb_build_object(
      'functions', (SELECT jsonb_agg(p.proname::text ORDER BY p.proname) FROM pg_proc p
                     JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'pds' AND p.proname::text IN ({functions})),
      'policies', (SELECT jsonb_agg(tablename::text || ':' || policyname::text ORDER BY tablename) FROM pg_policies
                    WHERE schemaname = 'pds' AND tablename::text IN ({tables})),
      'rls', (SELECT jsonb_agg(relrowsecurity ORDER BY relname) FROM pg_class
               WHERE oid IN ('pds.cronometer_cleared_rows'::regclass, 'pds.cronometer_empty_day_candidates'::regclass))
    )::text;""")
    assert got["functions"] == sorted(FUNCTIONS), got["functions"]       # one each: no stray overload
    assert got["policies"] == [f"{t}:service_full_access" for t in NEW_TABLES], got["policies"]
    assert got["rls"] == [True, True]
    seed(pg)
    calls = {WINDOW_FN: window_params([], [], food=[D(5)]),
             COMBINED_FN: {"p_dates": [D(5)], "p_rows": [srow(D(5), "test rice")], "p_daily_rows": []},
             "cronometer_upsert_daily": {"p_daily_rows": [drow(D(5), 1.0)]},
             "cronometer_daily_rows_held": {"p_daily_rows": [], "p_serving_dates": []}}
    before = state(pg)
    for role in ("anon", "authenticated"):
        for table in NEW_TABLES:
            expect_error(pg, f"SET ROLE {role};\nSELECT count(*)::text FROM pds.{table};\n", "42501",
                         "permission denied")
        for fn, params in calls.items():
            expect_error(pg, call_sql(fn, params, role=role), "42501", "permission denied")
    assert state(pg) == before, "a refused call changed something"
    for table in NEW_TABLES:
        assert pg.value(f"SET ROLE service_role;\nSELECT count(*)::text FROM pds.{table};\n") == 0


def test_importer_empties_a_day_on_the_second_look_and_the_recipe_restores_it(pg: Cluster) -> None:
    seed(pg)
    client = PgClient(pg)
    before = state(pg)
    d5_servings = [r for r in before["servings"] if r["calendar_date"] == D(5)]
    d5_daily = [r for r in before["daily"] if r["calendar_date"] == D(5)]
    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as tmp2:
        missed = export(tmp, UPSTREAM)
        assert run(client, missed) == (3, 2)                     # first look: recorded only
        st = state(pg)
        assert names(st, D(5)) == ["test rice"] and D(5) in daily_days(st) and st["cleared"] == []
        assert list(cands(st)) == [D(5)] and cands(st)[D(5)]["times_seen"] == 1
        assert client.heartbeats()["servings"]["status"] == "success"
        run(client, missed)                                       # seconds later: still one look
        st = state(pg)
        assert cands(st)[D(5)]["times_seen"] == 2 and names(st, D(5)) == ["test rice"] and st["cleared"] == []

        # The food is back on D5, but servings.csv lost its Food Name column in transit and the
        # daily summary misses D5 (Codex PIPE03-R7): nothing is written, the count starts over.
        age(pg)
        damaged = export(tmp2, UPSTREAM + [(D(5), "test rice", 100.0)], daily=[(D(2), 200.0), (D(7), 100.0)],
                         s_header=S_HEADER.replace("Food Name", "Food"))
        assert run(client, damaged) == (0, 2)
        st = state(pg)
        assert cands(st) == {}, "the damaged file's food did not start the count over"
        assert names(st, D(5)) == ["test rice"] and st["cleared"] == []
        hb = client.heartbeats()
        assert hb["servings"]["status"] == "partial" and "has no Food Name column" in hb["servings"]["error_message"]
        run(client, missed)                                       # missed again: a first look only
        st = state(pg)
        assert list(cands(st)) == [D(5)] and cands(st)[D(5)]["times_seen"] == 1 and st["cleared"] == []
        assert names(st, D(5)) == ["test rice"]

        age(pg)
        assert run(client, missed) == (3, 2)                     # the second look: emptied
        st = state(pg)
        assert names(st, D(5)) == [] and D(5) not in daily_days(st) and cands(st) == {}
        assert names(st, D(2)) == ["test oats", "test tea"] and names(st, D(7)) == ["test soup"]
        assert names(st, OUTSIDE) == ["test outside"] and OUTSIDE in daily_days(st)
        # Every removed row was copied first, exactly as it was stored, tagged with the window.
        copies = {c["source_table"]: c for c in st["cleared"]}
        assert len(st["cleared"]) == 2 and set(copies) == {"cronometer_servings", "cronometer_nutrition_daily"}
        assert copies["cronometer_servings"]["row_data"] == d5_servings[0]
        assert copies["cronometer_nutrition_daily"]["row_data"] == d5_daily[0]
        assert all(c["calendar_date"] == D(5) and c["window_start"] == WINDOW[0].isoformat()
                   and c["window_end"] == WINDOW[1].isoformat() for c in st["cleared"])
        hb = client.heartbeats()
        assert hb["servings"]["status"] == "success" and hb["servings"]["error_message"].startswith("emptied 1 day")
        assert hb["daily"]["status"] == "success" and hb["daily"]["error_message"] is None

        run(client, missed)                                       # a retry: nothing more happens
        st = state(pg)
        assert len(st["cleared"]) == 2 and names(st, D(5)) == [] and cands(st) == {}

    # The rollback recipe in the SQL file puts the day back exactly as it was.
    pg.psql(restore_sql(D(5)))
    st = state(pg)
    assert [r for r in st["servings"] if r["calendar_date"] == D(5)] == d5_servings
    assert [r for r in st["daily"] if r["calendar_date"] == D(5)] == d5_daily
    assert len(st["cleared"]) == 2, "the copies are kept"
    assert all(fn == WINDOW_FN for fn in client.calls), client.calls


def test_failure_after_emptying_rolls_back_all_four_tables_and_the_retry_works(pg: Cluster) -> None:
    for point in ("servings insert", "daily upsert"):
        seed(pg, candidates=[(D(5), ci.EMPTY_CONFIRM_HOURS + 1)])   # D5 confirmed: this call empties it
        before = state(pg)
        bad = upstream_call(tz=FAIL) if point == "servings insert" else upstream_call(daily_tz=FAIL)
        e = expect_error(pg, call_sql(WINDOW_FN, bad), "P0001", "onyx test failure")
        # The failure came after the day was emptied and its record forgotten, in the same call.
        assert "after 2 cleared row(s) and with 0 empty-day record(s)" in e.message, (point, e.message)
        assert state(pg) == before, f"{point}: the failed call left a change behind"

        out = pg.value(call_sql(WINDOW_FN, upstream_call()))       # the retry
        assert (out["cleared_days"], out["cleared_servings"], out["cleared_daily"]) == (1, 1, 1), out
        assert out["inserted"] == 3 and out["daily_upserted"] == 2 and out["refused_days"] == 0, out
        st = state(pg)
        assert names(st, D(5)) == [] and D(5) not in daily_days(st) and cands(st) == {}
        assert len(st["cleared"]) == 2, "the failed attempt's copies must not remain"
        again = pg.value(call_sql(WINDOW_FN, upstream_call()))     # and once more: nothing more
        assert again["cleared_days"] == 0 and again["pending_days"] == 0, again
        assert len(state(pg)["cleared"]) == 2

    # The manual writer forgets the record of the day it writes; a failure later in the
    # same call puts the record back with everything else.
    seed(pg, candidates=[(D(5), ci.EMPTY_CONFIRM_HOURS + 1)])
    before = state(pg)
    manual = {"p_dates": [D(5)], "p_rows": [srow(D(5), "test rice", tz=FAIL)], "p_daily_rows": [drow(D(5), 100.0)]}
    e = expect_error(pg, call_sql(COMBINED_FN, manual), "P0001", "onyx test failure")
    assert "with 0 empty-day record(s)" in e.message, e.message
    assert state(pg) == before


def test_overlapping_sessions_take_turns_on_the_import_lock(pg: Cluster) -> None:
    manual_d5 = call_sql(COMBINED_FN, {"p_dates": [D(5)], "p_rows": [srow(D(5), "test rice")],
                                       "p_daily_rows": [drow(D(5), 100.0)]})

    # 1. Automated first look (records D5) + a manual import of D5 that starts while it is open.
    seed(pg)
    before = state(pg)
    a, b, during = overlap(pg, call_sql(WINDOW_FN, upstream_call()), manual_d5)
    assert during == before, "an open transaction's changes were visible to others"
    assert a["pending_days"] == 1 and b["inserted"] == 1 and b["daily_upserted"] == 1, (a, b)
    st = state(pg)
    # B waited for A's commit and then forgot A's record. Without the shared lock B would
    # have run first and A's record of D5 would remain.
    assert cands(st) == {}, cands(st)
    assert names(st, D(5)) == ["test rice"] and D(5) in daily_days(st) and st["cleared"] == []

    # 2. Two automated runs at the same time are one look, not two.
    seed(pg)
    a, b, _during = overlap(pg, call_sql(WINDOW_FN, upstream_call()), call_sql(WINDOW_FN, upstream_call()))
    assert a["pending_days"] == 1 and b["pending_days"] == 1 and b["cleared_days"] == 0, (a, b)
    st = state(pg)
    assert cands(st)[D(5)]["times_seen"] == 2 and names(st, D(5)) == ["test rice"] and st["cleared"] == []

    # 3. An automated run that empties D5 + a manual import of D5 waiting behind it: the
    # day ends up with the manual import's servings AND daily row, the copies stay.
    seed(pg, candidates=[(D(5), ci.EMPTY_CONFIRM_HOURS + 1)])
    before = state(pg)
    a, b, during = overlap(pg, call_sql(WINDOW_FN, upstream_call()), manual_d5)
    assert during == before
    assert a["cleared_days"] == 1 and b["inserted"] == 1 and b["deleted"] == 0, (a, b)
    st = state(pg)
    assert names(st, D(5)) == ["test rice"] and daily_kcal(st, D(5)) == 100.0 and cands(st) == {}
    assert sorted(c["source_table"] for c in st["cleared"]) == ["cronometer_nutrition_daily", "cronometer_servings"]

    # 4. A restore of D5 started while an automated run is emptying it waits for that
    # run, then puts the day back (without the shared lock it would find no copy yet).
    seed(pg, candidates=[(D(5), ci.EMPTY_CONFIRM_HOURS + 1)])
    before = state(pg)
    a, b, during = overlap(pg, call_sql(WINDOW_FN, upstream_call()),
                           restore_sql(D(5)) + "SELECT jsonb_build_object('restored', true)::text;\n")
    assert during == before and a["cleared_days"] == 1 and b == {"restored": True}, (a, b)
    st = state(pg)
    assert day_rows(st, "servings", D(5)) == day_rows(before, "servings", D(5))
    assert day_rows(st, "daily", D(5)) == day_rows(before, "daily", D(5)) and cands(st) == {}
    assert len(st["cleared"]) == 2, "the copies stay"


def test_food_seen_resets_the_count_and_refused_calls_change_nothing(pg: Cluster) -> None:
    seed(pg, candidates=[(D(5), 9), (OUTSIDE, 9)])
    before = state(pg)
    out = pg.value(call_sql(WINDOW_FN, window_params([], [], food=[D(5), OUTSIDE])))
    assert out["inserted"] == 0 and out["cleared_days"] == 0, out
    st = state(pg)
    assert cands(st) == {} and (st["servings"], st["daily"], st["cleared"]) == \
        (before["servings"], before["daily"], before["cleared"])

    seed(pg, candidates=[(D(5), 9)])
    before = state(pg)
    refusals = [
        (upstream_call(empty=[D(1)]), "does not lie strictly between"),          # the window's first day
        (upstream_call(empty=[D(8)]), "does not lie strictly between"),          # past the newest food
        ({**upstream_call(), "p_food_dates": [D(2), D(5), D(7)], "p_empty_dates": [D(5)]},
         "also listed as having no food"),
        (window_params([srow(D(2), "test oats"), srow(D(11), "test late")], [], empty=[D(5)]),
         "outside the window"),
        ({**upstream_call(), "p_dates": [D(2)]}, "is not the set of calendar_date values"),
    ]
    for params, text in refusals:
        expect_error(pg, call_sql(WINDOW_FN, params), "22023", text)
        assert state(pg) == before, text

    # The manual writer forgets the record of every date it writes.
    out = pg.value(call_sql(COMBINED_FN, {"p_dates": [], "p_rows": [], "p_daily_rows": [drow(D(5), 100.0)]}))
    assert out["daily_upserted"] == 1 and out["daily_kept"] == 0, out
    assert cands(state(pg)) == {}


def test_a_daily_row_with_no_food_replaces_stored_food_only_on_the_emptied_day(pg: Cluster) -> None:
    seed(pg)
    out = pg.value(call_sql(COMBINED_FN, {"p_dates": [], "p_rows": [], "p_daily_rows": [drow(D(5), 0.0)]}))
    assert (out["daily_upserted"], out["daily_kept"]) == (0, 1), out
    assert daily_kcal(state(pg), D(5)) == 100.0, "a manual zero row wiped the stored totals"

    # The automated export lists D5 with zero totals and no servings: kept on the first
    # look, emptied (stored servings and daily row copied away, the zero row written) on
    # the second.
    call = servings_empty_call()
    first = pg.value(call_sql(WINDOW_FN, call))
    assert (first["daily_upserted"], first["daily_kept"], first["pending_days"]) == (2, 1, 1), first
    st = state(pg)
    assert daily_kcal(st, D(5)) == 100.0 and names(st, D(5)) == ["test rice"]
    age(pg)
    second = pg.value(call_sql(WINDOW_FN, call))
    assert (second["cleared_days"], second["cleared_servings"], second["cleared_daily"]) == (1, 1, 1), second
    assert (second["daily_upserted"], second["daily_kept"]) == (3, 0), second
    st = state(pg)
    assert names(st, D(5)) == [] and daily_kcal(st, D(5)) == 0.0 and cands(st) == {}
    assert sorted(c["source_table"] for c in st["cleared"]) == ["cronometer_nutrition_daily", "cronometer_servings"]


def tag_serving_copies(pg: Cluster, tz: str) -> None:
    """Set onyx_tz_source in every copied serving (FAIL makes putting it back raise)."""
    pg.psql("UPDATE pds.cronometer_cleared_rows SET row_data = jsonb_set(row_data, '{onyx_tz_source}', "
            f"to_jsonb({q(tz)}::text)) WHERE source_table = 'cronometer_servings';")


def test_restore_puts_a_servings_empty_day_back_over_its_zero_row(pg: Cluster) -> None:
    """Codex review (round 2): a day the daily summary listed with no food keeps a zero
    Total row once it is emptied. The restore block must put the copied daily row back
    in its place (an ON CONFLICT DO NOTHING insert kept the zero row), all or nothing,
    from one copy only, and never over food a later import wrote."""
    seed(pg, candidates=[(D(5), ci.EMPTY_CONFIRM_HOURS + 1)])
    original = state(pg)
    expect_error(pg, restore_sql(D(5)), "P0002", "no copy of")          # nothing emptied yet
    assert state(pg) == original

    out = pg.value(call_sql(WINDOW_FN, servings_empty_call()))           # D5 confirmed: emptied
    assert (out["cleared_days"], out["cleared_servings"], out["cleared_daily"]) == (1, 1, 1), out
    emptied = state(pg)
    assert names(emptied, D(5)) == [] and daily_kcal(emptied, D(5)) == 0.0

    # All or nothing: the restore takes the zero row out and then fails on the copied
    # serving (the test trigger); the zero row and everything else stay as they were.
    tag_serving_copies(pg, FAIL)
    broken = state(pg)
    expect_error(pg, restore_sql(D(5)), "P0001", "onyx test failure")
    assert state(pg) == broken, "a failed restore left a change behind"
    tag_serving_copies(pg, CSV_DATE)
    assert state(pg) == emptied

    # A stray empty-day record is forgotten too, so emptying the day again takes two new looks.
    pg.psql("INSERT INTO pds.cronometer_empty_day_candidates (calendar_date, first_seen_at, last_seen_at) "
            f"VALUES ({q(D(5))}::date, now() - interval '30 hours', now() - interval '30 hours');")
    pg.psql(restore_sql(D(5)))
    st = state(pg)
    assert day_rows(st, "servings", D(5)) == day_rows(original, "servings", D(5))
    assert day_rows(st, "daily", D(5)) == day_rows(original, "daily", D(5)), "the zero row stayed"
    assert daily_kcal(st, D(5)) == 100.0 and cands(st) == {} and st["cleared"] == emptied["cleared"]
    rest = lambda s: [r for t in ("servings", "daily") for r in s[t] if r["calendar_date"] != D(5)]  # noqa: E731
    assert rest(st) == rest(emptied), "only the restored day may change"
    first = pg.value(call_sql(WINDOW_FN, servings_empty_call()))         # still empty upstream: a first look
    assert (first["cleared_days"], first["pending_days"], first["daily_kept"]) == (0, 1, 1), first
    assert daily_kcal(state(pg), D(5)) == 100.0 and names(state(pg), D(5)) == ["test rice"]

    again = state(pg)
    expect_error(pg, restore_sql(D(5)), "55000", "has servings again")
    assert state(pg) == again

    # The day changes (a manual import writes it) and is emptied a second time: two
    # copies. The block takes the newest by default and the older one when told to.
    pg.value(call_sql(COMBINED_FN, {"p_dates": [D(5)], "p_rows": [srow(D(5), "test rice v2", 150.0)],
                                    "p_daily_rows": [drow(D(5), 150.0)]}))
    pg.value(call_sql(WINDOW_FN, servings_empty_call()))
    age(pg)
    second = pg.value(call_sql(WINDOW_FN, servings_empty_call()))
    assert second["cleared_days"] == 1, second
    twice = state(pg)
    assert len(twice["cleared"]) == 4 and len({c["cleared_at"] for c in twice["cleared"]}) == 2, twice["cleared"]
    peek = pg.value("BEGIN;\n" + restore_sql(D(5)) + STATE_SQL + "\nROLLBACK;\n")
    assert names(peek, D(5)) == ["test rice v2"] and daily_kcal(peek, D(5)) == 150.0, peek
    assert state(pg) == twice, "the rolled-back restore left a change behind"
    (older,) = {c["cleared_at"] for c in twice["cleared"] if c["row_data"].get("food_name") == "test rice"}
    pg.psql(restore_sql(D(5), cleared_at=older))
    st = state(pg)
    assert day_rows(st, "servings", D(5)) == day_rows(original, "servings", D(5))
    assert day_rows(st, "daily", D(5)) == day_rows(original, "daily", D(5)) and len(st["cleared"]) == 4

    # Food a later import wrote is never replaced: a daily row with food and no servings.
    pg.psql(f"DELETE FROM pds.cronometer_servings WHERE calendar_date = {q(D(5))}::date;")
    daily_only = state(pg)
    expect_error(pg, restore_sql(D(5)), "55000", "has food again")
    assert state(pg) == daily_only


TESTS = [test_migration_applies_twice_and_is_service_role_only,
         test_importer_empties_a_day_on_the_second_look_and_the_recipe_restores_it,
         test_failure_after_emptying_rolls_back_all_four_tables_and_the_retry_works,
         test_overlapping_sessions_take_turns_on_the_import_lock,
         test_food_seen_resets_the_count_and_refused_calls_change_nothing,
         test_a_daily_row_with_no_food_replaces_stored_food_only_on_the_emptied_day,
         test_restore_puts_a_servings_empty_day_back_over_its_zero_row]


def main() -> int:
    required = os.environ.get("GITHUB_ACTIONS") == "true" and sys.platform.startswith("linux")
    bindir = find_pg_bin()
    problem = None
    if bindir is None:
        problem = "no PostgreSQL binaries found (ONYX_PG_BIN = the folder with initdb, pg_ctl and psql)"
    elif hasattr(os, "geteuid") and os.geteuid() == 0:
        problem = "initdb cannot run as root"
    if problem:
        if required:
            print(f"FAIL: {problem}. GitHub's Linux runners have PostgreSQL preinstalled; this test must run there.")
            return 1
        print(f"SKIP: {problem}")
        return 0
    pg = Cluster(bindir)
    failures = 0
    try:
        pg.start()
        bootstrap(pg)
        for fn in TESTS:
            try:
                fn(pg)
                print(f"ok   {fn.__name__}")
            except Exception:  # noqa: BLE001
                failures += 1
                print(f"FAIL {fn.__name__}:\n{traceback.format_exc()}")
    finally:
        pg.stop()
    if failures:
        print(f"{failures} failure(s)")
        return 1
    print("OK - Cronometer window SQL passed against PostgreSQL.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
