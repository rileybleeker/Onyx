"""N-of-1 experiment framework: fingerprint of the code a method review and a calibration report cover.

docs/experiment-framework.md 8.3. A firm trial decision needs an independent statistical review of
the inference method and a review-ready calibration report (experiment_analysis.METHOD_REVIEW). Both
are records about one piece of code, so each records the fingerprint of the code it covered, and
experiment_analysis.method_review_problem compares it with the fingerprint of the code that is
running. Any later change to that code withholds every decision until both are recorded again.

What the inference fingerprint covers:
  experiment_analysis.py  every top-level statement, in source order, except the method record and
                          its check (METHOD_REVIEW, method_review_problem) and the explanation of
                          the outputs (ASSUMPTIONS, output_semantics and the assumption lists it
                          uses: text and the per-output "supported" labels, which change no number
                          and no decision)
  experiment_design.py    the allocation and the re-draws (generate_schedule, redraw_blocks,
                          redraw_seed), the nuisance level, the constants the analysis reads, and
                          every top-level name those use, transitively (the imports they rely on
                          included), in source order. Protocol validation is not part of it.
                          Code in other packages (numpy, hashlib) is not fingerprinted; the
                          report's `generator` field records the numpy version.

So it binds every number a report holds and every step of the firm / withheld decision except the
method-review check itself. The check is left out on purpose: a fingerprint cannot protect the code
that compares it (an edit to the check could drop the comparison as easily as change anything
else), so the check is held by its tests (tests/test_experiment_calibration.py) and by review of
every change to it, and METHOD_REVIEW, which holds the recorded values, cannot cover itself.

Docstrings, comments and layout never count (the code is compared as a syntax tree, docstrings
removed), so a reworded docstring keeps the fingerprint and a changed expression does not. Statement
order counts (a later definition replaces an earlier one). The tree is written out by canonical()
below, not ast.dump, so the value is the same on the Python versions in use here (3.12 in Actions,
3.14 on the PC): empty or absent fields are left out and the version-dependent bookkeeping fields
(type_comment, type_params, kind) are ignored.

harness_fingerprint() is the same over experiment_calibration.py as a whole: the calibration report
records it, so the record says which harness produced it.

inference_fingerprint() and harness_fingerprint() read the files once per process (cached), which
suits the short report and register runs. read_inference_fingerprint() and read_harness_fingerprint()
read them again on every call; the calibration harness uses those, taking the values when it is
imported and checking them before and after a run, since a run takes hours.

Standard library only (no numpy), so it can be computed anywhere. Print both values:
    python experiment_fingerprint.py
"""
from __future__ import annotations

import ast
import hashlib
import json
import sys
from functools import lru_cache
from pathlib import Path

FINGERPRINT_VERSION = "ast_sha256_v1"
HERE = Path(__file__).resolve().parent

# experiment_analysis.py: top-level names that are not part of the fingerprint.
ANALYSIS_EXCLUDED = frozenset({
    "METHOD_REVIEW", "method_review_problem",
    "ASSUMPTIONS", "output_semantics", "secondary_assumptions", "_MODEL", "_FISHER", "_LOG_MODEL",
})
# experiment_design.py: where the closure starts, besides every design.<name> the analysis uses.
DESIGN_ROOTS = ("generate_schedule", "redraw_blocks", "redraw_seed", "nuisance_beta_for")
DESIGN_EXCLUDED = frozenset({"validate_protocol"})
_IGNORED_FIELDS = frozenset({"type_comment", "type_params", "kind"})


def canonical(value: object) -> str:
    """A version-stable text form of a syntax tree: node type and its non-empty fields, in order."""
    if isinstance(value, ast.AST):
        parts = []
        for name in value._fields:
            if name in _IGNORED_FIELDS:
                continue
            item = getattr(value, name, None)
            if item is None or (isinstance(item, list) and not item):
                continue
            parts.append(f"{name}={canonical(item)}")
        return f"{type(value).__name__}({','.join(parts)})"
    if isinstance(value, list):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    return repr(value)


def _strip_docstrings(tree: ast.AST) -> ast.AST:
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            body = node.body
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) \
                    and isinstance(body[0].value.value, str):
                node.body = body[1:]
    return tree


def _defined_names(node: ast.stmt) -> list[str]:
    """Names a top-level statement defines or imports (empty for other statements). Imports count, so
    the design closure keeps the import a kept function relies on (method review, doc 8.3)."""
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return [node.name]
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        return [alias.asname or alias.name.split(".")[0] for alias in node.names]
    targets: list[ast.expr] = []
    if isinstance(node, ast.Assign):
        targets = list(node.targets)
    elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
        targets = [node.target]
    names = []
    for target in targets:
        for sub in ast.walk(target):
            if isinstance(sub, ast.Name):
                names.append(sub.id)
    return names


