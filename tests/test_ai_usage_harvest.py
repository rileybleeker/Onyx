"""AI tool usage harvester: metadata only (no log content leaks), counting rules, upload rows. Synthetic logs only.

Every content field in the fixtures (prompts, replies, thinking, tool inputs and outputs, titles, branches,
instructions, ids and the parent folders of the working directory) carries the marker "LEAK". The privacy
tests fail if that marker reaches the rows, the printed dry-run summary, anything posted to Supabase
(rows + heartbeat) or the log. Never copy real log lines into this file.

Run: python tests/test_ai_usage_harvest.py
"""
import io
import json
import logging
import os
import re
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools" / "ai_usage_harvest"))

import ai_usage_harvest as h  # noqa: E402

ET = timezone(timedelta(hours=-5))  # a fixed offset: no tzdata needed on any OS
HOME = "C:\\Users\\LEAK_USER"
MARK = "leak"
NOW = datetime(2026, 11, 13, 12, 0, tzinfo=ET)


def at(y, mo, d, hh, mm=0, ss=0):
    return datetime(y, mo, d, hh, mm, ss, tzinfo=ET)


def zulu(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def write(path: Path, lines, mtime: datetime):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(x if isinstance(x, str) else json.dumps(x) for x in lines) + "\n", encoding="utf-8")
    os.utime(path, (mtime.timestamp(), mtime.timestamp()))
    return path


# ---------------------------------------------------------------- Claude Code fixtures
CWD_MYPROJ = "C:\\Users\\LEAK_USER\\LEAK_PARENT\\MyProj"


def c_user(uid, ts, content, cwd=CWD_MYPROJ, entry="cli", **extra):
    return {"type": "user", "uuid": f"leak-{uid}", "parentUuid": "leak-parent", "sessionId": "leak-session",
            "timestamp": zulu(ts), "cwd": cwd, "entrypoint": entry, "gitBranch": "LEAK_BRANCH",
            "version": "9.9.9", "message": {"role": "user", "content": content}, **extra}


def c_asst(uid, ts, mid, blocks, usage, model="claude-opus-5-5", cwd=CWD_MYPROJ, entry="cli", **extra):
    return {"type": "assistant", "uuid": f"leak-{uid}", "sessionId": "leak-session", "timestamp": zulu(ts),
            "cwd": cwd, "entrypoint": entry, "gitBranch": "LEAK_BRANCH", "requestId": "req_leak",
            "message": {"id": mid, "model": model, "role": "assistant", "content": blocks,
                        "usage": dict(zip(("input_tokens", "output_tokens", "cache_read_input_tokens",
                                           "cache_creation_input_tokens"), usage))}, **extra}


def u4(i, o, cr=0, cw=0):
    return (i, o, cr, cw)


