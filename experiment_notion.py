"""N-of-1 experiment framework: the Notion mirror of a trial (docs/experiment-framework.md 10).

One page per experiment in the "Onyx Experiments" database under Project Onyx (database
2d460253-f94b-437d-ab74-0920c213d3b7, data source d99f3df8-6759-4de0-b9be-3761759ecd26). The
source of truth is pds.experiment_reports; this is a mirror written by experiment_report.py, and
every write is best-effort: the report job catches NotionError (and anything else from here) and
turns its heartbeat `partial`, the Supabase row is never lost.

Idempotent by construction (doc 10.3):
  * the page is found by the id stored on pds.experiments (notion_page_id), else by its title
    ("EXP-001 ..."); it is created only when neither exists, and two pages for one id are refused;
  * properties are overwritten, never appended;
  * the report body lives under ONE toggle heading, "Report (auto)", whose children are replaced
    on each final-report write. Nothing else on the page is touched, so Riley's own notes survive.

What is written when (doc 10.2): the protocol fields from registration on, the progress counts
while the trial runs (progress_properties() has no way to emit an effect field), and the
estimate, interval, p-value, carryover, decision and report body only from a FINAL report.

Transport: the same Notion REST conventions as the other Onyx Notion code (journal_etl.py,
tools/notion_tasks.py): token NOTION_API_KEY, httpx with retry_helper.retry_http (429
Retry-After and 5xx back-off), the data-source API version of tools/notion_tasks.py. The writer
takes any object with request(method, path, body) -> dict, so the tests drive it with an
in-memory fake. Nothing here prints a token, and errors carry an HTTP status and Notion's error
code only (the Actions logs are public).
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any, Protocol

import experiment_design as design

DATABASE_ID = "2d460253-f94b-437d-ab74-0920c213d3b7"
DATA_SOURCE_ID = "d99f3df8-6759-4de0-b9be-3761759ecd26"
NOTION_API = "https://api.notion.com/v1"
NOTION_VERSION = "2025-09-03"          # the data-source API, as in tools/notion_tasks.py
REPO_URL = "https://github.com/rileybleeker/Onyx"
REPORT_HEADING = "Report (auto)"
MAX_TEXT_UNITS = 2000                  # Notion's limit per text object, in UTF-16 code units
MAX_BLOCKS_PER_CALL = 100

STATUS_NAMES = {
    "draft": "Draft", "registered": "Registered", "running": "Running", "paused": "Paused",
    "stopped_early": "Stopped early", "complete": "Complete",
}
DECISION_NAMES = {
    "adopt_A": "Adopt A", "no_meaningful_effect": "No meaningful effect", "inconclusive": "Inconclusive",
}
# The effect fields. They are written to a page only from a final report (doc 10.2).
EFFECT_PROPERTIES = ("Estimate (ms)", "CI low", "CI high", "p (randomization)", "Carryover b1", "Decision")

log = logging.getLogger("experiment_notion")


class NotionError(RuntimeError):
    """A Notion call failed. The message holds the HTTP status and Notion's error code only."""


class Transport(Protocol):
    def request(self, method: str, path: str, body: dict | None = None) -> dict: ...


def _what(path: str) -> str:
    return path.split("?")[0].split("/")[1] if path.startswith("/") else "request"


class HttpTransport:
    """The real Notion REST client. Notion allows about 3 requests a second; `pause` keeps under it."""

    def __init__(self, token: str, *, pause: float = 0.35, http_transport: Any = None):
        import httpx

        self._pause = pause
        self._client = httpx.Client(
            base_url=NOTION_API, timeout=30, transport=http_transport,
            headers={"Authorization": f"Bearer {token}", "Notion-Version": NOTION_VERSION,
                     "Content-Type": "application/json"})

    def request(self, method: str, path: str, body: dict | None = None) -> dict:
        import httpx

        from retry_helper import retry_http

        try:
            response = retry_http(lambda: self._client.request(method, path, json=body), max_attempts=5, log=log)
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            try:
                code = exc.response.json().get("code")
            except ValueError:
                code = None
            hint = ""
            if status in (403, 404):
                hint = ("; is the Onyx Experiments database (under Project Onyx) shared with the integration "
                        "behind NOTION_API_KEY?")
            raise NotionError(f"Notion {method} {_what(path)} failed (HTTP {status}, {code or 'no code'}){hint}") from None
        except httpx.RequestError as exc:
            raise NotionError(f"Notion {method} {_what(path)} failed ({type(exc).__name__})") from None
        finally:
            if self._pause:
                time.sleep(self._pause)
        return response.json()


