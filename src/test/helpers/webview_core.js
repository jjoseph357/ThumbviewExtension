// Evaluates the generated src/layout_core.ts block of media/overview.js in a vm sandbox, so
// tests that exercise webview functions in isolation get the same shared layout helpers the
// webview uses. Stubs the sandbox already defines (e.g. `cellsNeeded: () => 1`) are kept.
const vm = require("vm");

const BEGIN = "// ---- BEGIN GENERATED from src/layout_core.ts";
const END = "// ---- END GENERATED from src/layout_core.ts ----";

function webviewCoreSource(overviewJs) {
    const start = overviewJs.indexOf(BEGIN);
    const end = overviewJs.indexOf(END);
    if (start === -1 || end === -1) {
        throw new Error("media/overview.js is missing the generated layout_core block");
    }
    return overviewJs.slice(start, end);
}

function runWebviewCore(overviewJs, sandbox) {
    const stubs = { ...sandbox };
    vm.runInContext(webviewCoreSource(overviewJs), sandbox);
    for (const [name, value] of Object.entries(stubs)) {
        sandbox[name] = value;
    }
}

module.exports = { webviewCoreSource, runWebviewCore };