def build_claude(base: Path):
    proj = base / "C--Users-LEAK_USER-LEAK_PARENT-MyProj"
    u1 = c_user("u1", at(2026, 11, 10, 14), "LEAK_PROMPT print my key sk-ant-LEAK")
    a1 = c_asst("a1", at(2026, 11, 10, 14, 0, 5), "msg_leak_1", [{"type": "thinking", "thinking": "LEAK_THINKING"}],
                u4(10, 5, 100, 20))
    # session A: prompt, a message split over two records (usage repeated), a tool call and its result,
    # a reply, an injected meta record, a synthetic message, a late-night prompt and reply.
    write(proj / "leak-session-1.jsonl", [
        {"type": "file-history-snapshot", "messageId": "leak",
         "snapshot": {"trackedFileBackups": {"C:\\LEAK_PARENT\\MyProj\\LEAK_secret.env": {}}}},
        {"type": "ai-title", "aiTitle": "LEAK_TITLE", "sessionId": "leak-session"},
        u1, a1,
        c_asst("a2", at(2026, 11, 10, 14, 0, 6), "msg_leak_1",
               [{"type": "tool_use", "id": "toolu_leak_1", "name": "Bash", "input": {"command": "cat LEAK_TOOL_INPUT"}}],
               u4(10, 50, 100, 20)),
        c_user("u2", at(2026, 11, 10, 14, 1, 10),
               [{"type": "tool_result", "tool_use_id": "toolu_leak_1", "content": "LEAK_TOOL_OUTPUT"}],
               toolUseResult={"stdout": "LEAK_TOOL_OUTPUT", "filePath": "C:\\LEAK_PARENT\\x"}),
        c_asst("a3", at(2026, 11, 10, 14, 1, 20), "msg_leak_2", [{"type": "text", "text": "LEAK_REPLY"}], u4(3, 7)),
        c_user("u3", at(2026, 11, 10, 14, 1, 30), "LEAK_META caveat", isMeta=True),
        c_asst("a-synth", at(2026, 11, 10, 14, 1, 40), "msg_leak_synth", [{"type": "text", "text": "LEAK_SYNTH"}],
               u4(0, 0), model="<synthetic>"),
        {"type": "queue-operation", "timestamp": zulu(at(2026, 11, 10, 14, 2)), "content": "LEAK_QUEUE"},
        {"type": "last-prompt", "lastPrompt": "LEAK_PROMPT"},
        c_user("u4", at(2026, 11, 11, 0, 30), [{"type": "text", "text": "LEAK_LATE_PROMPT"}]),
        c_asst("a4", at(2026, 11, 11, 0, 30, 10), "msg_leak_3", [{"type": "text", "text": "LEAK_LATE_REPLY"}], u4(1, 2)),
        '{"type":"user","uuid":"leak-torn","timestamp":"2026-11-11T05:31:00.000Z","message":{"content":"LEAK_TORN',
    ], at(2026, 11, 11, 0, 31))
    # its subagent transcript: tokens and tool calls count, its prompt and activity do not
    write(proj / "leak-session-1" / "subagents" / "agent-leak.jsonl", [
        c_user("s1", at(2026, 11, 10, 14, 0, 7), "LEAK_SUBAGENT_PROMPT", isSidechain=True),
        c_asst("s2", at(2026, 11, 10, 14, 0, 30), "msg_leak_sub1",
               [{"type": "tool_use", "id": "toolu_leak_sub1", "name": "Read", "input": {"file_path": "C:\\LEAK"}}],
               u4(1000, 100), model="claude-haiku-5", isSidechain=True),
    ], at(2026, 11, 10, 14, 1))
    # session B resumes A: repeats two of A's records (same uuids), then new work on Nov 12
    write(proj / "leak-session-2.jsonl", [
        u1, a1,
        c_user("u5", at(2026, 11, 12, 10), "LEAK_RESUMED_PROMPT"),
        c_asst("a5", at(2026, 11, 12, 10, 0, 20), "msg_leak_5", [{"type": "text", "text": "LEAK"}], u4(4, 6)),
    ], at(2026, 11, 12, 10, 1))
    # an SDK run: left out entirely
    sdk_cwd = "C:\\Users\\LEAK_USER\\LEAK_PARENT\\SdkProj"
    write(base / "C--Users-LEAK_USER-LEAK_PARENT-SdkProj" / "leak-session-3.jsonl", [
        c_user("k1", at(2026, 11, 10, 15), "LEAK_SDK_PROMPT", cwd=sdk_cwd, entry="sdk-cli"),
        c_asst("k2", at(2026, 11, 10, 15, 0, 5), "msg_leak_k", [{"type": "text", "text": "LEAK"}], u4(9, 9),
               cwd=sdk_cwd, entry="sdk-cli"),
    ], at(2026, 11, 10, 15, 1))
    # a Claude Code worktree: stored under the repo's name, not the worktree's
    wt = "C:\\Users\\LEAK_USER\\Onyx\\.claude\\worktrees\\agent-leak42"
    write(base / "C--Users-LEAK_USER-Onyx--claude-worktrees-agent-leak42" / "leak-session-4.jsonl", [
        c_user("w1", at(2026, 11, 10, 16), "LEAK_WT_PROMPT", cwd=wt, entry="claude-vscode"),
        c_asst("w2", at(2026, 11, 10, 16, 0, 30), "msg_leak_w", [{"type": "text", "text": "LEAK"}], u4(2, 3),
               cwd=wt, entry="claude-vscode"),
    ], at(2026, 11, 10, 16, 1))
    # started in the home folder: stored as 'home' (the folder's name is the user name)
    write(base / "C--Users-LEAK_USER" / "leak-session-5.jsonl", [
        c_user("h1", at(2026, 11, 10, 17), "LEAK_HOME_PROMPT", cwd=HOME, entry="claude-desktop"),
    ], at(2026, 11, 10, 17, 1))


# ---------------------------------------------------------------- Codex fixtures
CODEX_CWD = "/home/LEAK_USER/LEAK_PARENT/CodexProj"


def x(kind, ts, payload):
    return {"timestamp": zulu(ts), "type": kind, "payload": payload}


def tokens(i, cached, out, cw=0):
    return {"input_tokens": i, "cached_input_tokens": cached, "output_tokens": out,
            "cache_write_input_tokens": cw, "reasoning_output_tokens": 0, "total_tokens": i + out}


