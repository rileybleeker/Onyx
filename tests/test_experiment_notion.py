"""Experiment framework (N-of-1 trials): the Notion writer for "Onyx Experiments" (experiment_notion.py).

Covers
  * property values: counts only in progress_properties (it cannot carry an effect), effect fields
    only from a final report, unbounded / missing numbers cleared, every text object within
    Notion's 2,000 UTF-16 unit limit without cutting a character in half;
  * idempotency (docs/experiment-framework.md 10.3) against an in-memory Notion: one page per
    experiment, found by the stored id, else by its title; two pages for one id are refused; the
    "Report (auto)" section is replaced, not appended, and Riley's own blocks on the page stay;
  * the report body: the A/A verdict leads an A/A page; a trial that could not be analysed says so
    and prints no "None";
  * the HTTP transport: Notion's headers, a 429 retried, an error carries the status and Notion's
    code only (never the token), and a missing NOTION_API_KEY means no transport.

FakeNotion is also used by tests/test_experiment_report.py for an end-to-end run of the report job.
Synthetic data only. No network, no credentials.

Run: python tests/test_experiment_notion.py
"""
import copy
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import experiment_design as ed  # noqa: E402
import experiment_notion as en  # noqa: E402


def _contents(obj):
    """Every text.content string anywhere in a request body."""
    if isinstance(obj, dict):
        if isinstance(obj.get("content"), str):
            yield obj["content"]
        for value in obj.values():
            yield from _contents(value)
    elif isinstance(obj, list):
        for value in obj:
            yield from _contents(value)


class FakeNotion:
    """The part of the Notion REST API the writer uses, in memory. Records every request."""

    def __init__(self, data_source_id=en.DATA_SOURCE_ID):
        self.ds = data_source_id
        self.pages, self.children, self.log = {}, {}, []
        self._next = 0
        self.fail_on = None                 # (method, path prefix) -> raise NotionError

    def _id(self, prefix):
        self._next += 1
        return f"{prefix}-{self._next:04d}"

    def _block(self, block):
        block = copy.deepcopy(block)
        block["id"] = self._id("block")
        for part in block.get(block["type"], {}).get("rich_text", []):
            part["plain_text"] = part["text"]["content"]
        self.children[block["id"]] = []
        return block

    def request(self, method, path, body=None):
        self.log.append((method, path, copy.deepcopy(body)))
        if self.fail_on and method == self.fail_on[0] and path.startswith(self.fail_on[1]):
            raise en.NotionError(f"Notion {method} {en._what(path)} failed (HTTP 502, no code)")
        for text in _contents(body):
            assert len(text.encode("utf-16-le")) // 2 <= en.MAX_TEXT_UNITS, "a text object over Notion's limit"
        json.dumps(body, allow_nan=False)                           # Notion takes JSON: no NaN, no inf
        if method == "POST" and path == f"/data_sources/{self.ds}/query":
            prefix = body["filter"]["title"]["starts_with"]
            hits = [p for p in self.pages.values() if self._title(p).startswith(prefix)]
            return {"results": [self._public(p) for p in hits], "has_more": False}
        if method == "POST" and path == "/pages":
            assert body["parent"] == {"type": "data_source_id", "data_source_id": self.ds}
            page = {"id": self._id("page"), "properties": copy.deepcopy(body["properties"])}
            self.pages[page["id"]] = page
            self.children[page["id"]] = [self._block(b) for b in body.get("children", [])]
            return {"id": page["id"]}
        if method == "PATCH" and path.startswith("/pages/"):
            page = self.pages[path.split("/")[2]]
            page["properties"].update(copy.deepcopy(body["properties"]))
            return {"id": page["id"]}
        if method == "GET" and path.startswith("/blocks/") and "/children" in path:
            block_id = path.split("/")[2]
            return {"results": copy.deepcopy(self.children[block_id]), "has_more": False}
        if method == "PATCH" and path.startswith("/blocks/") and path.endswith("/children"):
            block_id = path.split("/")[2]
            assert len(body["children"]) <= en.MAX_BLOCKS_PER_CALL
            created = [self._block(b) for b in body["children"]]
            self.children[block_id].extend(created)
            return {"results": copy.deepcopy(created)}
        if method == "DELETE" and path.startswith("/blocks/"):
            block_id = path.split("/")[2]
            for kids in self.children.values():
                kids[:] = [b for b in kids if b["id"] != block_id]
            return {"id": block_id, "archived": True}
        raise AssertionError(f"unexpected Notion call {method} {path}")

    @staticmethod
    def _title(page):
        return "".join(t["text"]["content"] for t in page["properties"]["Experiment"]["title"])

    def _public(self, page):
        out = copy.deepcopy(page)
        for part in out["properties"]["Experiment"]["title"]:
            part["plain_text"] = part["text"]["content"]
        return out

    def text_of(self, block_id):
        out = []
        for block in self.children[block_id]:
            out.append("".join(p["text"]["content"] for p in block[block["type"]].get("rich_text", [])))
        return out


