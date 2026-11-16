"""The agent instructions stay small at the root and complete across docs/agents/ (offline, reads markdown only).

On 2026-11-16 (DOC-01) the ~370 KB root AGENTS.md, all of it loaded into every agent session, was split:
the root keeps the rules for every task (under an 8 KiB budget) and the domain rules moved, verbatim, to
docs/agents/<domain>.md with an index in docs/agents/README.md. These checks keep that arrangement honest:

  * every heading of the old root file is listed in the index and points at a file and heading that exist,
    so a rule can be moved again but never silently dropped from the map;
  * every relative link (and #anchor) in the root, the index and the domain files resolves, and so do the
    links other docs make into AGENTS.md (docs/delivery-accountability.md links the testing section);
  * every `AGENTS.md "<name>"` a code comment, workflow or doc cites still names text that exists;
  * every domain file is named in the root's list and in the index's path table, and carries its owner
    and review date;
  * the root keeps its hard rules (no tests before merge, tsc, secrets and privacy, isCiRoute, no DROP in
    MCP migrations, heartbeats, /status, dates, HRV alignment, speed, autosave, scroll-never-writes, UI
    copy, the audit-finding rule) and stays under its size budget;
  * a few load-bearing rules are still present in their domain files, and every edit made to the old root
    on master after the split (re-homed when the branch rebased) is in its domain file and listed in the index.

Synthetic only: no database, no network, no credentials. Reads files in this repository.

Run: python tests/test_agents_docs.py
"""
from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AGENTS = ROOT / "AGENTS.md"
DOCS = ROOT / "docs" / "agents"
INDEX = DOCS / "README.md"

ROOT_BUDGET_BYTES = 8192  # 8 KiB: detail belongs in a domain file, not in every session's context.

# Every markdown heading of the old root AGENTS.md (baseline 65d813f, before the 2026-11-16 split).
OLD_HEADINGS = [
    "Onyx — Agent Instructions",
    "Read this first: testing and checks (Riley, 2026-11-15)",
    "Delivery accountability (Riley, 2026-11-15)",
    "Project Structure",
    "Tech Stack",
    "Commands",
    "Database",
    "Environment Variables",
    "Agent Permissions",
    "GitHub Actions ETL",
    "Conventions",
    "Smoke testing (Playwright)",
    "Backlog & Open Items",
    "Personalize (2026-11-15)",
    "Log screen (2026-11-15)",
    "One place to enter data (2026-11-15)",
    "Desktop app (2026-11-14)",
    "Today home (2026-11-11)",
    "Procurement (2026-11-13)",
    "PC activity logger (2026-11-14)",
    "AI tool usage harvester (2026-11-14)",
    "Screen Time page (2026-11-13)",
    "Experiments: N-of-1 trials (2026-11-13)",
    "Health & appointments (2026-11-13)",
    "Medical records (2026-11-14)",
    "Financials (2026-11-12; SimpleFIN feed since 2026-11-14)",
    "Cash forecast, budgets and taxes (2026-11-14)",
    "Focus habit unlock (2026-11-13)",
]

# Rules every agent must see without opening another file: (what, pattern in the root).
ROOT_RULES = [
    ("no automated tests before merge", r"Do not run automated tests before merging"),
    ("frontend type-check", r"npx tsc --noEmit"),
    ("why tsc is local (Vercel skips type checks)", r"ignoreBuildErrors"),
    ("still write tests", r"Still write tests"),
    ("synthetic test data", r"synthetic data only"),
    ("never commit secrets", r"Never commit secrets"),
    ("the repo is public", r"repo and its Actions logs are public"),
    ("anon reads nothing", r"anon key reads nothing in `pds`"),
    ("isCiRoute exact paths", r"`isCiRoute\(\)` holds exact paths only"),
    ("no DROP in MCP migrations", r"must contain no `DROP"),
    ("always upsert", r"Always upsert"),
    ("heartbeat on every run", r"`pds\.sync_log` heartbeat on EVERY run"),
    ("GUARD prefix", r"GUARD <name>:"),
    ("every integration on /status", r"Every integration appears on `/status`"),
    ("behavioral day", r"Behavioral day = local instant − 6 h"),
    ("ET, never naive today", r"never naive `date\.today\(\)`"),
    ("HRV alignment", r"hrv_alignment\.py"),
    ("speed budget", r"full second"),
    ("autosave", r"Input saves itself"),
    ("scroll never writes", r"Scrolling never writes"),
    ("UI copy", r"UI copy"),
    ("audit findings vs data", r"Audit and review findings are settled against the data"),
    ("unverified finding becomes a roadmap row", r"roadmap row in the same session"),
    ("audit severity kept", r"P0 → `Critical`, P1 → `High`"),
    ("destructive commands need asking", r"ask before `rm`, `kill`"),
    ("delivery states", r"Launched, code written, reviewed, merged, deployed and verified are distinct states"),
    ("independent review", r"Codex independently reviews the actual resulting diff"),
    ("backlog in Notion", r"Source = \"Onyx Roadmap\""),
]