def token_event(ts, total, last):
    return x("event_msg", ts, {"type": "token_count", "info": {"total_token_usage": total, "last_token_usage": last,
                                                                "model_context_window": 1},
                               "rate_limits": {"note": "LEAK"}})


def meta(ts, originator="Codex Desktop", cwd=CODEX_CWD, **extra):
    return x("session_meta", ts, {"id": "leak-thread", "timestamp": zulu(ts), "cwd": cwd, "originator": originator,
                                  "cli_version": "9.9.9", "base_instructions": {"text": "LEAK_INSTRUCTIONS"},
                                  "git": {"branch": "LEAK_BRANCH", "repository_url": "https://LEAK.example"},
                                  "source": "vscode", **extra})


PROMPT_LINE = json.dumps(x("event_msg", at(2026, 11, 10, 9, 0, 2), {"type": "user_message", "message": "LEAK_PROMPT"}))


def build_codex(base: Path):
    day = base / "2026" / "11" / "10"
    write(day / "rollout-2026-11-10T09-00-00-leak1.jsonl", [
        meta(at(2026, 11, 10, 9)),
        x("turn_context", at(2026, 11, 10, 9, 0, 1), {"cwd": "/LEAK", "model": "gpt-5.5-codex", "summary": "LEAK"}),
        PROMPT_LINE,
        x("response_item", at(2026, 11, 10, 9, 0, 2),
          {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "LEAK_PROMPT"}]}),
        x("event_msg", at(2026, 11, 10, 9, 0, 2),
          {"type": "item_completed", "item": {"type": "UserMessage", "content": "LEAK_PROMPT", "id": "leak"}}),
        x("response_item", at(2026, 11, 10, 9, 0, 10),
          {"type": "function_call", "name": "shell", "arguments": "{\"cmd\": \"LEAK_TOOL_INPUT\"}", "call_id": "leak"}),
        x("event_msg", at(2026, 11, 10, 9, 0, 11),
          {"type": "item_completed", "item": {"type": "CommandExecution", "command": "LEAK", "stdout": "LEAK"}}),
        x("response_item", at(2026, 11, 10, 9, 0, 12),
          {"type": "function_call_output", "call_id": "leak", "output": "LEAK_TOOL_OUTPUT"}),
        token_event(at(2026, 11, 10, 9, 0, 13), tokens(1000, 600, 50), tokens(1000, 600, 50)),
        token_event(at(2026, 11, 10, 9, 0, 14), tokens(1000, 600, 50), tokens(1000, 600, 50)),  # repeated: adds 0
        x("event_msg", at(2026, 11, 10, 9, 1), {"type": "agent_message", "message": "LEAK_REPLY"}),
        token_event(at(2026, 11, 10, 9, 1, 1), tokens(1500, 900, 80), tokens(500, 300, 30)),
    ], at(2026, 11, 10, 9, 2))
    # a fork: starts from the parent's total and repeats one of its lines
    write(day / "rollout-2026-11-10T09-05-00-leak2.jsonl", [
        meta(at(2026, 11, 10, 9, 5), forked_from_id="leak-thread"),
        PROMPT_LINE,
        x("event_msg", at(2026, 11, 10, 9, 5, 30), {"type": "user_message", "message": "LEAK_FORK_PROMPT"}),
        token_event(at(2026, 11, 10, 9, 5, 40), tokens(1600, 900, 90), tokens(100, 0, 10)),
    ], at(2026, 11, 10, 9, 6))
    # a subagent thread: tokens, tool calls and the subagent count only
    write(day / "rollout-2026-11-10T09-02-00-leak3.jsonl", [
        meta(at(2026, 11, 10, 9, 2), source={"subagent": {"thread_spawn": {"parent_thread_id": "leak-thread"}}},
             parent_thread_id="leak-thread"),
        x("event_msg", at(2026, 11, 10, 9, 2, 1), {"type": "user_message", "message": "LEAK_SUB"}),
        x("response_item", at(2026, 11, 10, 9, 2, 5),
          {"type": "function_call", "name": "shell", "arguments": "LEAK", "call_id": "leak"}),
        token_event(at(2026, 11, 10, 9, 2, 10), tokens(50, 0, 5), tokens(50, 0, 5)),
    ], at(2026, 11, 10, 9, 3))
    # an exec run: left out
    write(day / "rollout-2026-11-10T10-00-00-leak4.jsonl", [
        meta(at(2026, 11, 10, 10), originator="codex_exec"),
        x("event_msg", at(2026, 11, 10, 10, 0, 1), {"type": "user_message", "message": "LEAK_EXEC"}),
        token_event(at(2026, 11, 10, 10, 0, 2), tokens(7, 0, 7), tokens(7, 0, 7)),
    ], at(2026, 11, 10, 10, 1))


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.claude, self.codex, self.data = base / "claude" / "projects", base / "codex" / "sessions", base / "state"
        self.data.mkdir()
        build_claude(self.claude)
        build_codex(self.codex)
        self._env = mock.patch.dict(os.environ, {"ONYX_PC_DEVICE": "test-pc"})
        self._env.start()

    def tearDown(self):
        self._env.stop()
        self.tmp.cleanup()

    def rows(self, final=None):
        trs, stats = h.collect(self.claude, self.codex, final or {h.CLAUDE: None, h.CODEX: None}, HOME,
                               frozenset(), ET)
        rows = h.build_rows(h.aggregate(trs, ET), "test-pc", "2026-11-13T17:00:00+00:00")
        return {(r["behavioral_date"], r["tool"], r["project"]): r for r in rows}, stats

    def run_harvest(self, dry_run=False, client=None, now=NOW):
        client = client or FakeRest()
        out, records = io.StringIO(), []
        handler = logging.Handler()
        handler.emit = records.append
        root = logging.getLogger()
        level = root.level
        root.addHandler(handler)
        root.setLevel(logging.DEBUG)  # see every line the harvester logs, info included
        try:
            with redirect_stdout(out):
                code = h.run(dry_run, claude_dir=self.claude, codex_dir=self.codex, data=self.data, tz=ET,
                             now=now, client=client, home=HOME)
        finally:
            root.removeHandler(handler)
            root.setLevel(level)
        return code, out.getvalue(), client, [r.getMessage() for r in records]