def _exp(**changes):
    exp = {
        "experiment_id": "EXP-901", "title": "A synthetic evening routine", "status": "running",
        "question": "Does the synthetic routine change the synthetic outcome?",
        "arm_a_instruction": "Synthetic instruction for arm A.", "arm_b_instruction": "Synthetic instruction for arm B.",
        "outcome_primary": "synthetic HRV", "alignment_version": "same_night_v1", "mid_ms": 8.0,
        "design_type": ed.DESIGN_DAILY_BLOCKS, "block_len": 4, "n_blocks": 20, "n_days": 80,
        "start_date": "2030-01-07", "planned_end": "2030-03-27", "protocol": {},
        "protocol_path": "docs/experiments/EXP-901.md", "protocol_sha256": "a" * 64, "git_commit": "c0ffee" * 6,
        "notion_page_id": None,
    }
    exp.update(changes)
    return exp


PROGRESS = {"report_kind": "progress", "as_of": "2030-02-06", "days_elapsed": 30, "nights_with_outcome": 26,
            "missing_pct": 13.3, "adherence_pct": 50.0, "adherence": {"days": 30}}


def _final(**changes):
    report = {
        "report_kind": "final", "experiment_id": "EXP-901", "as_of": "2030-03-29", "stopped_early": False,
        "days_elapsed": 80, "nights_with_outcome": 79, "missing_pct": 1.2, "adherence_pct": 88.5,
        "estimate": 24.61234, "ci_low": 20.1, "ci_high": "inf", "p_value": 0.001, "carryover": -0.4,
        "p_carryover": 0.7, "two_night_total": 24.2, "hac_se": 1.9, "n_redraws": 999, "decision": "adopt_A",
        "mid_ms": 8.0, "alpha": 0.05, "n_nights": 67, "n_nights_a": 34, "n_nights_b": 33, "days_in_scope": 68,
        "days_scheduled": 80, "last_day_analysed": "2030-03-27", "carryover_exceeds_half_mid": False,
        "missingness": {"missing_share_a": 0.0, "missing_share_b": 0.025, "fisher_p": 1.0, "threat": False},
        "adherence": {"adherence_pct": 88.5, "days_with_evidence": 40, "days_objective": 40,
                      "days_self_report_only": 0, "days_unknown": 40, "conflicts": 1},
        "exclusions": {"blocks": [3, 5], "by_reason": [{"reason": "flight day", "count": 2}], "late_declarations": 0},
        "sensitivity": {"ln_outcome": {"estimate_pct": 35.0, "p_value": 0.001},
                        "covariate_hrv_lag1": {"estimate": 24.0, "ci_low": 19.0, "ci_high": 29.0, "p_value": 0.001,
                                               "n_nights": 60}},
        "secondary_outcomes": {"whoop_rhr": {"estimate": 0.2, "ci_low": -1.0, "ci_high": 1.4, "p_value": 0.8,
                                             "n_nights": 67}},
        "not_run": [], "allocation": {"seed_hex": "b" * 64, "seed_sha256": "c" * 64, "generator": "PCG64",
                                      "days_verified": 80},
        "redraw_seed": "123", "protocol_path": "docs/experiments/EXP-901.md", "protocol_sha256": "a" * 64,
        "git_commit": "c0ffee", "alignment_version": "same_night_v1",
    }
    report.update(changes)
    return report


