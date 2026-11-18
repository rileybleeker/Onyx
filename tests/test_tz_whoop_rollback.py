"""WHOOP follow-up rollback: does it restore what it claims to restore? (offline, SQL text only).

sql/tz_derivation_whoop_followups.sql is staged, not applied. sql/rollback_tz_derivation_whoop_followups.sql
puts back the definitions it replaces, and its header names the source migration for each one.
Nothing checked those bodies against the sources before this file (PR #785 copied them from
source output and never diffed them). These checks read text only: no database, no network,
no credentials.

  a. Every CREATE OR REPLACE FUNCTION / CREATE OR REPLACE TRIGGER / COMMENT ON the rollback makes
     has the same text as the source migration that defines it, after normalizing only line
     endings and trailing whitespace. The source body is found by object name, not line number.
  b. Every object the rollback drops or recreates is in the forward file or in a named source
     migration. The only DROP is pds.recompute_whoop_transition_flags(), which the forward file creates.
  c. Every DROP in the rollback uses IF EXISTS.
  d. No top-level rollback statement changes stored rows (no UPDATE, INSERT, DELETE, MERGE,
     TRUNCATE, COPY or ALTER TABLE). Bodies of function definitions are not executed here, so
     they are ignored by this check.
  e. The rollback restores every function, trigger and comment the forward file creates, except
     the recompute function and its comment, which it drops.

Run: python tests/test_tz_whoop_rollback.py
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SQL_DIR = ROOT / "sql"
ROLLBACK_PATH = SQL_DIR / "rollback_tz_derivation_whoop_followups.sql"
FORWARD_PATH = SQL_DIR / "tz_derivation_whoop_followups.sql"

# (kind, name) -> the source migration the rollback header names for it.
# Kinds: "function", "trigger", "comment function", "comment view".
# None = no source defines this comment; the rollback must clear it (IS NULL).
SOURCES: dict[tuple[str, str], str | None] = {
    ("function", "set_onyx_dates_whoop_journal"): "adr_0001_04_other_onyx_dates.sql",
    ("function", "set_whoop_cycles_transition_flag"): "adr_0001_05_transition_day_flag.sql",
    ("function", "refresh_next_transition_day"): "adr_0001_05_transition_day_flag.sql",
    ("trigger", "whoop_cycles_refresh_next_transition_day"): "adr_0001_05_transition_day_flag.sql",
    ("comment function", "cycle_offset_for_instant"): "adr_0001_01_user_tz_log.sql",
    ("comment function", "interval_to_tzd"): "adr_0001_03_garmin_onyx_dates.sql",
    ("comment view", "tz_log_gaps"): "adr_0001_06_tz_log_gaps_view.sql",
    ("comment function", "refresh_next_transition_day"): None,
}
DROPPED_ON_PURPOSE = {("function", "recompute_whoop_transition_flags")}

OBJECT_RE = re.compile(
    r"^(?:CREATE OR REPLACE FUNCTION pds\.(\w+)\(|CREATE (?:OR REPLACE )?TRIGGER (\w+)\b"
    r"|COMMENT ON (FUNCTION|VIEW) pds\.(\w+)\b)",
    re.M,
)
FORBIDDEN_FIRST_WORDS = {"UPDATE", "INSERT", "DELETE", "MERGE", "TRUNCATE", "COPY", "ALTER"}


def _normalize(text: str) -> str:
    """Normalize line endings and trailing whitespace only (the sources are CRLF)."""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    return "\n".join(line.rstrip() for line in lines)


def _read(path: Path) -> str:
    return _normalize(path.read_text(encoding="utf-8"))


def _objects(text: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for fn, trig, kw, comment_name in OBJECT_RE.findall(text):
        if fn:
            out.append(("function", fn))
        elif trig:
            out.append(("trigger", trig))
        else:
            out.append((f"comment {kw.lower()}", comment_name))
    return out


def _one(pattern: str, text: str, what: str) -> re.Match[str]:
    matches = list(re.finditer(pattern, text, re.M))
    assert len(matches) == 1, f"{what}: expected exactly one definition, found {len(matches)}"
    return matches[0]


def _statement(text: str, key: tuple[str, str]) -> str | None:
    """The text of one object's definition, or None when the file does not define it.

    function: from CREATE OR REPLACE FUNCTION through the closing dollar-quote line.
    trigger:  from AFTER/BEFORE through the terminating semicolon (the CREATE prefix differs
              between files: the rollback uses CREATE OR REPLACE, the source a DROP + CREATE).
    comment:  the whole COMMENT ON statement, including its literal or NULL.
    """
    kind, name = key
    if kind == "function":
        if not re.search(rf"^CREATE OR REPLACE FUNCTION pds\.{name}\(", text, re.M):
            return None
        head = _one(rf"^CREATE OR REPLACE FUNCTION pds\.{name}\(", text, f"function {name}")
        close = re.compile(r"^\$\w*\$[^\n]*;$", re.M).search(text, head.end())
        assert close, f"function {name}: no closing dollar-quote line"
        return text[head.start(): close.end()]
    if kind == "trigger":
        if not re.search(rf"^CREATE (?:OR REPLACE )?TRIGGER {name}\s", text, re.M):
            return None
        return _one(rf"^CREATE (?:OR REPLACE )?TRIGGER {name}\s+([^;]*;)", text,
                    f"trigger {name}").group(1)
    kw = "FUNCTION" if kind == "comment function" else "VIEW"
    pattern = rf"^COMMENT ON {kw} pds\.{name}(?:\([^)]*\))? IS\s*(?:NULL|'(?:[^']|'')*');"
    if not re.search(pattern, text, re.M):
        return None
    return _one(pattern, text, f"comment on {kw.lower()} {name}").group(0)


def _top_level_statements(text: str) -> list[str]:
    """Statements outside function bodies, with comments and string literals removed."""
    no_bodies = re.sub(r"\$(\w*)\$.*?\$\1\$", "$$", text, flags=re.S)
    cleaned = re.sub(
        r"'(?:[^']|'')*'|--[^\n]*",
        lambda m: "''" if m.group(0).startswith("'") else "",
        no_bodies,
    )
    return [s.strip() for s in cleaned.split(";") if s.strip()]


ROLLBACK = _read(ROLLBACK_PATH)
FORWARD = _read(FORWARD_PATH)
ROLLBACK_OBJS = _objects(ROLLBACK)
FORWARD_OBJS = set(_objects(FORWARD))
STATEMENTS = _top_level_statements(ROLLBACK)


class RollbackBodiesMatchSources(unittest.TestCase):
    def test_rollback_objects_are_all_mapped_to_a_source(self) -> None:
        self.assertEqual(set(ROLLBACK_OBJS), set(SOURCES))

    def test_every_rollback_definition_equals_its_source(self) -> None:
        for key, source_name in SOURCES.items():
            if source_name is None:
                continue
            with self.subTest(obj=key):
                source = _read(SQL_DIR / source_name)
                rollback_def = _statement(ROLLBACK, key)
                source_def = _statement(source, key)
                self.assertIsNotNone(rollback_def, f"rollback lacks {key}")
                self.assertIsNotNone(source_def, f"{source_name} does not define {key}")
                self.assertEqual(rollback_def, source_def,
                                 f"{key} differs from {source_name}")

    def test_comment_with_no_source_is_cleared(self) -> None:
        # The forward file adds a comment on refresh_next_transition_day; the source
        # migrations never set one, so the rollback must set it back to NULL.
        key = ("comment function", "refresh_next_transition_day")
        self.assertIsNone(SOURCES[key])
        for name in ("adr_0001_01_user_tz_log.sql", "adr_0001_03_garmin_onyx_dates.sql",
                     "adr_0001_04_other_onyx_dates.sql", "adr_0001_05_transition_day_flag.sql",
                     "adr_0001_06_tz_log_gaps_view.sql"):
            with self.subTest(source=name):
                self.assertIsNone(_statement(_read(SQL_DIR / name), key))
        self.assertIsNotNone(_statement(ROLLBACK, key))
        self.assertRegex(ROLLBACK, r"COMMENT ON FUNCTION pds\.refresh_next_transition_day\(\) IS NULL;")


class DropsAndRecreatesAreKnown(unittest.TestCase):
    def test_only_the_recompute_function_is_dropped(self) -> None:
        drops = []
        for stmt in STATEMENTS:
            if stmt.startswith("DROP"):
                m = re.match(r"DROP (\w+) IF EXISTS (?:pds\.)?(\w+)", stmt)
                self.assertIsNotNone(m, f"unparsed DROP: {stmt[:80]}")
                drops.append((m.group(1).lower(), m.group(2)))
        self.assertEqual(set(drops), DROPPED_ON_PURPOSE)
        self.assertEqual(len(drops), 1)

    def test_drops_are_objects_the_forward_file_creates(self) -> None:
        self.assertTrue(DROPPED_ON_PURPOSE <= FORWARD_OBJS)

    def test_every_recreated_object_is_in_forward_file_or_a_source(self) -> None:
        for key in ROLLBACK_OBJS:
            with self.subTest(obj=key):
                self.assertTrue(key in FORWARD_OBJS or key in SOURCES,
                                f"{key} is in neither the forward file nor a named source")

    def test_rollback_restores_everything_the_forward_file_creates(self) -> None:
        expected = {k for k in FORWARD_OBJS if k not in DROPPED_ON_PURPOSE
                    and k[1] != "recompute_whoop_transition_flags"}
        self.assertTrue(expected <= set(ROLLBACK_OBJS), expected - set(ROLLBACK_OBJS))


class DropsUseIfExists(unittest.TestCase):
    def test_every_drop_has_if_exists(self) -> None:
        drops = [s for s in STATEMENTS if s.split()[0] == "DROP"]
        self.assertTrue(drops, "expected at least one DROP")
        for stmt in drops:
            with self.subTest(stmt=stmt[:80]):
                self.assertRegex(stmt, r"^DROP \w+ IF EXISTS\b")


class RollbackChangesNoStoredRows(unittest.TestCase):
    def test_header_says_it_changes_no_stored_row(self) -> None:
        self.assertIn("changes no stored row", ROLLBACK[:2000])

    def test_no_top_level_statement_writes_rows(self) -> None:
        for stmt in STATEMENTS:
            with self.subTest(stmt=stmt[:80]):
                self.assertNotIn(stmt.split()[0].upper(), FORBIDDEN_FIRST_WORDS)
        top = "\n".join(STATEMENTS)
        self.assertIsNone(re.search(r"\bALTER\b", top))
        self.assertIsNone(re.search(r"\bINSERT\s+INTO\b|\b(?:UPDATE|DELETE\s+FROM)\s+pds\.", top))


if __name__ == "__main__":
    unittest.main()
