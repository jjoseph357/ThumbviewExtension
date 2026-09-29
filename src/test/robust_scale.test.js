// Behavioral tests for Phase 3: delta payloads (unchanged files omit lines and reuse the webview's
// copy; missing copies are re-requested), and file discovery helpers (files.exclude globs, binary
// detection, always-excluded folders) from src/file_discovery.ts, transpiled in memory.
const assert = require("assert");
const { loadOverview } = require("./helpers/overview_harness");
const { loadTs } = require("./helpers/load_ts");


console.log("=== Test Suite: Robustness & scale (Phase 3) ===");

console.log("\n--- Test 1: files.exclude globs ---");
const { globToRegExp, looksBinary, isAlwaysExcluded } = loadTs("../file_discovery.ts", { vscode: {} });
const cases = [
    ["**/*.pyc", "src/a/b.pyc", true],
    ["**/*.pyc", "src/a/b.py", false],
    ["*.log", "deep/dir/run.log", true],
    ["**/.DS_Store", ".DS_Store", true],
    ["build", "build/out.js", true],
    ["build", "src/build.ts", false],
    ["docs/**", "docs/a/b.md", true],
    ["docs/**", "src/docs/a.md", false],
    ["**/{dist,coverage}", "pkg/dist/index.js", true],
    ["src/?.ts", "src/a.ts", true],
    ["src/?.ts", "src/ab.ts", false],
    ["**/*.[oa]", "build/x.o", true],
    ["**/*.[oa]", "build/x.c", false],
    ["**/[!._]*.tmp", "a/b.tmp", true],
    ["**/[!._]*.tmp", "a/.b.tmp", false]
];
for (const [glob, rel, expected] of cases) {
    assert.strictEqual(globToRegExp(glob).test(rel), expected, `${glob} vs ${rel}`);
}
console.log("✓ Test 1 passed");

console.log("\n--- Test 2: binary detection and always-excluded folders ---");
assert.strictEqual(looksBinary("const a = 1;\nexport {}"), false);
assert.strictEqual(looksBinary("PK\u0003\u0004\u0000\u0000binary"), true);
assert.strictEqual(isAlwaysExcluded("node_modules/react/index.js"), true);
assert.strictEqual(isAlwaysExcluded("pkg/.git/config"), true);
assert.strictEqual(isAlwaysExcluded("lib/parser.ts"), false, "lib/ is real source and must be shown");
assert.strictEqual(isAlwaysExcluded("out/extension.js"), false, "out/ is decided by .gitignore, not a blocklist");
console.log("✓ Test 2 passed");

console.log("\n--- Test 3: delta payloads reuse lines the webview already has ---");
const h = loadOverview(["lowerLineText", "lineShape"]);
const { onMessage, flushFrames, postedMessages } = h;
const { getData } = h.exports;
h.resizeTo(1600, 900);
flushFrames();
function payload(files) {
    return { command: "data", mode: "uniform_grid", files, layout: { cols: 3, rows: 2 } };
}
const full = [0, 1, 2].map(i => ({
    id: `f${i}.ts`, path: `f${i}.ts`, uri: `file:///ws/f${i}.ts`, lineCount: 2, contentVersion: 1,
    lines: [{ text: `const f${i} = ${i};` }, { text: "export {};" }], slot: [i, 0]
}));
onMessage({ data: payload(full) });
flushFrames();
const firstLines = getData().files[1].lines;
const delta = full.map(f => ({ ...f, lines: [], linesOmitted: true }));
delta[2] = { ...full[2], contentVersion: 2, lines: [{ text: "const f2 = 42;" }] }; // only f2 changed
onMessage({ data: payload(delta) });
flushFrames();
assert.strictEqual(getData().files[1].lines, firstLines, "unchanged files reuse the previous line objects (and their token caches)");
assert(getData().files[1]._combinedText.includes("const f1"), "search index still covers unchanged files");
assert(getData().files[2]._combinedText.includes("42"), "changed files use the new lines");
assert(!postedMessages.some(m => m.command === "requestFileLines"), "nothing is missing");
console.log("✓ Test 3 passed");

console.log("\n--- Test 3b: lines sent as plain strings (the host's wire format) ---");
onMessage({ data: payload([0, 1, 2].map(i => ({
    id: `s${i}.ts`, path: `S${i}.ts`, uri: `file:///ws/s${i}.ts`, lineCount: 2, contentVersion: 1,
    lines: [`const Alpha${i} = ${i};`, "export {};"], slot: [i, 0]
}))) });
flushFrames();
const s1 = getData().files.find(f => f.id === "s1.ts");
assert.strictEqual(s1.lines[0].text, "const Alpha1 = 1;", "string lines become line objects that can carry render caches");
assert(s1._combinedText === "s1.ts\nconst alpha1 = 1;\nexport {};", `lowercased index covers the path and every line (${JSON.stringify(s1._combinedText)})`);
assert(s1._combinedTextOriginal === "const Alpha1 = 1;\nexport {};", "original-case index keeps case for Match Case");
assert.strictEqual(s1.lines[0]._lowerText, undefined, "per-line lowercase copies are not built up front");
assert.strictEqual(h.exports.lowerLineText(s1.lines[0]), "const alpha1 = 1;");
assert.strictEqual(s1.lines[0]._lowerText, "const alpha1 = 1;", "and are kept once computed");
console.log("✓ Test 3b passed");

