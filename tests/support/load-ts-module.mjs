import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

// Execute a real TypeScript module with every import stubbed: no dev server, database,
// credentials or network. `globals` extends the sandbox (for example `process`, `fetch`).
export function loadTsModule(fileUrl, dependencies, globals = {}) {
  const source = readFileSync(fileUrl, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const module = { exports: {} };
  const context = createContext({
    module,
    exports: module.exports,
    Date,
    URL,
    URLSearchParams,
    Headers,
    TextEncoder,
    TextDecoder,
    console,
    ...globals,
    require: (name) => {
      assert.ok(name in dependencies, `Unexpected import: ${name}`);
      return dependencies[name];
    },
  });
  runInContext(outputText, context);
  return module.exports;
}