def transport_from_env() -> HttpTransport | None:
    """A transport when NOTION_API_KEY is set, else None (the report job then reports the mirror as skipped)."""
    token = os.environ.get("NOTION_API_KEY", "").strip()
    return HttpTransport(token) if token else None


# ---------------------------------------------------------------------------
# Property values (pure)
# ---------------------------------------------------------------------------

def split_text(text: str, limit: int = MAX_TEXT_UNITS) -> list[str]:
    """Consecutive pieces of at most `limit` UTF-16 code units; "".join(pieces) == text. A character
    above U+FFFF counts 2 and is never cut in half (the rule tools/notion_tasks.py documents)."""
    pieces, start, units = [], 0, 0
    for i, ch in enumerate(text):
        width = 2 if ord(ch) > 0xFFFF else 1
        if units + width > limit:
            pieces.append(text[start:i])
            start, units = i, 0
        units += width
    if start < len(text):
        pieces.append(text[start:])
    return pieces


def _rich(text: Any, link: str | None = None) -> list[dict]:
    out = []
    for piece in split_text("" if text is None else str(text)):
        item: dict[str, Any] = {"type": "text", "text": {"content": piece}}
        if link:
            item["text"]["link"] = {"url": link}
        out.append(item)
    return out


def _text(value: Any) -> dict:
    return {"rich_text": _rich(value)}


def _as_number(value: Any) -> float | None:
    """A finite number, else None. jsonb stores an unbounded interval end as the text 'inf' / '-inf'."""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def _number(value: Any, digits: int | None = None) -> dict:
    number = _as_number(value)
    if number is None:
        return {"number": None}
    return {"number": round(number, digits) if digits is not None else number}


def _date(value: Any) -> dict:
    return {"date": {"start": str(value)[:10]} if value else None}


def is_aa(exp: dict[str, Any]) -> bool:
    return design.trial_kind(exp.get("protocol")) == design.KIND_AA


def page_title(exp: dict[str, Any]) -> str:
    return f"{exp['experiment_id']} {exp.get('title') or ''}".strip()


def protocol_url(exp: dict[str, Any]) -> str | None:
    """The protocol file at the commit it was registered from (the repository is public)."""
    if not (exp.get("protocol_path") and exp.get("git_commit")):
        return None
    return f"{REPO_URL}/blob/{exp['git_commit']}/{exp['protocol_path']}"


def protocol_properties(exp: dict[str, Any]) -> dict[str, Any]:
    """The pre-registered facts and the status. Safe at any time: no outcome data."""
    design_text = exp.get("design_type") or ""
    if exp.get("n_blocks") and exp.get("block_len"):
        design_text = f"{design_text}: {exp['n_blocks']} blocks of {exp['block_len']} days ({exp.get('n_days')} days)"
    if is_aa(exp):
        design_text += "; A/A check (both arms the same instruction)"
    return {
        "Experiment": {"title": _rich(page_title(exp))},
        "Status": {"status": {"name": STATUS_NAMES.get(str(exp.get("status")), "Draft")}},
        "Hypothesis": _text(exp.get("question")),
        "Arms": _text(f"A: {exp.get('arm_a_instruction') or ''}\nB: {exp.get('arm_b_instruction') or ''}"),
        "Primary outcome": _text(exp.get("outcome_primary")),
        "MID (ms)": _number(exp.get("mid_ms")),
        "Design": _text(design_text),
        "Start": _date(exp.get("start_date")),
        "Planned end": _date(exp.get("planned_end")),
        "Protocol SHA-256": _text(exp.get("protocol_sha256")),
        "Alignment version": _text(exp.get("alignment_version")),
    }


def progress_properties(progress: dict[str, Any]) -> dict[str, Any]:
    """Counts only. This function has no way to emit an effect field, whatever `progress` holds."""
    return {
        "Days elapsed": _number(progress.get("days_elapsed")),
        "Nights with outcome": _number(progress.get("nights_with_outcome")),
        "Adherence %": _number(progress.get("adherence_pct"), 1),
        "Missing %": _number(progress.get("missing_pct"), 1),
        "Last report": _date(progress.get("as_of")),
    }


