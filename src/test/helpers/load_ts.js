// Loads a src/ TypeScript module in memory (typescript.transpileModule), so tests exercise the
// current source without a compile step. Relative imports ("./layout_core") are loaded the same
// way; `stubs` replaces other modules by name (e.g. { vscode: {} }).
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

function loadTsFile(file, stubs, cache) {
    if (cache.has(file)) {
        return cache.get(file).exports;
    }
    const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
    }).outputText;
    const mod = { exports: {} };
    cache.set(file, mod);
    const req = name => {
        if (name in stubs) {
            return stubs[name];
        }
        if (name.startsWith(".")) {
            return loadTsFile(path.resolve(path.dirname(file), name.endsWith(".ts") ? name : `${name}.ts`), stubs, cache);
        }
        return require(name);
    };
    new Function("module", "exports", "require", js)(mod, mod.exports, req);
    return mod.exports;
}

/** `rel` is relative to src/test (e.g. "../locks.ts"). */
function loadTs(rel, stubs = {}) {
    return loadTsFile(path.resolve(__dirname, "..", rel), stubs, new Map());
}

module.exports = { loadTs };