# ---------------------------------------------------------------------------
# Property values
# ---------------------------------------------------------------------------

def test_progress_properties_cannot_carry_an_effect():
    leaky = {**PROGRESS, "estimate": 24.0, "p_value": 0.01, "decision": "adopt_A", "ci_low": 1.0}
    props = en.progress_properties(leaky)
    assert set(props) == {"Days elapsed", "Nights with outcome", "Adherence %", "Missing %", "Last report"}
    assert not set(en.EFFECT_PROPERTIES) & set(props)
    assert props["Days elapsed"] == {"number": 30.0} and props["Last report"] == {"date": {"start": "2030-02-06"}}
    assert not set(en.EFFECT_PROPERTIES) & set(en.protocol_properties(_exp())), "the protocol fields carry no outcome"
    for bad in (PROGRESS, {**_final(), "report_kind": "progress"}):
        for fn in (en.final_properties, en.report_blocks):
            try:
                fn(bad)
            except ValueError:
                continue
            raise AssertionError(f"{fn.__name__} accepted a non-final report")


def test_numbers_and_statuses():
    props = en.final_properties(_final())
    assert props["Estimate (ms)"] == {"number": 24.61} and props["p (randomization)"] == {"number": 0.001}
    assert props["CI high"] == {"number": None}, "an unbounded interval end is left empty, never a huge number"
    assert props["Decision"] == {"select": {"name": "Adopt A"}}
    cleared = en.final_properties(_final(estimate=None, ci_low=float("nan"), p_value=True, decision=None))
    assert cleared["Estimate (ms)"] == cleared["CI low"] == cleared["p (randomization)"] == {"number": None}
    assert cleared["Decision"] == {"select": None}
    for status, name in en.STATUS_NAMES.items():
        assert en.protocol_properties(_exp(status=status))["Status"] == {"status": {"name": name}}
    design = en.protocol_properties(_exp())["Design"]["rich_text"][0]["text"]["content"]
    assert design == "daily_4day_permuted_blocks: 20 blocks of 4 days (80 days)"
    aa = en.protocol_properties(_exp(protocol={"kind": "aa"}))["Design"]["rich_text"][0]["text"]["content"]
    assert aa.endswith("A/A check (both arms the same instruction)")


