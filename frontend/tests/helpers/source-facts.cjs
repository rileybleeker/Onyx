// Test helper (not a test). Reads a source file as a TypeScript syntax tree, so a source check states a FACT about
// the code (this hook is called, this element is rendered with these props, nothing is logged, this happens before
// that) and ignores formatting: wrapped JSX, line breaks, quote style, type arguments and comments do not change the
// answer. Use it only where running the code cannot settle the question (a security boundary, every path of a
// module, a migration, a page too large to mount offline); behaviour is tested by running the code
// (tests/helpers/hook-harness.cjs, tests/helpers/autosave-harness.cjs).
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { SRC } = require("./load-ts.cjs");

function parseSource(text, fileName = "inline.tsx") {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
}
/** A file under src/ (or `root`). */
const parseFile = (rel, root = SRC) => parseSource(fs.readFileSync(path.join(root, rel), "utf8"), rel);

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => {
    walk(child, visit);
  });
}
/** Every node under `node` (itself included) for which `pred` holds, in source order. */
function collect(node, pred) {
  const out = [];
  walk(node, (n) => {
    if (pred(n)) out.push(n);
  });
  return out;
}

/**
 * The dotted name of a reference with calls written as `()`: `useAutosave`, `autosave.flush`, `console.error`,
 * `createHash().update`, `supabase.from().insert`. Parentheses, `!`, `await` and `as` are looked through; anything
 * else (an element access, a literal) answers null.
 */
function refName(expr) {
  if (!expr) return null;
  if (ts.isIdentifier(expr)) return expr.text;
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isPropertyAccessExpression(expr)) {
    const left = refName(expr.expression);
    return left === null ? null : `${left}.${expr.name.text}`;
  }
  if (ts.isCallExpression(expr)) {
    const callee = refName(expr.expression);
    return callee === null ? null : `${callee}()`;
  }
  if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr) || ts.isAwaitExpression(expr) || ts.isAsExpression(expr)) {
    return refName(expr.expression);
  }
  return null;
}

/** Every call under `node`: { name: refName(callee) or null, node }. */
const calls = (node) => collect(node, ts.isCallExpression).map((n) => ({ name: refName(n.expression), node: n }));
const hasCall = (node, name) => calls(node).some((c) => c.name === name);

/** The text a JSX child list shows: trimmed JSX text plus string literals in expressions (both branches of `a ? "x" : "y"`). */
function labelsOf(children) {
  const out = [];
  const push = (s) => {
    const t = s.replace(/\s+/g, " ").trim();
    if (t) out.push(t);
  };
  const expr = (e) => {
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) push(e.text);
    else if (ts.isJsxElement(e) || ts.isJsxFragment(e)) e.children.forEach(child);
    else if (!ts.isJsxSelfClosingElement(e)) {
      ts.forEachChild(e, (n) => {
        expr(n);
      });
    }
  };
  const child = (c) => {
    if (ts.isJsxText(c)) push(c.text);
    else if (ts.isJsxExpression(c)) {
      if (c.expression) expr(c.expression);
    } else if (ts.isJsxElement(c) || ts.isJsxFragment(c)) c.children.forEach(child);
  };
  children.forEach(child);
  return out;
}

/**
 * Every JSX element: { tag, attrs, labels, node }. attrs[name] is { kind: "true" } (bare), { kind: "string", text },
 * or { kind: "expr", expr, ref } (ref = refName of the expression). labels = the text the element shows.
 */
function jsxElements(node) {
  return collect(node, (n) => ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)).map((n) => {
    const opening = ts.isJsxElement(n) ? n.openingElement : n;
    const attrs = {};
    for (const p of opening.attributes.properties) {
      if (!ts.isJsxAttribute(p)) continue;
      const name = ts.isIdentifier(p.name) ? p.name.text : p.name.getText();
      const init = p.initializer;
      if (!init) attrs[name] = { kind: "true" };
      else if (ts.isStringLiteral(init)) attrs[name] = { kind: "string", text: init.text };
      else if (ts.isJsxExpression(init)) attrs[name] = { kind: "expr", expr: init.expression, ref: refName(init.expression) };
      else attrs[name] = { kind: "other" };
    }
    return { tag: opening.tagName.getText(), attrs, labels: ts.isJsxElement(n) ? labelsOf(n.children) : [], node: n };
  });
}

/** What a button shows: its text, plus a `label="…"` prop (LogSaveButton's label defaults to "Save"). */
function buttonLabels(el) {
  const own = el.attrs.label?.kind === "string" ? [el.attrs.label.text] : [];
  const fallback = el.tag === "LogSaveButton" && !el.attrs.label ? ["Save"] : [];
  return [...el.labels, ...own, ...fallback];
}
const isButton = (el) => el.tag === "button" || /Button$/.test(el.tag);

/**
 * The names each call of one of `hooks` is bound to, one group per call: `const autosave = useAutosave(...)` ->
 * ["autosave"]; `const { saver, undo } = useWeightAutosave(...)` -> ["saver", "undo"].
 */
