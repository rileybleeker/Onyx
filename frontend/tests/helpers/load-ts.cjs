// Test helper (not a test: CI only runs tests/*.test.cjs). Transpiles a TypeScript / TSX module
// from src/ on the fly and runs it with optional import stubs, so the real source files are
// exercised offline with no bundler. Specs resolve as "@/x" (src/x), "./x" (next to the file), a
// stub, or a real node module. JSX compiles to the automatic runtime (react/jsx-runtime).
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const SRC = path.join(__dirname, "..", "..", "src");

function resolveTs(rel) {
  for (const ext of [".ts", ".tsx"]) if (fs.existsSync(path.join(SRC, rel + ext))) return rel + ext;
  throw new Error(`cannot resolve ${rel}`);
}

function loadTs(relPath, stubs = {}) {
  const { outputText } = ts.transpileModule(fs.readFileSync(path.join(SRC, relPath), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
  });
  const mod = { exports: {} };
  const localRequire = (spec) => {
    if (Object.prototype.hasOwnProperty.call(stubs, spec)) return stubs[spec];
    if (spec.startsWith("@/")) return loadTs(resolveTs(spec.slice(2)), stubs);
    if (spec.startsWith("./")) return loadTs(resolveTs(path.posix.join(path.dirname(relPath).split(path.sep).join("/"), spec.slice(2))), stubs);
    return require(spec);
  };
  new Function("exports", "require", "module", outputText)(mod.exports, localRequire, mod);
  return mod.exports;
}

module.exports = { loadTs, SRC };