console.log("\n--- Test 3c: folder previews and tiles keep code shape from text-only lines ---");
const { lineShape } = h.exports;
const shaped = lineShape({ text: "        return compute(x);   " });
assert.strictEqual(shaped.indent, 8, "indent is derived from the text");
assert.strictEqual(shaped.length, 26, "length excludes trailing whitespace");
assert.strictEqual(shaped.category, "control-flow", "category uses the shared categorizeLine");
assert.strictEqual(lineShape({ text: "// note" }).category, "comment");
assert.strictEqual(lineShape({ text: "import x from 'y';" }).category, "import");
// Enough files that the root collapses into folder cards, whose previews draw one bar per line.
const shapedSource = i => [
    `import { dep${i} } from "./dep";`,
    "",
    `export function run${i}(input) {`,
    "    if (input) {",
    `        return input.value${i} + ${i};`,
    "    }",
    "    // fallback",
    "    return null;",
    "}"
];
const cardFiles = [];
const cardCols = 40;
for (let i = 0; i < 1200; i++) {
    cardFiles.push({
        id: `p${i % 3}/f${i}.ts`, path: `pkg${i % 3}/f${i}.ts`, uri: `file:///ws/pkg${i % 3}/f${i}.ts`,
        lineCount: 9, contentVersion: 1, lines: shapedSource(i), slot: [i % cardCols, Math.floor(i / cardCols)]
    });
}
const bars = [];
const realFillRect = h.mockCtx.fillRect;
h.mockCtx.fillRect = (x, y, w, hgt) => { if (hgt === 1) bars.push({ x, w, style: h.mockCtx.fillStyle }); };
onMessage({ data: { command: "data", mode: "uniform_grid", files: cardFiles, layout: { cols: cardCols, rows: 30 } } });
flushFrames();
h.mockCtx.fillRect = realFillRect;
assert(bars.length > 50, `folder card previews drew line bars (${bars.length})`);
const widths = new Set(bars.map(b => Math.round(b.w)));
const starts = new Set(bars.map(b => Math.round(b.x * 10) % 1000));
const styles = new Set(bars.map(b => b.style));
assert(widths.size > 3, `bar widths follow line lengths, not one uniform width (${[...widths].join(",")})`);
assert(styles.size > 2, `bar colors follow line categories (${[...styles].join(" | ")})`);
assert(starts.size > 1, "bars are indented");
console.log("✓ Test 3c passed");

console.log("\n--- Test 4: a missing copy is re-requested from the host ---");
const stale = full.map(f => ({ ...f, contentVersion: 5, lines: [], linesOmitted: true }));
onMessage({ data: payload(stale) });
flushFrames();
const request = postedMessages.find(m => m.command === "requestFileLines");
assert(request, "the webview must ask for lines it does not have");
assert.deepStrictEqual(request.ids.sort(), ["f0.ts", "f1.ts", "f2.ts"]);
console.log("✓ Test 4 passed");

console.log("\n--- Test 5: webview messages cannot target files outside the workspace ---");
const { isSafeWebviewMessage } = loadTs("../message_guard.ts");
const inside = uri => uri.startsWith("file:///ws/");
assert.strictEqual(isSafeWebviewMessage({ command: "deleteFile", uri: "file:///ws/src/a.ts" }, inside), true);
assert.strictEqual(isSafeWebviewMessage({ command: "deleteFile", uri: "file:///etc/passwd" }, inside), false);
assert.strictEqual(isSafeWebviewMessage({ command: "deleteFile", uri: 42 }, inside), false);
assert.strictEqual(isSafeWebviewMessage({ command: "moveFolderToFolder", sourceFolder: "src", targetFolder: "lib" }, inside), true);
assert.strictEqual(isSafeWebviewMessage({ command: "moveFolderToFolder", sourceFolder: "../../home", targetFolder: "x" }, inside), false);
assert.strictEqual(isSafeWebviewMessage({ command: "renameFile", uri: "file:///ws/a.ts", path: "/abs/path" }, inside), false);
assert.strictEqual(isSafeWebviewMessage({ command: "deleteDirectory", folderPath: "C:\\Windows" }, inside), false);
assert.strictEqual(isSafeWebviewMessage({ command: "ready" }, inside), true);
assert.strictEqual(isSafeWebviewMessage({ command: "deleteFile", uri: "file:///ws/../../home/u/.ssh/id_rsa" }, inside), false, "raw .. must be rejected");
assert.strictEqual(isSafeWebviewMessage({ command: "deleteFile", uri: "file:///ws/%2e%2e/%2E%2E/etc/passwd" }, inside), false, "encoded .. must be rejected");
assert.strictEqual(isSafeWebviewMessage({ command: "deleteFile", uri: "file:///ws/src/..hidden.ts" }, inside), true, "names that merely start with .. are fine");
console.log("✓ Test 5 passed");

console.log("\n--- Test 6: Thumbview's own tab is recognized as VS Code reports it ---");
const { isThumbviewViewType } = loadTs("../webview_tabs.ts");
assert.strictEqual(isThumbviewViewType("mainThreadWebview-thumbview"), true, "the tab API prefixes extension webview viewTypes");
assert.strictEqual(isThumbviewViewType("thumbview"), true);
assert.strictEqual(isThumbviewViewType("mainThreadWebview-markdown.preview"), false);
assert.strictEqual(isThumbviewViewType("mainThreadWebview-notthumbview"), false, "only an exact viewType after the prefix");
assert.strictEqual(isThumbviewViewType("mainThreadWebview-other.thumbview"), false, "another extension's webview is not Thumbview");
assert.strictEqual(isThumbviewViewType("x-thumbview"), false);
assert.strictEqual(isThumbviewViewType(undefined), false, "text editor tabs have no viewType");
console.log("✓ Test 6 passed");

console.log("\nAll robustness & scale tests passed.");
process.exit(0);