def final_properties(report: dict[str, Any]) -> dict[str, Any]:
    """The effect fields. Only a final report (report_kind == 'final') may be passed."""
    if report.get("report_kind") != "final":
        raise ValueError("effect fields are written from a final report only")
    decision = DECISION_NAMES.get(str(report.get("decision")))
    return {
        "Estimate (ms)": _number(report.get("estimate"), 2),
        "CI low": _number(report.get("ci_low"), 2),
        "CI high": _number(report.get("ci_high"), 2),
        "p (randomization)": _number(report.get("p_value"), 4),
        "Carryover b1": _number(report.get("carryover"), 2),
        "Decision": {"select": {"name": decision} if decision else None},
    }


# ---------------------------------------------------------------------------
# Report body (pure)
# ---------------------------------------------------------------------------

def _paragraph(text: str, link: str | None = None) -> dict:
    return {"object": "block", "type": "paragraph", "paragraph": {"rich_text": _rich(text, link)}}


def _bullet(text: str) -> dict:
    return {"object": "block", "type": "bulleted_list_item", "bulleted_list_item": {"rich_text": _rich(text)}}


def _fmt(value: Any, digits: int = 2, unit: str = "") -> str:
    if value in ("inf", "-inf") or (isinstance(value, float) and value in (float("inf"), float("-inf"))):
        return "unbounded"                           # an interval end the test never rejects
    number = _as_number(value)
    if number is None:
        return "n/a"
    return f"{number:.{digits}f}{unit}"


def _count(value: Any) -> str:
    return "n/a" if value is None else str(value)


def aa_lines(report: dict[str, Any]) -> list[str]:
    """The A/A verdict, first on the page of an A/A check (docs/experiment-framework.md 12.2)."""
    check = report.get("aa_check")
    if not check:
        return []
    done = check.get("phase2_done") or {}
    # The p the check used (Fisher's no-effect test since 2026-11-16); older checks carry none.
    p_used = check.get("p_value") if check.get("p_value") is not None else report.get("p_value")
    which = "no-effect randomization p" if check.get("p_source") == "p_value_no_effect" else "p"
    if check.get("passed"):
        return [f"A/A check PASSED: both arms had the same instruction and the registered analysis found no "
                f"difference ({which} = {_fmt(p_used, 4)}, alpha {_fmt(report.get('alpha'))}); "
                f"{_count(check.get('days_revealed'))} of {_count(check.get('days'))} days were revealed on Today and "
                f"{_count(check.get('days_answered'))} have a check-in answer."]
    reasons = []
    if check.get("false_effect") is None:
        reasons.append("the model could not be fitted, so the check has no result")
    elif check.get("false_effect"):
        reasons.append(f"the analysis reported a difference between identical arms ({which} = {_fmt(p_used, 4)} "
                       f"< {_fmt(report.get('alpha'))}). By chance alone this happens about 1 time in 20; review the "
                       "pipeline before registering a real trial")
    if done.get("every_day_revealed") is False:
        reasons.append(f"only {_count(check.get('days_revealed'))} of {_count(check.get('days'))} days were revealed on Today")
    if done.get("answers_on_90pct_of_days") is False:
        reasons.append(f"only {_count(check.get('days_answered'))} of {_count(check.get('days'))} days have a check-in "
                       "answer (the bar is 90%)")
    return ["A/A check NOT PASSED: " + "; ".join(reasons or ["see the report payload"]) + "."]


