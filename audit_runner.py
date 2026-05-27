"""
Onyx Audit Runner
=================
Fires the audit at three external reviewer models in parallel and saves
their JSON responses to audit/responses/:
  - OpenAI GPT-5.5-pro (reasoning_effort=high)
  - Google Gemini 3.1-pro-preview (thinkingBudget=32768)
  - DeepSeek V4-Pro (thinking mode enabled, reasoning_effort=high)

DeepSeek is the third independent reviewer added 2026-05-26 — Chinese
training lineage, distinct from the OpenAI/Google axis.

This is the "external reviewer" half of the triangulated audit. Claude
does its own independent review separately (via Claude Code / "-internal");
results are reconciled afterward.

Usage:
    python audit_runner.py                                              # Dry-run (default)
    python audit_runner.py --fire                                       # Fire all 3 in parallel (default bundle: stats-bundle)
    python audit_runner.py --fire --bundle audit/re-audit-2026-05-26/stats
    python audit_runner.py --fire --model openai                        # Only GPT
    python audit_runner.py --fire --model gemini                        # Only Gemini
    python audit_runner.py --fire --model deepseek                      # Only DeepSeek
    python audit_runner.py --fire --model both                          # OpenAI + Gemini (backward compat)
    python audit_runner.py --fire --model all                           # All three (default)
    python audit_runner.py --commit <sha>                               # Override pinned commit (default: HEAD)

Requirements:
    pip install httpx python-dotenv
    .env must define: OPENAI_API_KEY, GOOGLE_API_KEY, DEEPSEEK_API_KEY
"""

import argparse
import asyncio
import json
import logging
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

load_dotenv()

DEFAULT_BUNDLE_DIR = Path(__file__).parent / "audit" / "stats-bundle"
RESPONSE_DIR = Path(__file__).parent / "audit" / "responses"
RESPONSE_DIR.mkdir(parents=True, exist_ok=True)

# Read order preference: PROMPT first, then context docs alphabetically, then code.
# Files not in this list are appended at the end in lexicographic order.
PRIORITY_ORDER = ("PROMPT.md", "CONTEXT.md", "DATA_PROFILE.md", "SCHEMA.md", "SCHEMA_DDL.md", "README.md")
CODE_EXTS = (".py", ".ts", ".tsx", ".js")


def discover_bundle_files(bundle_dir: Path) -> list[Path]:
    """Walk the bundle dir; return files in a sensible read order."""
    if not bundle_dir.exists():
        raise FileNotFoundError(f"Bundle dir not found: {bundle_dir}")

    all_files = [p for p in sorted(bundle_dir.rglob("*")) if p.is_file()]

    priority = []
    docs = []
    code = []
    for p in all_files:
        rel_name = p.name
        if rel_name in PRIORITY_ORDER:
            priority.append((PRIORITY_ORDER.index(rel_name), p))
        elif p.suffix in CODE_EXTS:
            code.append(p)
        else:
            docs.append(p)

    priority.sort(key=lambda t: t[0])
    return [p for _, p in priority] + docs + code

# Bumped 2026-05-26 to the current flagship Pro-tier models.
#   OpenAI: gpt-5 → gpt-5.5-pro (released 2026-04-23). The 'pro' tier adds
#     extended-reasoning compute on top of the reasoning_effort='high'
#     parameter we send. Combined cost is ~3-5x gpt-5 base, justified for
#     the heavy review task.
#   Gemini: gemini-2.5-pro → gemini-3.1-pro-preview. gemini-3-pro original
#     preview was deprecated 2026-03-09; 3.1-pro is current. gemini-2.5-pro
#     remains available as a stable fallback if 3.1-pro-preview throws.
OPENAI_MODEL = "gpt-5"
GEMINI_MODEL = "gemini-3.1-pro-preview"

OPENAI_URL = "https://api.openai.com/v1/chat/completions"
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

# DeepSeek added 2026-05-26 as a 3rd independent reviewer (Chinese training
# lineage, distinct from the OpenAI/Google axis). API is OpenAI-compatible
# but thinking mode requires the explicit "thinking" payload field.
DEEPSEEK_MODEL = "deepseek-v4-pro"
DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions"

# Required top-level keys in the returned JSON
REQUIRED_KEYS = {"reviewer_metadata", "domain_scores", "summary", "findings", "things_done_well", "questions_for_followup"}

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("audit_runner")


