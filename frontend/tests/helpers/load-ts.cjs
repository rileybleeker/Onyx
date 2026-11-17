// Test helper (not a test: CI only runs tests/*.test.cjs). Transpiles a TypeScript / TSX module
// from src/ on the fly and runs it with optional import stubs, so the real source files are
// exercised offline with no bundler. Specs resolve as "@/x" (src/x), "./x" / "../x" (relative to the file), a
// stub, or a real node module. JSX compiles to the automatic runtime (react/jsx-runtime).
//
// Module identity: like a bundler, one loadTs() call runs each src file ONCE, so a class that two modules of the
// same graph import is one class (an `instanceof AutosaveRefused` check sees the error the component threw).
// `{ cache }` shares those instances with modules a test loaded itself: pass the same Map to both calls, and use
// one Map with one set of stubs only (a module's imports are resolved once, with the stubs of the first load).
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const SRC = path.join(__dirname, "..", "..", "src");

function resolveTs(rel) {
  for (const ext of [".ts", ".tsx"]) if (fs.existsSync(path.join(SRC, rel + ext))) return rel + ext;
  throw new Error(`cannot resolve ${rel}`);
}

function loadTs(relPath, stubs = {}, { cache = new Map() } = {}) {
  const key = path.posix.normalize(String(relPath).split(path.sep).join("/"));
  if (cache.has(key)) return cache.get(key).exports;
  // fileName keeps .ts files out of the JSX parser (a generic arrow `<T>(x: T) =>` is not JSX there).
  const { outputText } = ts.transpileModule(fs.readFileSync(path.join(SRC, key), "utf8"), {
    fileName: path.posix.basename(key),
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
  });
  const mod = { exports: {} };
  // Registered before it runs, as Node does: a circular import gets the exports defined so far.
  cache.set(key, mod);
  const localRequire = (spec) => {
    if (Object.prototype.hasOwnProperty.call(stubs, spec)) return stubs[spec];
    if (spec.startsWith("@/")) return loadTs(resolveTs(spec.slice(2)), stubs, { cache });
    if (spec.startsWith("./") || spec.startsWith("../")) return loadTs(resolveTs(path.posix.join(path.posix.dirname(key), spec)), stubs, { cache });
    return require(spec);
  };
  try {
    new Function("exports", "require", "module", outputText)(mod.exports, localRequire, mod);
  } catch (e) {
    cache.delete(key); // a module that threw while loading is not reused half-built
    throw e;
  }
  return mod.exports;
}

module.exports = { loadTs, SRC };