def inference_lines(report: dict[str, Any]) -> list[str]:
    """Why the decision is (not) firm and what the p-values assume (docs/experiment-framework.md 8.1).
    Empty for a report written before the inference block existed."""
    inference = report.get("inference")
    if not isinstance(inference, dict):
        return []
    lines = []
    if report.get("decision_firm") is False:
        rule = DECISION_NAMES.get(str(report.get("decision_if_supported")), str(report.get("decision_if_supported")))
        reasons = "; ".join(str(x) for x in report.get("decision_withheld") or []) or "see the report payload"
        lines.append(f"No firm decision yet, so it reads Inconclusive: {reasons}. The rule on its own gives: {rule}.")
    # Checks that do not withhold the decision but limit what it can say (e.g. an unbounded carryover).
    for check in inference.get("checks") or []:
        if isinstance(check, dict) and not check.get("blocks_decision") and check.get("status") not in (None, "ok"):
            lines.append(f"Limit: {check.get('reason')}.")
    outputs = inference.get("outputs") if isinstance(inference.get("outputs"), dict) else {}
    unsupported = set(inference.get("unsupported_outputs") or [])
    lines.append(
        f"The p-values and intervals allow for carryover ({inference.get('method')}): they assume the arm acts on the "
        "same night and the next night only, by the same amount every night, that the day before the trial is like "
        "the control arm, and that missing nights are not caused by the arm."
        + (" Some of that is not supported for this trial, so these numbers are not supported either." if
           unsupported & {"p_value", "ci_low / ci_high"} else ""))
    fisher = (outputs.get("p_value_no_effect") or {}).get("supported")
    p_text = _fmt(report.get("p_value_no_effect"), 4)
    if fisher is False or "p_value_no_effect" in unsupported:
        lines.append(f"Fisher's test that the arm changes no night (randomization p = {p_text}) needs only the "
                     "randomized schedule and missing nights not caused by the arm, and the second does not hold "
                     "here, so it is not supported either.")
    else:
        lines.append(f"Without the one-night and equal-effect assumptions, but still with the randomized schedule and "
                     f"missing nights not caused by the arm, 'the arm changes no night' has randomization p = {p_text} "
                     "(it does not say which night).")
    if report.get("carryover_ci_low") is not None:
        lines.append(f"Carryover interval: {_fmt(report.get('carryover_ci_low'))} to "
                     f"{_fmt(report.get('carryover_ci_high'))} ms.")
    return lines


