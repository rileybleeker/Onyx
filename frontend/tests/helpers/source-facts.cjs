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

const isFunctionLike = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
/** The nearest function around `node` (the component a hook is called in), or the file itself at module scope. */
function enclosingFunction(node) {
  for (let n = node.parent; n; n = n.parent) if (isFunctionLike(n)) return n;
  return node.getSourceFile();
}
/** A readable name for a function from enclosingFunction: its own name, the const it is assigned to, or a fallback. */
function scopeName(scope) {
  if (ts.isSourceFile(scope)) return "module scope";
  if (scope.name && ts.isIdentifier(scope.name)) return scope.name.text;
  if (scope.parent && ts.isVariableDeclaration(scope.parent) && ts.isIdentifier(scope.parent.name)) return scope.parent.name.text;
  return "an anonymous function";
}

/**
 * Every call of one of `hooks` bound to names: { names, scope }. `const autosave = useAutosave(...)` -> names
 * ["autosave"]; `const { saver, undo } = useWeightAutosave(...)` -> ["saver", "undo"]. `scope` is the component the
 * hook is called in (enclosingFunction), so a check about one saver looks at that component only: two components
 * of one file may each name their saver `autosave`.
 */
function saverBindings(node, hooks) {
  const out = [];
  for (const d of collect(node, ts.isVariableDeclaration)) {
    const init = d.initializer;
    if (!init || !ts.isCallExpression(init) || !hooks.includes(refName(init.expression))) continue;
    let names = null;
    if (ts.isIdentifier(d.name)) names = [d.name.text];
    else if (ts.isObjectBindingPattern(d.name)) names = d.name.elements.filter((e) => ts.isIdentifier(e.name)).map((e) => e.name.text);
    if (names) out.push({ names, scope: enclosingFunction(d) });
  }
  return out;
}
/** The names each call of one of `hooks` is bound to, one group per call (saverBindings without the scope). */
const hookBindings = (node, hooks) => saverBindings(node, hooks).map((b) => b.names);

/**
 * What a form that saves itself must show (AGENTS.md "Input saves itself"): a saver from the shared hook, a status
 * line for EVERY saver that shows that saver's own state, in the component holding the saver, and offers Retry (so
 * a failed save is never invisible), and no button still carrying a retired Save label. A status line in another
 * component of the file does not count, even when its saver has the same name. Answers the problems found; [] = fine.
 * The limit of a structural check: it proves the status line and its Retry are wired, not that they are ever shown.
 * A status line behind a condition that is never true, or an onRetry that does nothing, still passes; only a form
 * mounted with tests/helpers/autosave-harness.cjs proves a failure reaches the screen.
 */
function autosaveFormProblems(sf, { hooks, retired = [] }) {
  const problems = [];
  const savers = saverBindings(sf, hooks);
  if (savers.length === 0) problems.push(`no saver from ${hooks.join(" / ")}`);
  const elements = jsxElements(sf);
  for (const s of elements.filter((e) => e.tag === "AutosaveStatus")) {
    if (s.attrs.state?.kind !== "expr" || !/\.state$/.test(s.attrs.state.ref ?? "")) problems.push("an <AutosaveStatus> without state={<saver>.state}");
    if (s.attrs.onRetry?.kind !== "expr") problems.push("an <AutosaveStatus> without onRetry (a failed save could not be retried)");
  }
  for (const { names, scope } of savers) {
    const shown = jsxElements(scope).filter((e) => e.tag === "AutosaveStatus").map((e) => (e.attrs.state?.ref ?? "").replace(/\.state$/, ""));
    if (!names.some((name) => shown.includes(name))) problems.push(`saver "${names.join(", ")}" in ${scopeName(scope)} has no <AutosaveStatus state={…state}>`);
  }
  for (const b of elements.filter(isButton)) for (const label of buttonLabels(b)) if (retired.includes(label)) problems.push(`a ${b.tag} still says "${label}"`);
  return problems;
}

// Inputs that are not typed into: a tap on them saves after a short delay, so leaving them has nothing to send.
const UNTYPED_INPUTS = new Set(["checkbox", "radio", "hidden", "file", "search", "button", "submit", "reset", "range", "color"]);
/** A field Riley types into: a textarea, or an input that is not a checkbox, radio, search box, picker or button. */
const isTypedField = (e) => e.tag === "textarea" || (e.tag === "input" && !(e.attrs.type?.kind === "string" && UNTYPED_INPUTS.has(e.attrs.type.text)));

/**
 * A test for the names that flush one of `names` inside `scope`: `<name>.flush`, or a local helper that calls it
 * (`const flush = () => void autosave.flush();`, `async function done() { await autosave.flush(); }`).
 */
function flushesOf(scope, names) {
  const own = (name) => names.some((n) => name === `${n}.flush`);
  const helpers = new Set();
  for (const d of collect(scope, ts.isVariableDeclaration)) {
    if (ts.isIdentifier(d.name) && d.initializer && calls(d.initializer).some((c) => own(c.name))) helpers.add(d.name.text);
  }
  for (const f of collect(scope, (n) => ts.isFunctionDeclaration(n) && !!n.name && n !== scope)) {
    if (f.body && calls(f.body).some((c) => own(c.name))) helpers.add(f.name.text);
  }
  return (name) => !!name && (own(name) || helpers.has(name));
}

/**
 * Leaving a typed field sends what is waiting (AGENTS.md: "at once on Enter / blur"), checked per saver: in the
 * component holding a saver that has a typed field, some onBlur must flush THAT saver (`onBlur={() => void
 * autosave.flush()}`, `onBlur={flush}`). A saver whose component has only taps (a select, checkboxes) needs none.
 * Answers the problems found; [] = fine.
 */
function blurFlushProblems(sf, { hooks }) {
  const problems = [];
  for (const { names, scope } of saverBindings(sf, hooks)) {
    const elements = jsxElements(scope);
    if (!elements.some(isTypedField)) continue;
    const flushes = flushesOf(scope, names);
    const leaves = elements.some((e) => {
      const a = e.attrs.onBlur;
      if (a?.kind !== "expr" || !a.expr) return false;
      return flushes(a.ref) || calls(a.expr).some((c) => flushes(c.name));
    });
    if (!leaves) problems.push(`saver "${names.join(", ")}" in ${scopeName(scope)}: no typed field sends its change when it is left (onBlur -> flush)`);
  }
  return problems;
}

/** True when `node` decides `top` on its own: every step from it up to `top` is a parenthesis or an `||`. */
function onlyThroughOr(node, top) {
  for (let n = node; n !== top; n = n.parent) {
    const p = n.parent;
    if (!p) return false;
    if (ts.isParenthesizedExpression(p)) continue;
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.BarBarToken) continue;
    return false;
  }
  return true;
}

/** The text a string or template literal shows, substitutions left out (`Your note${x} is not saved` -> "Your note is not saved"); null otherwise. */
function literalText(expr) {
  if (!expr) return null;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isTemplateExpression(expr)) return expr.head.text + expr.templateSpans.map((s) => s.literal.text).join("");
  return null;
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
  enclosingFunction,
  saverBindings,
  hookBindings,
  autosaveFormProblems,
  blurFlushProblems,
  onlyThroughOr,
  literalText,
  imports,
  functionNamed,
  topLevelConst,
  inOrder,
  loadFunction,
};