class FakeRest(h.Rest):
    """Captures every PostgREST write (rows and the sync_log heartbeat) instead of sending it."""

    def __init__(self):
        super().__init__("https://example.invalid", "not-a-key")
        self.posts = []

    def post(self, table, rows, prefer, on_conflict=None):
        self.posts.append({"table": table, "rows": rows, "on_conflict": on_conflict})


class PrivacyNoContentLeaks(Fixture):
    """The main requirement: nothing from the conversations leaves the parser."""

    def test_rows_hold_no_log_content(self):
        rows, _ = self.rows()
        blob = json.dumps(list(rows.values())).lower()
        self.assertNotIn(MARK, blob)
        for r in rows.values():
            self.assertEqual(set(r), set(h.COLUMNS))
            h.check_row(r)

    def test_upload_and_heartbeat_hold_no_log_content(self):
        code, out, client, logs = self.run_harvest()
        self.assertEqual(code, 0)
        self.assertEqual([p["table"] for p in client.posts], ["ai_tool_usage_daily", "sync_log"])
        for text in (json.dumps(client.posts), out, "\n".join(logs)):
            self.assertNotIn(MARK, text.lower())

    def test_dry_run_prints_counts_only_and_writes_nothing(self):
        code, out, client, logs = self.run_harvest(dry_run=True)
        self.assertEqual(code, 0)
        self.assertEqual(client.posts, [])
        self.assertFalse((self.data / "state.json").exists())
        self.assertNotIn(MARK, (out + "\n".join(logs)).lower())
        for name in ("myproj", "codexproj", "onyx", "claude-opus", "gpt-5"):
            self.assertNotIn(name, out.lower())  # no project or model names either: counts only
        summary = json.loads(out)
        self.assertEqual(summary["claude_code"]["sessions"], 4)
        self.assertEqual(summary["codex"]["sessions"], 2)
        self.assertEqual(summary["claude_code"]["files_automated_left_out"], 1)
        self.assertEqual(summary["codex"]["files_automated_left_out"], 1)

    def test_a_failure_reports_the_error_type_only(self):
        with mock.patch.object(h, "aggregate", side_effect=ValueError("LEAK quoted log line")):
            code, out, client, logs = self.run_harvest()
        self.assertEqual(code, 1)
        beat = client.posts[-1]["rows"][0]
        self.assertEqual((beat["status"], beat["error_message"]), ("failed", "ValueError"))
        self.assertNotIn(MARK, (json.dumps(client.posts) + out + "\n".join(logs)).lower())

    def test_guard_stops_the_upload(self):
        orig = h.build_rows

        def bad(groups, device, synced_at):
            rows = orig(groups, device, synced_at)
            rows[0]["project"] = "C:\\Users\\LEAK_USER\\MyProj"  # a path where the folder name goes
            return rows

        with mock.patch.object(h, "build_rows", side_effect=bad):
            code, out, client, logs = self.run_harvest()
        self.assertEqual(code, 1)
        self.assertEqual([p["table"] for p in client.posts], ["sync_log"])
        self.assertTrue(client.posts[0]["rows"][0]["error_message"].startswith("GUARD privacy:"))
        self.assertNotIn(MARK, (json.dumps(client.posts) + out + "\n".join(logs)).lower())