def report_blocks(report: dict[str, Any]) -> list[dict]:
    """The children of the "Report (auto)" heading for a final report."""
    if report.get("report_kind") != "final":
        raise ValueError("the report body is written from a final report only")
    r = report
    kind = "stopped early" if r.get("stopped_early") else "at the pre-registered end"
    blocks = [_paragraph(f"Written by experiment_report.py on {r.get('as_of')} ({kind}). The source of truth is "
                         "pds.experiment_reports; this section is replaced on every final-report write.")]
    blocks += [_bullet(line) for line in aa_lines(r)]
    if r.get("not_analysable"):
        blocks.append(_bullet(f"No estimate: {r['not_analysable']}. The trial is closed with this report; nothing "
                              "else is computed."))
    else:
        decision = DECISION_NAMES.get(str(r.get("decision")), str(r.get("decision")))
        blocks += [
            _bullet(f"Decision: {decision} (rule: adopt A if p < {_fmt(r.get('alpha'))} and the estimate favours A; "
                    f"no meaningful effect if the interval lies inside +/- {_fmt(r.get('mid_ms'), 1, ' ms')}; "
                    "otherwise inconclusive)."),
            _bullet(f"Same-night effect, arm A minus arm B: {_fmt(r.get('estimate'), 2, ' ms')} (interval "
                    f"{_fmt(r.get('ci_low'))} to {_fmt(r.get('ci_high'))} ms, randomization p = {_fmt(r.get('p_value'), 4)}, "
                    f"{_count(r.get('n_redraws'))} re-draws; HAC standard error {_fmt(r.get('hac_se'))} ms as a cross-check)."),
            _bullet(f"Carryover into the next night (b1): {_fmt(r.get('carryover'), 2, ' ms')} (p = "
                    f"{_fmt(r.get('p_carryover'), 4)}); two-night total {_fmt(r.get('two_night_total'), 2, ' ms')}."
                    + (" The carryover is above half the MID: the next trial of this treatment needs the period design."
                       if r.get("carryover_exceeds_half_mid") else "")),
            _bullet(f"Nights analysed: {_count(r.get('n_nights'))} ({_count(r.get('n_nights_a'))} arm A, "
                    f"{_count(r.get('n_nights_b'))} arm B) of {_count(r.get('days_in_scope'))} days in scope; "
                    f"{_count(r.get('days_scheduled'))} days scheduled, last day analysed {_count(r.get('last_day_analysed'))}."),
        ]
        blocks += [_bullet(line) for line in inference_lines(r)]
    excluded = r.get("exclusions") or {}
    if excluded.get("blocks"):
        reasons = "; ".join(f"{b.get('reason')} x{b.get('count')}" for b in excluded.get("by_reason", []))
        blocks.append(_bullet(f"Whole blocks left out, decided without looking at HRV: {len(excluded['blocks'])} ({reasons})."))
    if excluded.get("late_declarations"):
        blocks.append(_bullet(f"{excluded['late_declarations']} declared pause day(s) were NOT honoured because they were "
                              "declared after their block had started."))
    missing = r.get("missingness") or {}
    if missing:
        blocks.append(_bullet(
            f"Missing nights: {_fmt(100 * (_as_number(missing.get('missing_share_a')) or 0), 1, '%')} on arm A, "
            f"{_fmt(100 * (_as_number(missing.get('missing_share_b')) or 0), 1, '%')} on arm B (Fisher p = "
            f"{_fmt(missing.get('fisher_p'), 3)})." + (" More than 10 points apart: a threat to the result."
                                                      if missing.get("threat") else "")))
    adherence = r.get("adherence") or {}
    if adherence:
        blocks.append(_bullet(
            f"Adherence: {_fmt(adherence.get('adherence_pct'), 1, '%')} of the {_count(adherence.get('days_with_evidence'))} "
            f"days with evidence ({_count(adherence.get('days_objective'))} checked by the device, "
            f"{_count(adherence.get('days_self_report_only'))} by check-in answer only, {_count(adherence.get('days_unknown'))} "
            f"with no evidence, {_count(adherence.get('conflicts'))} where the answer and the device disagree)."))

    sens = r.get("sensitivity") or {}
    ln = sens.get("ln_outcome") or {}
    if ln:
        blocks.append(_bullet(f"Sensitivity, ln(HRV): {_fmt(ln.get('estimate_pct'), 1, '%')} (p = {_fmt(ln.get('p_value'), 4)})."))
    pp = sens.get("per_protocol") or {}
    if pp:
        blocks.append(_bullet(f"Sensitivity, per protocol: {_fmt(pp.get('estimate'), 2, ' ms')} on "
                              f"{_count(pp.get('n_nights'))} nights. {r.get('per_protocol_rule') or ''} Not a randomized "
                              "comparison, so no p-value."))
    for name, fit in sens.items():
        if name.startswith("covariate_"):
            blocks.append(_bullet(f"Sensitivity, plus {name[len('covariate_'):]} as a covariate: "
                                  f"{_fmt(fit.get('estimate'), 2, ' ms')} (interval {_fmt(fit.get('ci_low'))} to "
                                  f"{_fmt(fit.get('ci_high'))}, p = {_fmt(fit.get('p_value'), 4)}, "
                                  f"{_count(fit.get('n_nights'))} nights)."))
    for name, fit in (r.get("secondary_outcomes") or {}).items():
        blocks.append(_bullet(f"Secondary outcome {name}: {_fmt(fit.get('estimate'))} (interval {_fmt(fit.get('ci_low'))} "
                              f"to {_fmt(fit.get('ci_high'))}, p = {_fmt(fit.get('p_value'), 4)}, "
                              f"{_count(fit.get('n_nights'))} nights). Not part of the decision rule."))
    for item in r.get("not_run") or []:
        blocks.append(_bullet(f"Registered but not run: {item}"))

    audit = r.get("allocation") or {}
    blocks.append(_paragraph("Allocation audit"))
    blocks.append(_bullet(f"Seed (published now that the trial is over): {_count(audit.get('seed_hex'))}"))
    blocks.append(_bullet(f"Commitment published before the start (sha256 of the seed): {_count(audit.get('seed_sha256'))}"))
    blocks.append(_bullet(f"Generator: {_count(audit.get('generator'))}. The schedule regenerated from this seed matches all "
                          f"{_count(audit.get('days_verified'))} stored days."))
    if r.get("redraw_seed"):
        blocks.append(_bullet(f"Randomization-test seed: {r.get('redraw_seed')}"))
    blocks.append(_bullet(f"Protocol: {_count(r.get('protocol_path'))} (sha256 {_count(r.get('protocol_sha256'))}, "
                          f"commit {_count(r.get('git_commit'))}), alignment rule {_count(r.get('alignment_version'))}."))
    return blocks


# ---------------------------------------------------------------------------
# The writer
# ---------------------------------------------------------------------------