# Load-bearing rules that must stay in their domain file: (file, literal text).
DOMAIN_RULES = [
    ("ops-ci.md", "offline-checks"),
    ("ops-ci.md", "Type-check the frontend before you open a PR"),
    ("ops-ci.md", "Audit and review findings are settled against the data"),
    ("ops-ci.md", "Token recovery (Spotify)"),
    ("access-and-auth.md", "do NOT re-exempt `/api/habits`"),
    ("access-and-auth.md", "never `GRANT USAGE ON SCHEMA pds TO anon`"),
    ("database.md", "Migrations sent through the Supabase MCP must contain no `DROP …` statement"),
    ("database.md", "A bulk upsert must carry ONE key set"),
    ("database.md", "onyx_behavioral_date = ((ts AT TIME ZONE local_tz) − 6h)::date"),
    ("hrv-pipeline.md", "Never build an outcome with `.shift(-…)` in the pipeline files"),
    ("status-page.md", "`CADENCE` and `METHOD` maps"),
    ("frontend.md", "Scrolling never writes (2026-11-15):"),
    ("frontend.md", "Input saves itself"),
    ("frontend.md", "nothing Riley waits for takes a full second"),
    ("frontend.md", "No explanatory paragraphs on the screen"),
    ("reading-journal.md", "Body — VERBATIM RULE."),
    ("log-screen.md", "A new kind of daily entry goes into a Log section"),
]

# Edits to the old root that landed on master after the split and were re-homed when this branch rebased:
# (commit, domain file, literal text). Each commit also needs a row in the index's "Root edits made after
# the split" table, so a rebase that keeps the new root cannot drop the edit unnoticed.
REHOMED = [
    ("d376776", "database.md", "Journal entries go through `pds.journal_entry_onyx_dates`; the migration has no backfill"),
    ("d376776", "database.md", "its rollback is `sql/rollback_tz_derivation_2026-11-16.sql`"),
    ("d376776", "database.md", "`sql/tz_derivation_preapply_counts.sql` (run before applying, SELECT only)"),
    ("d376776", "database.md", "`sql/tz_derivation_postdeploy_checks.sql` runs right after"),
    ("d376776", "database.md", "`sql/tz_derivation_whoop_followups.sql` (not applied)"),
]

# Where code comments, workflows and docs cite `AGENTS.md "<name>"`.
CITATION_GLOBS = [
    "*.py", "tests/*.py", "tests/*.cjs", "tools/**/*.py", "tools/**/*.mjs", "tools/**/*.js",
    "frontend/src/**/*.ts", "frontend/src/**/*.tsx", "frontend/tests/*.cjs", "frontend/scripts/*.mjs",
    "frontend/scripts/*.cjs", "frontend/e2e/*.ts", ".github/workflows/*.yml", "docs/*.md",
]
# Comment markers may sit between the file name and the quoted name when a comment wraps.
CITATION = re.compile(r'AGENTS\.md,?[\s#*/]+"([^"<>\n]+)"')
LINK = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s]+)\)")