class CheckRow(unittest.TestCase):
    def good(self):
        g = h.Group(sessions=1, prompts=2, minutes={1, 2}, tokens=[1, 2, 3, 4], models={"claude-opus-5-5"},
                    first=1_763_000_000.0, last=1_763_000_100.0)
        return h.build_rows({(date(2026, 11, 10), h.CLAUDE, "onyx"): g}, "test-pc",
                            "2026-11-13T17:00:00.123456+00:00")[0]

    def test_valid_row_passes(self):
        h.check_row(self.good())

    def test_rejections(self):
        cases = [
            {"prompt_text": "hello"},                                  # an extra column
            {"project": "C:\\Users\\riley\\Onyx"},                     # a path, not a folder name
            {"project": "My Project"},
            {"project": ""},
            {"models": ["please summarise my notes"]},                 # text where a model name goes
            {"models": ["m"] * 11},
            {"tool": "chatgpt"},
            {"prompts": -1},
            {"sessions": True},
            {"input_tokens": "12"},
            {"first_activity": "yesterday"},
            {"synced_at": None},
            {"device": "Riley's PC"},
            {"behavioral_date": "LEAK"},
        ]
        for change in cases:
            with self.subTest(change=change), self.assertRaises(h.PrivacyGuard) as ctx:
                h.check_row({**self.good(), **change})
            # the guard names the rule, never the offending value
            for v in change.values():
                if isinstance(v, str) and len(v) > 3:
                    self.assertNotIn(v, str(ctx.exception))

    def test_missing_column(self):
        row = self.good()
        row.pop("models")
        with self.assertRaises(h.PrivacyGuard):
            h.check_row(row)