def test_text_is_split_within_notions_limit_without_cutting_a_character():
    text = "x" * 1999 + "\U0001F600" + "y" * 2500                 # the emoji would straddle unit 2000
    pieces = en.split_text(text)
    assert "".join(pieces) == text and len(pieces) == 3
    assert all(len(p.encode("utf-16-le")) // 2 <= en.MAX_TEXT_UNITS for p in pieces)
    assert pieces[0] == "x" * 1999 and pieces[1].startswith("\U0001F600")
    assert en.split_text("") == [] and en._rich(None) == []
    long_arms = en.protocol_properties(_exp(arm_a_instruction="a" * 5000))["Arms"]["rich_text"]
    assert len(long_arms) == 3 and "".join(t["text"]["content"] for t in long_arms).startswith("A: aaa")


# ---------------------------------------------------------------------------
# Idempotency against an in-memory Notion
# ---------------------------------------------------------------------------

def test_one_page_per_experiment_found_by_id_then_by_title():
    api = FakeNotion()
    pages = en.ExperimentPages(api)
    exp = _exp(status="registered")
    page_id, created = pages.write_progress(exp)
    assert created and list(api.pages) == [page_id]
    link = api.children[page_id][0]
    assert link["type"] == "paragraph"
    url = link["paragraph"]["rich_text"][0]["text"]["link"]["url"]
    assert url == f"{en.REPO_URL}/blob/{exp['git_commit']}/docs/experiments/EXP-901.md", "the page links the registered protocol"
    assert api.pages[page_id]["properties"]["Status"] == {"status": {"name": "Registered"}}

    # The id was not stored (say the database write failed): the page is found by its title.
    again, created = pages.write_progress(_exp(), PROGRESS)
    assert again == page_id and not created and len(api.pages) == 1
    # With the id stored there is no lookup at all.
    calls = len(api.log)
    pages.write_progress(_exp(notion_page_id=page_id), PROGRESS)
    assert [m for m, *_ in api.log[calls:]] == ["PATCH"]
    assert api.pages[page_id]["properties"]["Days elapsed"] == {"number": 30.0}

    # Another experiment whose id starts the same way is not a match; two pages for one id are refused.
    other, _ = pages.write_progress(_exp(experiment_id="EXP-9010", title="x"))
    assert other != page_id
    api.pages["page-dupe"] = {**copy.deepcopy(api.pages[page_id]), "id": "page-dupe"}
    try:
        pages.write_progress(_exp())
    except en.NotionError as exc:
        assert "refusing to pick one" in str(exc)
    else:
        raise AssertionError("two pages for one experiment must be refused")


def test_the_report_section_is_replaced_and_nothing_else_is_touched():
    api = FakeNotion()
    pages = en.ExperimentPages(api)
    page_id, _ = pages.write_progress(_exp(), PROGRESS)
    riley = api._block({"object": "block", "type": "paragraph",
                        "paragraph": {"rich_text": [{"type": "text", "text": {"content": "Riley's own note"}}]}})
    api.children[page_id].append(riley)

    exp = _exp(notion_page_id=page_id, status="complete")
    pages.write_final(exp, _final())
    first = api.text_of(page_id)
    headings = [b for b in api.children[page_id] if b["type"] == "heading_2"]
    assert len(headings) == 1 and headings[0]["heading_2"]["is_toggleable"] is True
    body = api.text_of(headings[0]["id"])
    pages.write_final(exp, _final())
    assert api.text_of(page_id) == first, "a re-run adds nothing to the page"
    assert api.text_of(headings[0]["id"]) == body, "the section is replaced, not appended"
    assert "Riley's own note" in api.text_of(page_id)
    props = api.pages[page_id]["properties"]
    assert props["Status"] == {"status": {"name": "Complete"}} and props["Estimate (ms)"] == {"number": 24.61}

    text = "\n".join(body)
    assert "Decision: Adopt A" in text and "24.61 ms" in text and "to unbounded ms" in text
    assert "Seed (published now that the trial is over): " + "b" * 64 in text
    assert "None" not in text
    # A failure half-way is a NotionError for the caller (the report job turns it into `partial`).
    api.fail_on = ("PATCH", f"/blocks/{headings[0]['id']}/children")
    try:
        pages.write_final(exp, _final())
    except en.NotionError as exc:
        assert "HTTP 502" in str(exc)
    else:
        raise AssertionError("a failed write must raise")


def test_aa_verdict_leads_the_report_and_an_unanalysable_trial_prints_no_none():
    passed = {"passed": True, "false_effect": False, "days": 28, "days_revealed": 28, "days_answered": 27,
              "phase2_done": {"no_false_effect": True, "every_day_revealed": True, "answers_on_90pct_of_days": True}}
    blocks = en.report_blocks(_final(p_value=0.41, decision="inconclusive", aa_check=passed))
    first = blocks[1]["bulleted_list_item"]["rich_text"][0]["text"]["content"]
    assert first.startswith("A/A check PASSED") and "p = 0.4100" in first and "27 have a check-in answer" in first

    failed = {**passed, "passed": False, "false_effect": True, "days_answered": 20,
              "phase2_done": {"no_false_effect": False, "every_day_revealed": True, "answers_on_90pct_of_days": False}}
    line = en.aa_lines(_final(p_value=0.012, aa_check=failed))[0]
    assert line.startswith("A/A check NOT PASSED") and "difference between identical arms" in line
    assert "about 1 time in 20" in line and "only 20 of 28 days have a check-in answer" in line
    assert en.aa_lines(_final()) == [], "a treatment trial has no A/A line"

    tiny = {"report_kind": "final", "as_of": "2030-01-14", "stopped_early": True, "decision": None,
            "not_analysable": "only 4 nights with an outcome; too few to fit the model",
            "allocation": {"seed_hex": "b" * 64, "seed_sha256": "c" * 64, "generator": "PCG64", "days_verified": 80},
            "adherence": {}, "exclusions": {"blocks": [], "by_reason": [], "late_declarations": 0}}
    text = " ".join(b[b["type"]]["rich_text"][0]["text"]["content"] for b in en.report_blocks(tiny))
    assert "No estimate: only 4 nights" in text and "stopped early" in text and "None" not in text
    props = en.final_properties(tiny)
    assert props["Estimate (ms)"] == {"number": None} and props["Decision"] == {"select": None}


def test_a_withheld_decision_and_the_inference_assumptions_are_on_the_page():
    def body(report):
        return " ".join(b[b["type"]]["rich_text"][0]["text"]["content"] for b in en.report_blocks(report))

    inference = {"method": "joint_sharp_null_berger_boos_v1", "checks": [], "outputs": {}}
    withheld = _final(decision="inconclusive", decision_if_supported="adopt_A", decision_firm=False,
                      decision_withheld=["the synthetic review is not recorded yet"], inference=inference,
                      p_value_no_effect=0.0004, carryover_ci_low=-3.25, carryover_ci_high="inf")
    text = body(withheld)
    assert "Decision: Inconclusive" in text
    assert "No firm decision yet, so it reads Inconclusive: the synthetic review is not recorded yet." in text
    assert "The rule on its own gives: Adopt A." in text
    assert "allow for carryover (joint_sharp_null_berger_boos_v1)" in text and "p = 0.0004" in text
    assert "Carryover interval: -3.25 to unbounded ms." in text and "None" not in text

    firm = body(_final(decision_if_supported="adopt_A", decision_firm=True, decision_withheld=[], inference=inference))
    assert "No firm decision" not in firm and "allow for carryover" in firm
    # A report stored before the inference block existed renders exactly as it did.
    assert "allow for carryover" not in body(_final()) and en.inference_lines(_final()) == []


# ---------------------------------------------------------------------------
# HTTP transport
# ---------------------------------------------------------------------------

def test_transport_headers_retry_and_errors_never_show_the_token():
    import httpx

    token = "secret_synthetic_token_for_tests_only"
    seen = []

    def handler(request):
        seen.append(request)
        if request.url.path.endswith("/pages") and len(seen) == 1:
            return httpx.Response(429, headers={"Retry-After": "0"}, json={"code": "rate_limited"})
        if request.url.path.startswith("/v1/pages/"):
            return httpx.Response(404, json={"code": "object_not_found", "message": "Could not find page " + token})
        return httpx.Response(200, json={"id": "page-1"})

    t = en.HttpTransport(token, pause=0, http_transport=httpx.MockTransport(handler))
    assert t.request("POST", "/pages", {"properties": {}}) == {"id": "page-1"}, "a 429 is retried"
    assert len(seen) == 2
    assert seen[0].headers["Authorization"] == f"Bearer {token}" and seen[0].headers["Notion-Version"] == en.NOTION_VERSION
    try:
        t.request("PATCH", "/pages/abc", {"properties": {}})
    except en.NotionError as exc:
        message = str(exc)
    else:
        raise AssertionError("a 404 must raise")
    assert message.startswith("Notion PATCH pages failed (HTTP 404, object_not_found)")
    assert "shared with the integration" in message and token not in message and "Could not find" not in message


def test_no_key_no_transport_and_the_secret_name_is_the_shared_one():
    saved = os.environ.pop("NOTION_API_KEY", None)
    try:
        assert en.transport_from_env() is None
        os.environ["NOTION_API_KEY"] = "   "
        assert en.transport_from_env() is None
    finally:
        os.environ.pop("NOTION_API_KEY", None)
        if saved is not None:
            os.environ["NOTION_API_KEY"] = saved
    source = (ROOT / "experiment_notion.py").read_text(encoding="utf-8")
    assert re.findall(r'os\.environ\.get\("([A-Z_]+)"', source) == ["NOTION_API_KEY"]
    assert "print(" not in source, "the writer prints nothing (the Actions logs are public)"
    assert en.DATA_SOURCE_ID == "d99f3df8-6759-4de0-b9be-3761759ecd26", "docs/experiment-framework.md 10.1"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