def _used_names(node: ast.AST) -> set[str]:
    return {sub.id for sub in ast.walk(node) if isinstance(sub, ast.Name)}


def _design_attributes(nodes: list[ast.stmt]) -> set[str]:
    """Every design.<name> the given analysis statements read."""
    out = set()
    for node in nodes:
        for sub in ast.walk(node):
            if isinstance(sub, ast.Attribute) and isinstance(sub.value, ast.Name) and sub.value.id == "design":
                out.add(sub.attr)
    return out


def _section(title: str, nodes: list[ast.stmt]) -> str:
    # In source order: a module's top-level order can matter (a later definition replaces an earlier
    # one), so moving a statement changes the fingerprint (method review, doc 8.3).
    return title + "\n" + "\n".join(canonical(n) for n in nodes)


def fingerprint_sources(analysis_source: str, design_source: str) -> str:
    """The inference fingerprint of the two modules' source text. The module docstring of this file
    says which statements it covers; docstrings in those statements never count."""
    analysis = _strip_docstrings(ast.parse(analysis_source)).body
    kept = [n for n in analysis if not (set(_defined_names(n)) & ANALYSIS_EXCLUDED)]

    design_nodes = _strip_docstrings(ast.parse(design_source)).body
    by_name: dict[str, list[ast.stmt]] = {}
    for node in design_nodes:
        for name in _defined_names(node):
            by_name.setdefault(name, []).append(node)
    wanted = (_design_attributes(kept) | set(DESIGN_ROOTS)) - DESIGN_EXCLUDED
    chosen: dict[int, ast.stmt] = {}
    pending = sorted(wanted)
    seen: set[str] = set()
    while pending:
        name = pending.pop()
        if name in seen or name in DESIGN_EXCLUDED:
            continue
        seen.add(name)
        for node in by_name.get(name, []):
            if id(node) not in chosen:
                chosen[id(node)] = node
                pending += sorted((_used_names(node) & set(by_name)) - seen)
    missing = sorted(set(wanted) - set(by_name))
    text = "\n".join([FINGERPRINT_VERSION, _section("experiment_analysis", kept),
                      _section("experiment_design", [n for n in design_nodes if id(n) in chosen]),
                      "missing design names: " + ",".join(missing)])
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def module_fingerprint(source: str) -> str:
    """Fingerprint of a whole module (docstrings, comments and layout ignored)."""
    body = _strip_docstrings(ast.parse(source)).body
    text = FINGERPRINT_VERSION + "\n" + "\n".join(canonical(n) for n in body)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _read(name: str) -> str | None:
    try:
        return (HERE / name).read_text(encoding="utf-8")
    except OSError:
        return None


def read_inference_fingerprint() -> str | None:
    """The inference fingerprint of the files as they are now, read again on every call (no cache),
    or None when a source cannot be read or parsed (a file caught half-written). The calibration
    harness takes it when it is imported and again before and after a run
    (experiment_calibration.loaded_code), so a source edited while a long run is under way can never
    label that run's results."""
    analysis, design = _read("experiment_analysis.py"), _read("experiment_design.py")
    if analysis is None or design is None:
        return None
    try:
        return fingerprint_sources(analysis, design)
    except (SyntaxError, ValueError):
        return None


def read_harness_fingerprint() -> str | None:
    """The harness fingerprint of experiment_calibration.py as it is now (no cache), or None when it
    cannot be read or parsed."""
    source = _read("experiment_calibration.py")
    if source is None:
        return None
    try:
        return module_fingerprint(source)
    except (SyntaxError, ValueError):
        return None


@lru_cache(maxsize=1)
def inference_fingerprint() -> str | None:
    """Fingerprint of the inference code that is running, or None when its source cannot be read
    (then no review can be checked against it and every decision is withheld). Read once per process."""
    return read_inference_fingerprint()


@lru_cache(maxsize=1)
def harness_fingerprint() -> str | None:
    """Fingerprint of the calibration harness (experiment_calibration.py), or None when unreadable.
    Read once per process."""
    return read_harness_fingerprint()


def main() -> int:
    print(json.dumps({"fingerprint_version": FINGERPRINT_VERSION, "inference_fingerprint": inference_fingerprint(),
                      "harness_fingerprint": harness_fingerprint(),
                      "python": ".".join(str(v) for v in sys.version_info[:3])}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