function hookBindings(node, hooks) {
  const groups = [];
  for (const d of collect(node, ts.isVariableDeclaration)) {
    const init = d.initializer;
    if (!init || !ts.isCallExpression(init) || !hooks.includes(refName(init.expression))) continue;
    if (ts.isIdentifier(d.name)) groups.push([d.name.text]);
    else if (ts.isObjectBindingPattern(d.name)) groups.push(d.name.elements.filter((e) => ts.isIdentifier(e.name)).map((e) => e.name.text));
  }
  return groups;
}

/**
 * What a form that saves itself must show (AGENTS.md "Input saves itself"): a saver from the shared hook, a status
 * line for EVERY saver it binds that shows that saver's own state and offers Retry (so a failed save is never
 * invisible), and no button still carrying a retired Save label. Answers the problems found; [] = fine.
 */
function autosaveFormProblems(sf, { hooks, retired = [] }) {
  const problems = [];
  const groups = hookBindings(sf, hooks);
  if (groups.length === 0) problems.push(`no saver from ${hooks.join(" / ")}`);
  const elements = jsxElements(sf);
  const statuses = elements.filter((e) => e.tag === "AutosaveStatus");
  for (const s of statuses) {
    if (s.attrs.state?.kind !== "expr" || !/\.state$/.test(s.attrs.state.ref ?? "")) problems.push("an <AutosaveStatus> without state={<saver>.state}");
    if (s.attrs.onRetry?.kind !== "expr") problems.push("an <AutosaveStatus> without onRetry (a failed save could not be retried)");
  }
  const shown = new Set(statuses.map((s) => (s.attrs.state?.ref ?? "").replace(/\.state$/, "")));
  for (const g of groups) if (!g.some((name) => shown.has(name))) problems.push(`saver "${g.join(", ")}" has no <AutosaveStatus state={…state}>`);
  for (const b of elements.filter(isButton)) for (const label of buttonLabels(b)) if (retired.includes(label)) problems.push(`a ${b.tag} still says "${label}"`);
  return problems;
}

/** True when some onBlur handler calls a `flush` (`onBlur={() => void autosave.flush()}`, `onBlur={flush}`). */
function blurFlushes(sf) {
  const isFlush = (name) => /(^|\.)flush$/.test(name ?? "");
  return jsxElements(sf).some((e) => {
    const a = e.attrs.onBlur;
    if (a?.kind !== "expr" || !a.expr) return false;
    return isFlush(a.ref) || calls(a.expr).some((c) => isFlush(c.name));
  });
}

/** Module specifiers this file imports or re-exports from. */
const imports = (sf) => sf.statements.filter((s) => (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier)).map((s) => s.moduleSpecifier.text);

/** A function declared in the file (any depth), by name. */
const functionNamed = (sf, name) => collect(sf, (n) => ts.isFunctionDeclaration(n) && n.name?.text === name)[0] ?? null;

/** The initializer of a top-level `const <name> = …` (module scope, not inside a function), or null. */
function topLevelConst(sf, name) {
  for (const s of sf.statements) {
    if (!ts.isVariableStatement(s)) continue;
    for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return d.initializer ?? null;
  }
  return null;
}

/** True when some block has a statement matching `first` strictly before a statement matching `then`. */
function inOrder(node, first, then) {
  return collect(node, (n) => ts.isBlock(n) || ts.isSourceFile(n)).some((b) => {
    const i = b.statements.findIndex(first);
    const j = b.statements.findIndex(then);
    return i !== -1 && j !== -1 && i < j;
  });
}
/** A statement that assigns `target` (refName) the value `value` (source text), e.g. paying.current = true. */
const assigns = (target, value) => (stmt) =>
  collect(stmt, (n) => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken).some((n) => refName(n.left) === target && n.right.getText() === value);

/** Every string literal value in the file (plain and no-substitution template strings). */
const strings = (node) => collect(node, (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)).map((n) => n.text);

/**
 * A function declared in a src file, compiled and returned so a test can call it (a security rule such as
 * middleware's isCiRoute). The body must use only its parameters and globals.
 */
function loadFunction(rel, name) {
  const fn = functionNamed(parseFile(rel), name);
  if (!fn || !fn.body) throw new Error(`${name} not found in ${rel}`);
  // Rebuilt without `export` so it compiles as a plain script; parameter types are dropped by the transpile.
  const source = `function ${name}(${fn.parameters.map((p) => p.getText()).join(", ")}) ${fn.body.getText()}`;
  const { outputText } = ts.transpileModule(source, { fileName: "extracted.ts", compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  // `exports` is there in case the transpile treats the snippet as a module (it then marks exports.__esModule).
  return new Function("exports", `${outputText}\nreturn ${name};`)({});
}

module.exports = {
  ts,
  parseSource,
  parseFile,
  collect,
  refName,
  calls,
  hasCall,
  jsxElements,
  buttonLabels,
  hookBindings,
  autosaveFormProblems,
  blurFlushes,
  imports,
  functionNamed,
  topLevelConst,
  inOrder,
  assigns,
  strings,
  loadFunction,
};
