const assert = require("assert");
const { runWebviewCore } = require("./helpers/webview_core");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

console.log("=== Test Suite: Scoped Layer Grid Space (Per-Folder Expansion/Reduction) ===");

const overviewJs = fs.readFileSync(path.join(__dirname, "../../media/overview.js"), "utf8");

// Test 1: buildSpanningGridLocal with per-folder extraCols/extraRows
console.log("\n=== Test 1: Grid space expansion scoped strictly to target folder ===");

const sandbox = {
    cellsNeeded: (lineCount) => 1,
    Math,
    Map,
    Set,
    Array,
    console
};
vm.createContext(sandbox);

const matchGrid = overviewJs.match(/function buildSpanningGridLocal[\s\S]*?return \{[\s\S]*?\};\n\}/);
assert(matchGrid, "buildSpanningGridLocal must be found in media/overview.js");
vm.runInContext(matchGrid[0], sandbox);

const rootFiles = [
    { id: "root1.ts", path: "root1.ts", lineCount: 50 },
    { id: "root2.ts", path: "root2.ts", lineCount: 50 },
    { id: "root3.ts", path: "root3.ts", lineCount: 50 },
    { id: "root4.ts", path: "root4.ts", lineCount: 50 }
];

const srcFiles = [
    { id: "src/a.ts", path: "src/a.ts", lineCount: 50 },
    { id: "src/b.ts", path: "src/b.ts", lineCount: 50 },
    { id: "src/c.ts", path: "src/c.ts", lineCount: 50 },
    { id: "src/d.ts", path: "src/d.ts", lineCount: 50 }
];

// Simulated state with folderExtraCols and folderExtraRows
const mockData = {
    extraCols: 0,
    extraRows: 0,
    folderExtraCols: {
        "src/": 1
    },
    folderExtraRows: {
        "src/": 1
    }
};

// Root directory uses root layer extra space (0, 0)
const rootExtraCols = (mockData.folderExtraCols && typeof mockData.folderExtraCols[""] === "number")
    ? mockData.folderExtraCols[""]
    : mockData.extraCols || 0;
const rootExtraRows = (mockData.folderExtraRows && typeof mockData.folderExtraRows[""] === "number")
    ? mockData.folderExtraRows[""]
    : mockData.extraRows || 0;

const rootLayout = sandbox.buildSpanningGridLocal(rootFiles, 16 / 9, null, rootExtraCols, rootExtraRows);
console.log("Root layout (extraCols=0, extraRows=0):", `cols: ${rootLayout.cols}, rows: ${rootLayout.rows}`);
assert.strictEqual(rootLayout.cols, 2, "Root must have 2 base columns without extra expansion");
assert.strictEqual(rootLayout.rows, 2, "Root must have 2 base rows without extra expansion");

// src/ directory uses "src/" layer extra space (1, 1)
const srcExtraCols = (mockData.folderExtraCols && typeof mockData.folderExtraCols["src/"] === "number")
    ? mockData.folderExtraCols["src/"]
    : 0;
const srcExtraRows = (mockData.folderExtraRows && typeof mockData.folderExtraRows["src/"] === "number")
    ? mockData.folderExtraRows["src/"]
    : 0;

const srcLayout = sandbox.buildSpanningGridLocal(srcFiles, 16 / 9, null, srcExtraCols, srcExtraRows);
console.log("src/ layout (extraCols=1, extraRows=1):", `cols: ${srcLayout.cols}, rows: ${srcLayout.rows}`);
assert.strictEqual(srcLayout.cols, 3, "src/ must have 3 columns (2 base + 1 extra)");
assert.strictEqual(srcLayout.rows, 3, "src/ must have 3 rows (2 base + 1 extra)");

console.log("✓ Test 1 passed: src/ has extra row and column while root remains at base dimensions");

// Test 2: Dragging a file into src/'s expanded bottom row (row 2)
console.log("\n=== Test 2: Dragging file into src/'s expanded bottom row ===");
runWebviewCore(overviewJs, sandbox);


const currentOrder = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
const allocations = { "src/a.ts": 1, "src/b.ts": 1, "src/c.ts": 1, "src/d.ts": 1 };

const res = sandbox.reorderSpanningItems(
    currentOrder,
    currentOrder,
    allocations,
    "src/a.ts",
    0, 2, // targetCol 0, targetRow 2 (bottom empty row)
    srcLayout.cols,
    srcLayout.rows,
    srcLayout.wrapRows
);

console.log("Reorder result in src/:", res.newOrder);
assert.strictEqual(res.finalTargetRow, 2, "src/a.ts must be placed in bottom row 2");
assert.strictEqual(res.finalTargetCol, 0, "src/a.ts must be placed in col 0");

const layoutAfterDrop = sandbox.buildSpanningGridLocal(srcFiles, 16 / 9, res.newOrder, srcExtraCols, srcExtraRows, 60, 0.05, res.rows);
const pA = layoutAfterDrop.placements.find(p => p.file.id === "src/a.ts");
assert.strictEqual(pA.row, 2, "src/a.ts in layout must occupy row 2");
console.log("✓ Test 2 passed: file successfully placed in src/'s expanded bottom row");

// Test 3: Other folders without expansion remain at base dimensions
console.log("\n=== Test 3: Other folders (e.g. media/) remain at base dimensions ===");
const mediaFiles = [
    { id: "media/icon.png", path: "media/icon.png", lineCount: 50 },
    { id: "media/style.css", path: "media/style.css", lineCount: 50 }
];

const mediaExtraCols = (mockData.folderExtraCols && typeof mockData.folderExtraCols["media/"] === "number")
    ? mockData.folderExtraCols["media/"]
    : 0;
const mediaExtraRows = (mockData.folderExtraRows && typeof mockData.folderExtraRows["media/"] === "number")
    ? mockData.folderExtraRows["media/"]
    : 0;

assert.strictEqual(mediaExtraCols, 0, "media/ extraCols must be 0");
assert.strictEqual(mediaExtraRows, 0, "media/ extraRows must be 0");

const mediaLayout = sandbox.buildSpanningGridLocal(mediaFiles, 16 / 9, null, mediaExtraCols, mediaExtraRows);
console.log("media/ layout dimensions:", `cols: ${mediaLayout.cols}, rows: ${mediaLayout.rows}`);
assert.strictEqual(mediaLayout.cols, 2, "media/ cols must be base 2");
assert.strictEqual(mediaLayout.rows, 1, "media/ rows must be base 1");
console.log("✓ Test 3 passed: media/ folder remains unexpanded");

console.log("\n=== ALL SCOPED LAYER GRID SPACE TESTS PASSED ===");