class Counting(Fixture):
    def test_claude_session_with_subagent(self):
        rows, _ = self.rows()
        r = rows[("2026-11-10", h.CLAUDE, "myproj")]
        self.assertEqual(
            {k: r[k] for k in h.INT_COLUMNS},
            {"sessions": 1, "subagents": 1, "prompts": 2, "tool_calls": 2,
             "active_minutes": 3, "late_active_minutes": 1, "after_midnight_active_minutes": 1,
             "session_minutes": 630,  # 14:00:00 to 00:30:10, all on behavioral day Nov 10
             "input_tokens": 10 + 3 + 1 + 1000, "output_tokens": 50 + 7 + 2 + 100,
             "cache_read_tokens": 100, "cache_write_tokens": 20})
        self.assertEqual(r["models"], ["claude-haiku-5", "claude-opus-5-5"])
        self.assertEqual((r["first_activity"], r["last_activity"]),
                         ("2026-11-10T19:00:00+00:00", "2026-11-11T05:30:10+00:00"))

    def test_resumed_session_counts_repeated_records_once(self):
        rows, _ = self.rows()
        r = rows[("2026-11-12", h.CLAUDE, "myproj")]
        self.assertEqual((r["sessions"], r["prompts"], r["input_tokens"], r["output_tokens"]), (1, 1, 4, 6))

    def test_projects_sdk_worktree_and_home(self):
        rows, stats = self.rows()
        claude = sorted((d, p) for d, t, p in rows if t == h.CLAUDE)
        self.assertEqual(claude, [("2026-11-10", "home"), ("2026-11-10", "myproj"), ("2026-11-10", "onyx"),
                                  ("2026-11-12", "myproj")])
        self.assertEqual(stats["claude_code.files_automated_left_out"], 1)
        self.assertEqual(stats["claude_code.files_read"], 6)
        r = rows[("2026-11-10", h.CLAUDE, "onyx")]
        self.assertEqual((r["sessions"], r["prompts"], r["input_tokens"], r["output_tokens"]), (1, 1, 2, 3))

    def test_codex_threads(self):
        rows, stats = self.rows()
        self.assertEqual([k for k in rows if k[1] == h.CODEX], [("2026-11-10", h.CODEX, "codexproj")])
        r = rows[("2026-11-10", h.CODEX, "codexproj")]
        self.assertEqual(
            {k: r[k] for k in h.INT_COLUMNS},
            {"sessions": 2, "subagents": 1, "prompts": 2, "tool_calls": 2,
             "active_minutes": 3, "late_active_minutes": 0, "after_midnight_active_minutes": 0,
             "session_minutes": 1,
             # (1000-600) + (500-300) + fork 100 + subagent 50 uncached input
             "input_tokens": 750, "output_tokens": 50 + 30 + 10 + 5,
             "cache_read_tokens": 900, "cache_write_tokens": 0})
        self.assertEqual(r["models"], ["gpt-5.5-codex"])
        self.assertEqual(stats["codex.files_automated_left_out"], 1)

    def test_upload_then_days_are_final(self):
        code, _, client, _ = self.run_harvest()
        self.assertEqual(code, 0)
        upload, beat = client.posts
        self.assertEqual(upload["on_conflict"], h.ON_CONFLICT)
        self.assertEqual(len(upload["rows"]), 5)
        b = beat["rows"][0]
        self.assertEqual((b["source"], b["data_type"], b["status"], b["records_synced"]),
                         ("ai_usage", "sessions", "success", 5))
        self.assertEqual((b["date_range_start"], b["date_range_end"]), ("2026-11-10", "2026-11-12"))
        state = json.loads((self.data / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["final_through"], {"claude_code": "2026-11-12", "codex": "2026-11-12"})
        # the next run sends nothing for final days (and skips files untouched since), but still heartbeats
        code, out, client, _ = self.run_harvest()
        self.assertEqual(code, 0)
        self.assertEqual([p["table"] for p in client.posts], ["sync_log"])
        self.assertEqual(client.posts[0]["rows"][0]["records_synced"], 0)
        self.assertGreater(json.loads(out)["claude_code"]["files_unchanged"], 0)

    def test_old_claude_days_are_never_sent(self):
        later = datetime(2026, 12, 20, 12, tzinfo=ET)
        code, _, client, _ = self.run_harvest(now=later)
        self.assertEqual(code, 0)
        sent = {(r["tool"], r["behavioral_date"]) for r in client.posts[0]["rows"]}
        self.assertEqual(sent, {(h.CODEX, "2026-11-10")})  # Codex keeps its logs; Claude Code deletes old ones


class CodexWriteTimes(unittest.TestCase):
    def test_a_batch_written_file_uses_the_event_times(self):
        written = at(2026, 11, 12, 12)  # the desktop app wrote every line of this turn two days later

        def secs(dt):
            return int(dt.timestamp())

        def ms(dt):
            return int(dt.timestamp() * 1000)

        lines = [
            x("session_meta", written, {"id": "leak", "timestamp": zulu(at(2026, 11, 10, 22, 30)),
                                        "cwd": "/home/LEAK_USER/BatchProj", "originator": "Codex Desktop",
                                        "source": "vscode"}),
            x("event_msg", written, {"type": "task_started", "started_at": secs(at(2026, 11, 10, 22, 30))}),
            x("event_msg", written, {"type": "user_message", "message": "LEAK"}),
            x("event_msg", written, {"type": "item_completed", "started_at_ms": ms(at(2026, 11, 10, 22, 31)),
                                     "completed_at_ms": ms(at(2026, 11, 10, 22, 35)),
                                     "item": {"type": "CommandExecution", "command": "LEAK"}}),
            token_event(written, tokens(100, 0, 10), tokens(100, 0, 10)),
            x("event_msg", written, {"type": "task_complete", "started_at": secs(at(2026, 11, 10, 22, 30)),
                                     "completed_at": secs(at(2026, 11, 10, 22, 40)), "last_agent_message": "LEAK"}),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            write(Path(tmp) / "2026" / "11" / "12" / "rollout-leak.jsonl", lines, written)
            trs, _ = h.collect(Path(tmp) / "none", Path(tmp), {h.CLAUDE: None, h.CODEX: None}, HOME,
                               frozenset(), ET)
            rows = h.build_rows(h.aggregate(trs, ET), "test-pc", "2026-11-13T17:00:00+00:00")
        self.assertEqual([(r["behavioral_date"], r["project"]) for r in rows], [("2026-11-10", "batchproj")])
        r = rows[0]
        self.assertEqual({k: r[k] for k in ("sessions", "prompts", "tool_calls", "active_minutes",
                                            "late_active_minutes", "session_minutes", "input_tokens",
                                            "output_tokens")},
                         {"sessions": 1, "prompts": 1, "tool_calls": 1, "active_minutes": 4,
                          "late_active_minutes": 4, "session_minutes": 10, "input_tokens": 100, "output_tokens": 10})
        self.assertEqual((r["first_activity"], r["last_activity"]),
                         ("2026-11-11T03:30:00+00:00", "2026-11-11T03:40:00+00:00"))

    def test_epoch_any(self):
        t = at(2026, 11, 10, 22, 30).timestamp()
        self.assertEqual(h.epoch_any(int(t)), t)
        self.assertEqual(h.epoch_any(int(t * 1000)), t)
        self.assertEqual(h.epoch_any(zulu(at(2026, 11, 10, 22, 30))), t)
        self.assertIsNone(h.epoch_any(True))
        self.assertIsNone(h.epoch_any(42))
        self.assertIsNone(h.epoch_any("LEAK"))


class Zstd(unittest.TestCase):
    def test_without_zstd_the_file_is_counted_and_the_run_is_partial(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            f = base / "codex" / "2026" / "11" / "10" / "rollout-leak.jsonl.zst"
            f.parent.mkdir(parents=True)
            f.write_bytes(b"\x28\xb5\x2f\xfdLEAK")
            (base / "state").mkdir()
            client = FakeRest()
            with mock.patch.object(h, "_zstd_open", return_value=None), redirect_stdout(io.StringIO()) as out, \
                    mock.patch.dict(os.environ, {"ONYX_PC_DEVICE": "test-pc"}):
                code = h.run(False, claude_dir=base / "none", codex_dir=base / "codex", data=base / "state",
                             tz=ET, now=NOW, client=client, home=HOME)
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(out.getvalue())["codex"]["files_zst_unsupported"], 1)
            beat = client.posts[-1]["rows"][0]
            self.assertEqual(beat["status"], "partial")
            self.assertFalse((base / "state" / "state.json").exists())  # those days stay open

    @unittest.skipUnless(h._zstd_open(), "needs Python 3.14+ (compression.zstd)")
    def test_zst_files_are_read(self):
        from compression import zstd
        with tempfile.TemporaryDirectory() as tmp:
            f = Path(tmp) / "2026" / "11" / "11" / "rollout-leak.jsonl.zst"
            f.parent.mkdir(parents=True)
            lines = [meta(at(2026, 11, 11, 12), cwd="/home/LEAK_USER/ZstProj"),
                     x("event_msg", at(2026, 11, 11, 12, 0, 5), {"type": "user_message", "message": "LEAK"}),
                     token_event(at(2026, 11, 11, 12, 0, 9), tokens(10, 0, 1), tokens(10, 0, 1))]
            with zstd.open(f, "wt", encoding="utf-8") as fh:
                fh.write("\n".join(json.dumps(x_) for x_ in lines) + "\n")
            trs, stats = h.collect(Path(tmp) / "none", Path(tmp), {h.CLAUDE: None, h.CODEX: None}, HOME,
                                   frozenset(), ET)
            rows = h.build_rows(h.aggregate(trs, ET), "test-pc", "2026-11-13T17:00:00+00:00")
            self.assertEqual([(r["project"], r["sessions"], r["prompts"], r["input_tokens"]) for r in rows],
                             [("zstproj", 1, 1, 10)])


class Helpers(unittest.TestCase):
    def test_project_name(self):
        self.assertEqual(h.project_name("C:\\Users\\riley\\Onyx"), "onyx")
        self.assertEqual(h.project_name("c:\\users\\riley\\BC-Extensions\\"), "bc-extensions")
        self.assertEqual(h.project_name("C:\\Users\\riley\\Onyx\\.claude\\worktrees\\agent-a1"), "onyx")
        self.assertEqual(h.project_name("/home/me/code/My Project (old)"), "my_project__old")
        self.assertEqual(h.project_name("C:\\Users\\riley", home="C:\\Users\\riley"), "home")
        self.assertEqual(h.project_name("c:/users/riley/", home="C:\\Users\\riley"), "home")
        self.assertEqual(h.project_name("C:\\Users\\riley\\Secret", excluded=frozenset({"secret"})), "other")
        self.assertEqual(h.project_name("C:\\"), "unknown")
        self.assertEqual(h.project_name(None), "unknown")
        self.assertEqual(h.project_name("x" * 100), "x" * 64)

    def test_behavioral_day_and_late_minutes(self):
        ts = lambda *a: at(*a).timestamp()  # noqa: E731
        self.assertEqual(h.behavioral_day(ts(2026, 11, 11, 5, 59, 59), ET), date(2026, 11, 10))
        self.assertEqual(h.behavioral_day(ts(2026, 11, 11, 6), ET), date(2026, 11, 11))
        tr = h.Transcript(h.CLAUDE, True, "p", activity=[ts(2026, 11, 10, 20, 59), ts(2026, 11, 10, 21),
                                                          ts(2026, 11, 11, 0, 1), ts(2026, 11, 11, 6, 30)])
        groups = h.aggregate([tr], ET)
        g10, g11 = groups[(date(2026, 11, 10), h.CLAUDE, "p")], groups[(date(2026, 11, 11), h.CLAUDE, "p")]
        self.assertEqual((len(g10.minutes), len(g10.late), len(g10.after_midnight), g10.sessions), (3, 2, 1, 1))
        self.assertEqual((len(g11.minutes), len(g11.late), g11.sessions), (1, 0, 0))
        self.assertEqual(g11.session_seconds, 0)  # the span is cut at the day boundary

    def test_last_complete_day_and_window(self):
        self.assertEqual(h.last_complete_day(at(2026, 11, 14, 7, 30)), date(2026, 11, 13))
        self.assertEqual(h.last_complete_day(at(2026, 11, 14, 6, 30)), date(2026, 11, 12))
        today = date(2026, 11, 14)
        self.assertFalse(h.in_window(h.CLAUDE, date(2026, 11, 12), date(2026, 11, 12), today))
        self.assertTrue(h.in_window(h.CLAUDE, date(2026, 11, 13), date(2026, 11, 12), today))
        self.assertFalse(h.in_window(h.CLAUDE, today - timedelta(days=h.CLAUDE_SAFE_DAYS + 1), None, today))
        self.assertTrue(h.in_window(h.CODEX, date(2026, 7, 18), None, today))

    def test_codex_token_delta(self):
        t = lambda i, c, o, w=0: {"input_tokens": i, "cached_input_tokens": c, "output_tokens": o,  # noqa: E731
                                  "cache_write_input_tokens": w}
        prev = (1000, 600, 50, 0)
        self.assertEqual(h.codex_token_delta(None, t(5000, 0, 9), t(100, 40, 10)), (60, 10, 40, 0))  # fork
        self.assertIsNone(h.codex_token_delta(prev, t(1000, 600, 50), t(1000, 600, 50)))           # repeated
        self.assertEqual(h.codex_token_delta(prev, t(1500, 900, 80), t(1, 1, 1)), (200, 30, 300, 0))
        self.assertEqual(h.codex_token_delta(prev, t(10, 0, 1), t(10, 0, 1)), (10, 1, 0, 0))         # reset
        self.assertIsNone(h.codex_token_delta(None, None, None))

    def test_prompts_models_clients(self):
        self.assertTrue(h.is_prompt("hi"))
        self.assertTrue(h.is_prompt([{"type": "text", "text": "x"}]))
        self.assertFalse(h.is_prompt([{"type": "tool_result", "content": "x"}]))
        self.assertFalse(h.is_prompt("   "))
        self.assertEqual(h.clean_model("Claude-Opus-5-5"), "claude-opus-5-5")
        self.assertIsNone(h.clean_model("<synthetic>"))
        self.assertIsNone(h.clean_model("some sentence with spaces"))
        self.assertTrue(h.is_automated(h.CLAUDE, "sdk-cli"))
        self.assertFalse(h.is_automated(h.CLAUDE, "claude-vscode"))
        self.assertTrue(h.is_automated(h.CODEX, "codex_exec"))
        self.assertFalse(h.is_automated(h.CODEX, "Codex Desktop"))

    def test_parse_ts(self):
        self.assertEqual(h.parse_ts("2026-11-10T19:00:00.000Z"), at(2026, 11, 10, 14).timestamp())
        self.assertIsNone(h.parse_ts("LEAK"))
        self.assertIsNone(h.parse_ts(12345))


class Schema(unittest.TestCase):
    SQL = (ROOT / "sql" / "ai_tool_usage_schema.sql").read_text(encoding="utf-8")

    def test_columns_match_the_allow_list(self):
        body = re.search(r"CREATE TABLE IF NOT EXISTS pds\.ai_tool_usage_daily \((.*?)\n\);", self.SQL, re.S).group(1)
        cols = re.findall(r"^\s{4}([a-z_]+)\s+(?:TEXT|DATE|INTEGER|BIGINT|TIMESTAMPTZ)", body, re.M)
        self.assertEqual(set(cols), set(h.COLUMNS))

    def test_no_destructive_statement_and_owner_read(self):
        # The Supabase MCP connector declines a migration whose text contains the word at all.
        self.assertNotIn("drop", self.SQL.lower())
        self.assertIn("owner_read", self.SQL)
        self.assertIn("REVOKE ALL ON pds.ai_tool_usage_daily FROM anon", self.SQL)


if __name__ == "__main__":
    unittest.main()
