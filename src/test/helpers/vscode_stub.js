// Loads the esbuild bundle (dist/extension.js) with a stub `vscode` module. esbuild's interop
// copies a module's own properties, so the stub names every vscode member the source uses; each
// is an inert class-like proxy. `overrides` replaces members (e.g. a working Uri.joinPath).
const fs = require("fs");
const path = require("path");
const Module = require("module");

const root = path.join(__dirname, "../../..");

function vscodeStub(overrides = {}) {
    const used = new Set();
    for (const file of fs.readdirSync(path.join(root, "src")).filter(f => f.endsWith(".ts"))) {
        for (const m of fs.readFileSync(path.join(root, "src", file), "utf8").matchAll(/vscode\.([A-Za-z]+)/g)) {
            used.add(m[1]);
        }
    }
    const anything = () => new Proxy(class {}, { get: (target, key) => (key === "prototype" ? target.prototype : anything()) });
    return { ...Object.fromEntries([...used].map(name => [name, anything()])), ...overrides };
}

function requireBundle(bundlePath, overrides = {}) {
    const stub = vscodeStub(overrides);
    const originalLoad = Module._load;
    Module._load = function (request, ...rest) {
        return request === "vscode" ? stub : originalLoad.call(this, request, ...rest);
    };
    try {
        return require(bundlePath);
    } finally {
        Module._load = originalLoad;
    }
}

module.exports = { requireBundle };