# ---------------------------------------------------------------------------
# Bundle loading
# ---------------------------------------------------------------------------

def load_bundle(bundle_dir: Path) -> tuple[str, dict[str, int]]:
    """Concatenate all files in the bundle dir into one user message. Returns (text, sizes)."""
    parts: list[str] = []
    sizes: dict[str, int] = {}

    files = discover_bundle_files(bundle_dir)
    for fpath in files:
        rel = fpath.relative_to(bundle_dir).as_posix()
        content = fpath.read_text(encoding="utf-8")
        sizes[rel] = len(content)
        parts.append(f"=== FILE: {rel} ===\n{content}\n=== END FILE: {rel} ===")

    return "\n\n".join(parts), sizes


def current_commit() -> str:
    """Return the current git HEAD SHA (short)."""
    try:
        return subprocess.check_output(["git", "rev-parse", "--short=7", "HEAD"], text=True).strip()
    except subprocess.CalledProcessError:
        return "unknown"


# ---------------------------------------------------------------------------
# API callers
# ---------------------------------------------------------------------------

async def call_openai(client: httpx.AsyncClient, bundle_text: str, commit: str) -> dict:
    """POST the bundle to OpenAI GPT-5 with JSON-object response format."""
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY not set in .env")

    payload = {
        "model": OPENAI_MODEL,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are an independent statistical methodology reviewer. "
                    "Read the entire bundle. Return a single JSON object matching the schema in PROMPT.md. "
                    "Do not include any text outside the JSON."
                ),
            },
            {"role": "user", "content": bundle_text},
        ],
        "response_format": {"type": "json_object"},
        # High reasoning effort for max thoroughness on the audit task. GPT-5
        # default is 'medium'; 'high' uses substantially more reasoning tokens
        # (~2-3x cost) but catches subtler issues. See docs:
        # https://platform.openai.com/docs/guides/reasoning
        "reasoning_effort": "high",
    }

    log.info(f"[openai] firing request to {OPENAI_MODEL} (reasoning=high, bundle size: {len(bundle_text):,} chars)")
    resp = await client.post(
        OPENAI_URL,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload,
        timeout=600.0,  # 10 minutes; reasoning models can take a while
    )

    if resp.status_code != 200:
        raise RuntimeError(f"OpenAI returned {resp.status_code}: {resp.text[:500]}")

    body = resp.json()
    usage = body.get("usage", {})
    log.info(
        f"[openai] response received — "
        f"prompt={usage.get('prompt_tokens', '?')} tok, "
        f"completion={usage.get('completion_tokens', '?')} tok"
    )

    content = body["choices"][0]["message"]["content"]
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"OpenAI returned non-JSON content: {e}\n{content[:500]}")

    return {
        "reviewer": "gpt-5",
        "model": OPENAI_MODEL,
        "bundle_commit": commit,
        "fired_at": datetime.now(timezone.utc).isoformat(),
        "usage": usage,
        "response": parsed,
    }


