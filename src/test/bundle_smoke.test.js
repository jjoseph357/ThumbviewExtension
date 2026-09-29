// Loads the shipped esbuild bundle (dist/extension.js, package.json "main") against a stub vscode
// module, so a bundling mistake (a missing module, a top-level crash, lost exports) fails the
// unit tests instead of shipping. Also rejects code that only works unbundled.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { requireBundle } = require("./helpers/vscode_stub");

console.log("=== Test Suite: Bundle smoke test ===");

const root = path.join(__dirname, "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const bundlePath = path.join(root, pkg.main);
assert(fs.existsSync(bundlePath), `${pkg.main} must exist (run npm run compile)`);

console.log("\n--- Test 1: the bundle loads and exports activate/deactivate ---");
const ext = requireBundle(bundlePath);
assert.strictEqual(typeof ext.activate, "function");
assert.strictEqual(typeof ext.deactivate, "function");
console.log("✓ Test 1 passed");

console.log("\n--- Test 2: the bundle only requires vscode and Node built-ins ---");
const bundle = fs.readFileSync(bundlePath, "utf8");
const required = new Set([...bundle.matchAll(/require\("([^"]+)"\)/g)].map(m => m[1]));
const builtins = new Set(Module.builtinModules);
for (const name of required) {
    assert(name === "vscode" || builtins.has(name.replace(/^node:/, "")), `the bundle requires "${name}", which is not shipped`);
}
console.log("✓ Test 2 passed");

console.log("\nAll bundle smoke tests passed.");