def text(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def strip_code(md: str) -> str:
    """Drop fenced blocks and inline code so example links inside code are not checked."""
    out, fenced = [], False
    for line in md.split("\n"):
        if line.lstrip().startswith("```"):
            fenced = not fenced
            continue
        if not fenced:
            out.append(re.sub(r"`[^`]*`", "", line))
    return "\n".join(out)


def slug(heading: str) -> str:
    """GitHub's heading anchor: lower case, punctuation removed, spaces to hyphens."""
    s = heading.strip().lower()
    s = re.sub(r"[^\w\- ]", "", s)
    return s.replace(" ", "-")


def headings(md: str) -> list[str]:
    return [l.lstrip("#").strip() for l in strip_fences(md).split("\n") if re.match(r"^#{1,6} ", l)]


def strip_fences(md: str) -> str:
    out, fenced = [], False
    for line in md.split("\n"):
        if line.lstrip().startswith("```"):
            fenced = not fenced
            continue
        if not fenced:
            out.append(line)
    return "\n".join(out)


def anchors(md: str) -> set[str]:
    seen: dict[str, int] = {}
    out = set()
    for h in headings(md):
        base = slug(h)
        n = seen.get(base, 0)
        out.add(base if n == 0 else f"{base}-{n}")
        seen[base] = n + 1
    return out


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[`*]", "", s)).strip().lower()


def domain_files() -> list[Path]:
    return sorted(p for p in DOCS.glob("*.md") if p.name != "README.md")


def section(md: str, heading: str) -> str:
    """The text under one `## heading` up to the next H2."""
    m = re.search(rf"^## {re.escape(heading)}\n(.*?)(?=^## |\Z)", md, re.S | re.M)
    return m.group(1) if m else ""


def table_rows(block: str) -> list[list[str]]:
    rows = []
    for line in block.split("\n"):
        if line.startswith("|") and not re.match(r"^\|\s*-", line):
            rows.append([c.strip() for c in line.strip().strip("|").split("|")])
    return rows[1:]  # drop the header row


def resolve(src: Path, target: str) -> tuple[Path | None, str | None]:
    """A relative link target -> (file, anchor). (None, None) for links this check does not cover."""
    if re.match(r"^[a-z][a-z0-9+.-]*:", target, re.I):  # http:, https:, mailto:, notion-image:
        return None, None
    path, _, anchor = target.partition("#")
    file = src if path == "" else (src.parent / path).resolve()
    return file, (anchor or None)


class AgentsDocsTest(unittest.TestCase):
    def setUp(self):
        self.root = text(AGENTS)
        self.index = text(INDEX)

    def test_root_stays_within_budget(self):
        size = len(self.root.encode("utf-8"))
        self.assertLessEqual(size, ROOT_BUDGET_BYTES,
                             f"AGENTS.md is {size} bytes; keep it at most {ROOT_BUDGET_BYTES}: move detail to "
                             "docs/agents/<domain>.md and keep only rules that bind every task")

    def test_root_keeps_hard_rules(self):
        missing = [what for what, pattern in ROOT_RULES if not re.search(pattern, self.root)]
        self.assertEqual(missing, [], "rules that must stay in the root AGENTS.md")

    def test_testing_anchor_used_by_other_docs_exists(self):
        self.assertIn("read-this-first-testing-and-checks-riley-2026-11-15", anchors(self.root))

    def test_every_old_heading_is_mapped(self):
        rows = table_rows(section(self.index, "Where the old sections went"))
        mapped = {r[0]: r[1] for r in rows if len(r) >= 2}
        self.assertEqual(sorted(set(OLD_HEADINGS) - set(mapped)), [],
                         "old AGENTS.md headings with no row in docs/agents/README.md")
        for old in OLD_HEADINGS:
            targets = LINK.findall(mapped[old])
            self.assertTrue(targets, f"{old!r} maps to no file")
            for t in targets:
                file, anchor = resolve(INDEX, t)
                self.assertIsNotNone(file, t)
                self.assertTrue(file.exists(), f"{old!r} -> missing file {t}")
                if anchor:
                    self.assertIn(anchor, anchors(text(file)), f"{old!r} -> missing heading {t}")

    def test_relative_links_resolve(self):
        # Every relative link in the instructions; in the other docs, only links into the instructions.
        own = [AGENTS, INDEX, *domain_files()]
        others = sorted((ROOT / "docs").glob("*.md"))
        broken = []
        for src in own + others:
            for target in LINK.findall(strip_code(text(src))):
                file, anchor = resolve(src, target)
                if file is None:
                    continue
                if src in others and file != AGENTS.resolve() and DOCS.resolve() not in file.parents:
                    continue
                if not file.exists():
                    broken.append(f"{src.relative_to(ROOT)} -> {target}")
                elif anchor and file.suffix == ".md" and anchor not in anchors(text(file)):
                    broken.append(f"{src.relative_to(ROOT)} -> {target} (no such heading)")
        self.assertEqual(broken, [])

    def test_cited_names_exist(self):
        corpus = norm(self.root + "\n" + "\n".join(text(p) for p in DOCS.glob("*.md")))
        missing = []
        seen: set[Path] = set()
        for pattern in CITATION_GLOBS:
            for path in ROOT.glob(pattern):
                if path in seen or "node_modules" in path.parts or path == AGENTS:
                    continue
                seen.add(path)
                for name in CITATION.findall(text(path)):
                    if norm(name) not in corpus:
                        missing.append(f"{path.relative_to(ROOT)}: {name}")
        self.assertEqual(missing, [], 'AGENTS.md "<name>" citations whose text no longer exists in the instructions')

    def test_every_domain_file_is_routed(self):
        names = {p.stem for p in domain_files()}
        listed = set(re.findall(r"\*\*([a-z][a-z0-9-]*)\*\*", section(self.root, "Find your domain rules")))
        self.assertEqual(sorted(names - listed), [], "domain files missing from the root's list")
        self.assertEqual(sorted(listed - names), [], "root list names a file that does not exist")
        by_path = {Path(t).stem for t in LINK.findall(section(self.index, "By path"))}
        self.assertEqual(sorted(names - by_path), [], "domain files missing from the index's By path table")

    def test_domain_files_carry_owner_and_review_date(self):
        for p in domain_files():
            head = "\n".join(text(p).split("\n")[:12])
            with self.subTest(file=p.name):
                self.assertTrue(text(p).startswith("# "), "starts with a title")
                self.assertIn("**Owner (source of truth):**", head)
                self.assertRegex(head, r"Last reviewed \d{4}-\d{2}-\d{2}")
                self.assertIn("](../../AGENTS.md)", head, "links back to the root")

    def test_load_bearing_domain_rules_present(self):
        missing = [f"{f}: {t}" for f, t in DOMAIN_RULES if t not in text(DOCS / f)]
        self.assertEqual(missing, [])

    def test_root_edits_after_the_split_are_rehomed(self):
        table = section(self.index, "Root edits made after the split")
        self.assertTrue(table, "docs/agents/README.md lost its 'Root edits made after the split' section")
        listed = {r[0] for r in table_rows(table) if r}
        for commit, f, literal in REHOMED:
            with self.subTest(commit=commit, file=f):
                self.assertTrue(any(f"`{commit}`" in cell for cell in listed), f"{commit} has no row in the index")
                self.assertIn(literal, text(DOCS / f))

    # --- the helpers themselves -------------------------------------------------------------------------
    def test_slug_matches_github(self):
        self.assertEqual(slug("Health & appointments (2026-11-13)"), "health--appointments-2026-11-13")
        self.assertEqual(slug("Every integration must appear on /status"), "every-integration-must-appear-on-status")
        self.assertEqual(slug("Read this first: testing and checks (Riley, 2026-11-15)"),
                         "read-this-first-testing-and-checks-riley-2026-11-15")

    def test_checks_catch_a_dropped_heading_and_a_broken_link(self):
        # Negative cases on synthetic markdown: a row missing from the map, and an anchor with no heading.
        index = "## Where the old sections went\n\n| Old | Now |\n|---|---|\n| Database | [x](database.md) |\n"
        rows = {r[0] for r in table_rows(section(index, "Where the old sections went"))}
        self.assertNotIn("Conventions", rows)
        self.assertIn("database", {Path(t).stem for t in LINK.findall(index)})
        self.assertNotIn("no-such-heading", anchors("# T\n\n## Something else\n"))
        self.assertEqual(LINK.findall(strip_code("see `[a](b.md)` and\n```\n[c](d.md)\n```\n[e](f.md)")), ["f.md"])
        self.assertEqual(CITATION.findall('// AGENTS.md "Log screen" and AGENTS.md "<name>"'), ["Log screen"])
        self.assertEqual(CITATION.findall('# see AGENTS.md\n# "Experiments"). More'), ["Experiments"])


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=1).result
    sys.exit(0 if result.wasSuccessful() else 1)