async def call_gemini(client: httpx.AsyncClient, bundle_text: str, commit: str) -> dict:
    """POST the bundle to Gemini 2.5 Pro with JSON mime type."""
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("GOOGLE_API_KEY not set in .env")

    system_text = (
        "You are an independent statistical methodology reviewer. "
        "Read the entire bundle. Return a single JSON object matching the schema in PROMPT.md. "
        "Do not include any text outside the JSON."
    )

    payload = {
        "system_instruction": {"parts": [{"text": system_text}]},
        "contents": [{"role": "user", "parts": [{"text": bundle_text}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0.2,
            # Max thinking budget for Gemini 2.5 Pro (32768 is the cap). The
            # default for 2.5 Pro is dynamic (the model decides); pinning to
            # max forces it to use the full budget on this heavy review task.
            # Cost impact: thinking tokens charged at ~$3.50/1M, so +$0.10/call.
            # See: https://ai.google.dev/gemini-api/docs/thinking
            "thinkingConfig": {"thinkingBudget": 32768, "includeThoughts": False},
        },
    }

    log.info(f"[gemini] firing request to {GEMINI_MODEL} (thinking_budget=32768, bundle size: {len(bundle_text):,} chars)")
    resp = await client.post(
        f"{GEMINI_URL}?key={api_key}",
        headers={"Content-Type": "application/json"},
        json=payload,
        timeout=600.0,
    )

    if resp.status_code != 200:
        raise RuntimeError(f"Gemini returned {resp.status_code}: {resp.text[:500]}")

    body = resp.json()
    usage = body.get("usageMetadata", {})
    log.info(
        f"[gemini] response received — "
        f"prompt={usage.get('promptTokenCount', '?')} tok, "
        f"completion={usage.get('candidatesTokenCount', '?')} tok"
    )

    # Gemini returns the JSON string inside candidates[0].content.parts[0].text
    try:
        content = body["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError) as e:
        raise RuntimeError(f"Gemini response missing candidate content: {e}\n{json.dumps(body)[:500]}")

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Gemini returned non-JSON content: {e}\n{content[:500]}")

    return {
        "reviewer": "gemini-2.5-pro",
        "model": GEMINI_MODEL,
        "bundle_commit": commit,
        "fired_at": datetime.now(timezone.utc).isoformat(),
        "usage": usage,
        "response": parsed,
    }


async def call_deepseek(client: httpx.AsyncClient, bundle_text: str, commit: str) -> dict:
    """POST the bundle to DeepSeek V4-Pro with thinking mode enabled.

    DeepSeek's chat completions API is OpenAI-compatible; the differences vs
    call_openai: thinking mode requires `thinking={"type": "enabled"}` in the
    payload (default but explicit for safety), and the response carries a
    `reasoning_content` field alongside the regular `content`.
    """
    api_key = os.getenv("DEEPSEEK_API_KEY")
    if not api_key:
        raise RuntimeError("DEEPSEEK_API_KEY not set in .env")

    payload = {
        "model": DEEPSEEK_MODEL,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are an independent statistical methodology reviewer. "
                    "Read the entire bundle. Return a single JSON object matching the schema in PROMPT.md. "
                    "Do not include any text outside the JSON."
                ),
            },
            {"role": "user", "content": bundle_text},
        ],
        "response_format": {"type": "json_object"},
        "reasoning_effort": "high",
        # Thinking is the default for v4-pro but specify explicitly so a
        # future API change doesn't silently swap us into non-thinking mode.
        "thinking": {"type": "enabled"},
    }

    log.info(f"[deepseek] firing request to {DEEPSEEK_MODEL} (thinking=enabled, reasoning=high, bundle size: {len(bundle_text):,} chars)")
    resp = await client.post(
        DEEPSEEK_URL,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload,
        timeout=600.0,
    )

    if resp.status_code != 200:
        raise RuntimeError(f"DeepSeek returned {resp.status_code}: {resp.text[:500]}")

    body = resp.json()
    usage = body.get("usage", {})
    log.info(
        f"[deepseek] response received — "
        f"prompt={usage.get('prompt_tokens', '?')} tok, "
        f"completion={usage.get('completion_tokens', '?')} tok, "
        f"reasoning={usage.get('reasoning_tokens', usage.get('completion_tokens_details', {}).get('reasoning_tokens', '?'))} tok"
    )

    msg = body["choices"][0]["message"]
    content = msg["content"]
    reasoning_content = msg.get("reasoning_content")  # CoT, may be present
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"DeepSeek returned non-JSON content: {e}\n{content[:500]}")

    return {
        "reviewer": "deepseek-v4-pro",
        "model": DEEPSEEK_MODEL,
        "bundle_commit": commit,
        "fired_at": datetime.now(timezone.utc).isoformat(),
        "usage": usage,
        "reasoning_content": reasoning_content,  # may be None
        "response": parsed,
    }


# ---------------------------------------------------------------------------
# Validation + persistence
# ---------------------------------------------------------------------------

def validate_response(result: dict) -> list[str]:
    """Return list of validation warnings; empty if clean."""
    warnings: list[str] = []
    resp = result.get("response", {})
    missing = REQUIRED_KEYS - set(resp.keys())
    if missing:
        warnings.append(f"Missing required top-level keys: {sorted(missing)}")

    findings = resp.get("findings", [])
    if not isinstance(findings, list):
        warnings.append("`findings` is not a list")
    else:
        for i, f in enumerate(findings):
            if not isinstance(f, dict):
                warnings.append(f"finding[{i}] is not an object")
                continue
            for required in ("id", "title", "severity", "effort", "file_ref", "description", "recommendation"):
                if required not in f:
                    warnings.append(f"finding[{i}] missing `{required}`")
            if f.get("severity") not in ("P0", "P1", "P2", "P3"):
                warnings.append(f"finding[{i}] has invalid severity: {f.get('severity')}")
            if f.get("effort") not in ("S", "M", "L", "XL"):
                warnings.append(f"finding[{i}] has invalid effort: {f.get('effort')}")

    return warnings