def _plain(rich: list[dict]) -> str:
    return "".join(part.get("plain_text") or (part.get("text") or {}).get("content", "") for part in rich or [])


class ExperimentPages:
    def __init__(self, transport: Transport, data_source_id: str = DATA_SOURCE_ID):
        self.t = transport
        self.data_source_id = data_source_id

    def find_page(self, experiment_id: str) -> str | None:
        """The page whose title is the experiment id (or starts with it and a space), or None.
        Two matches are refused rather than guessed."""
        data = self.t.request("POST", f"/data_sources/{self.data_source_id}/query", {
            "filter": {"property": "Experiment", "title": {"starts_with": experiment_id}}, "page_size": 10})
        hits = []
        for page in data.get("results", []):
            title = _plain(page.get("properties", {}).get("Experiment", {}).get("title", []))
            if title == experiment_id or title.startswith(experiment_id + " "):
                hits.append(page["id"])
        if len(hits) > 1:
            raise NotionError(f"{len(hits)} Notion pages are titled {experiment_id}; refusing to pick one")
        return hits[0] if hits else None

    def upsert_page(self, exp: dict[str, Any], properties: dict[str, Any]) -> tuple[str, bool]:
        """Overwrite the properties of the experiment's page, creating it when there is none.
        Returns (page_id, created). A new page gets one paragraph linking the protocol file."""
        page_id = exp.get("notion_page_id") or self.find_page(exp["experiment_id"])
        if page_id:
            self.t.request("PATCH", f"/pages/{page_id}", {"properties": properties})
            return page_id, False
        body: dict[str, Any] = {"parent": {"type": "data_source_id", "data_source_id": self.data_source_id},
                                "properties": properties}
        url = protocol_url(exp)
        if url:
            body["children"] = [_paragraph(f"Pre-registered protocol: {exp['protocol_path']} at commit "
                                           f"{str(exp['git_commit'])[:12]}", link=url)]
        page = self.t.request("POST", "/pages", body)
        return page["id"], True

    def _children(self, block_id: str) -> list[dict]:
        out, cursor = [], None
        while True:
            query = f"/blocks/{block_id}/children?page_size=100" + (f"&start_cursor={cursor}" if cursor else "")
            data = self.t.request("GET", query)
            out.extend(data.get("results", []))
            if not data.get("has_more"):
                return out
            cursor = data.get("next_cursor")

    def replace_report_body(self, page_id: str, blocks: list[dict]) -> None:
        """Put `blocks` under the "Report (auto)" toggle heading, replacing what was under it.
        Every other block on the page is left alone."""
        heading_id = None
        for block in self._children(page_id):
            if block.get("type") == "heading_2" and _plain(block["heading_2"].get("rich_text", [])).strip() == REPORT_HEADING:
                heading_id = block["id"]
                break
        if heading_id is None:
            created = self.t.request("PATCH", f"/blocks/{page_id}/children", {"children": [{
                "object": "block", "type": "heading_2",
                "heading_2": {"rich_text": _rich(REPORT_HEADING), "is_toggleable": True}}]})
            heading_id = created["results"][0]["id"]
        else:
            for old in self._children(heading_id):
                self.t.request("DELETE", f"/blocks/{old['id']}")
        for i in range(0, len(blocks), MAX_BLOCKS_PER_CALL):
            self.t.request("PATCH", f"/blocks/{heading_id}/children", {"children": blocks[i:i + MAX_BLOCKS_PER_CALL]})

    # -- the two writes the report job makes ---------------------------------------------

    def write_progress(self, exp: dict[str, Any], progress: dict[str, Any] | None = None) -> tuple[str, bool]:
        """Protocol fields, plus the counts when there is a progress report. Never an effect field."""
        properties = protocol_properties(exp)
        if progress:
            properties.update(progress_properties(progress))
        return self.upsert_page(exp, properties)

    def write_final(self, exp: dict[str, Any], report: dict[str, Any]) -> tuple[str, bool]:
        """Everything: protocol fields, final counts, the effect fields and the report body."""
        properties = protocol_properties(exp)
        properties.update(progress_properties(report))
        properties.update(final_properties(report))
        page_id, created = self.upsert_page(exp, properties)
        self.replace_report_body(page_id, report_blocks(report))
        return page_id, created