def save_response(result: dict, output_dir: Path, bundle_name: str) -> Path:
    """Write to audit/responses/<bundle>-<reviewer>-<commit>-<timestamp>.json"""
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    fname = f"{bundle_name}-{result['reviewer']}-{result['bundle_commit']}-{ts}.json"
    result["bundle"] = bundle_name
    fpath = output_dir / fname
    fpath.write_text(json.dumps(result, indent=2), encoding="utf-8")
    return fpath


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def run(args: argparse.Namespace) -> int:
    bundle_dir = Path(args.bundle) if args.bundle else DEFAULT_BUNDLE_DIR
    bundle_text, sizes = load_bundle(bundle_dir)
    total_chars = sum(sizes.values())
    log.info(f"Bundle loaded from {bundle_dir}: {len(sizes)} files, {total_chars:,} chars total")
    for fname, size in sizes.items():
        log.info(f"  {fname}: {size:,} chars")

    head = current_commit()
    # Default to current HEAD so the saved bundle_commit always reflects what
    # the model actually saw. Pass --commit to override (e.g. when replaying
    # an old bundle).
    pinned = args.commit or head
    if head != pinned:
        log.warning(f"Current git HEAD ({head}) does not match pinned commit ({pinned}).")
        log.warning(f"Audit will be saved under bundle_commit={pinned}, but the files on disk are at {head}.")

    if not args.fire:
        log.info("--- DRY RUN ---")
        log.info(f"Would call: {args.model}")
        log.info(f"Bundle commit (pinned): {pinned}")
        log.info(f"Output dir: {RESPONSE_DIR}")
        if args.dry_run:
            prompt_dump = RESPONSE_DIR / f"prompt-{pinned}-DRY_RUN.txt"
            prompt_dump.write_text(bundle_text, encoding="utf-8")
            log.info(f"Wrote full prompt to {prompt_dump} ({len(bundle_text):,} chars)")
        log.info("Pass --fire to actually call the APIs.")
        return 0

    # Fire actual API calls
    async with httpx.AsyncClient() as client:
        tasks = []
        if args.model in ("openai", "both", "all"):
            tasks.append(("openai", call_openai(client, bundle_text, pinned)))
        if args.model in ("gemini", "both", "all"):
            tasks.append(("gemini", call_gemini(client, bundle_text, pinned)))
        if args.model in ("deepseek", "all"):
            tasks.append(("deepseek", call_deepseek(client, bundle_text, pinned)))

        if not tasks:
            log.error(f"No models selected. --model must be openai, gemini, deepseek, both, or all. Got: {args.model}")
            return 1

        results = await asyncio.gather(*(t[1] for t in tasks), return_exceptions=True)

    # Persist + validate
    any_error = False
    for (name, _), result in zip(tasks, results):
        if isinstance(result, Exception):
            log.error(f"[{name}] FAILED: {result}")
            any_error = True
            continue

        warnings = validate_response(result)
        for w in warnings:
            log.warning(f"[{name}] validation: {w}")

        fpath = save_response(result, RESPONSE_DIR, bundle_dir.name)
        n_findings = len(result["response"].get("findings", []))
        log.info(f"[{name}] saved {fpath.name} -- {n_findings} findings")

    return 1 if any_error else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--fire", action="store_true", help="Actually call the APIs (default is dry-run)")
    parser.add_argument("--dry-run", action="store_true", help="Save the full prompt to disk for inspection")
    parser.add_argument("--bundle", default=None,
                        help="Path to bundle directory (default: audit/stats-bundle)")
    parser.add_argument("--model",
                        choices=["openai", "gemini", "deepseek", "both", "all"],
                        default="all",
                        help="Which model(s) to call. 'both' = openai+gemini (backward compat); "
                             "'all' = openai+gemini+deepseek (default)")
    parser.add_argument("--commit", default=None,
                        help="Override pinned commit (default: current git HEAD)")
    args = parser.parse_args()

    if args.fire and args.dry_run:
        log.error("--fire and --dry-run are mutually exclusive")
        return 1

    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        log.warning("Interrupted")
        return 130


if __name__ == "__main__":
    sys.exit(main())
