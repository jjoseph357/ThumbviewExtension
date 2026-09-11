const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
const { reorderSpanningItems } = require("../../out/reorder_helpers");

console.log("=== Test Suite: Folder Drag Bottom Row & Right Col Expansion Bug ===");

// -------------------------------------------------------------
// Test 1: Dragging tile to bottom empty row when grid has 3 rows (e.g. extraRows = 1)
// Symptom: Tile should occupy row 2. Bug causes it to clamp to row 1, swapping with second last row,
// leaving row 2 empty.
// -------------------------------------------------------------
console.log("\n=== Test 1: Dragging tile to bottom empty row (row 2) ===");

const files = ["f1", "f2", "f3", "f4"];
const allocations = { f1: 1, f2: 1, f3: 1, f4: 1 };
// 4 files with wrapRows=2 initially occupy:
// Col 0: f1 (row 0), f2 (row 1)
// Col 1: f3 (row 0), f4 (row 1)
// Grid has 3 rows (maxAllowedRows = 3).
// Row 2 is the bottom empty row!
// User drags f1 to col 0, row 2 (bottom empty row).

const resBottom = reorderSpanningItems(
    files,
    ["f1", "f2", "f3", "f4"],
    allocations,
    "f1", // sourceId
    0,    // targetCol
    2,    // targetRow: bottom row (row index 2)
    4,    // maxAllowedCols
    3,    // maxAllowedRows: 3 rows available!
    2     // wrapRows
);

console.log("Result newOrder for bottom drag:", resBottom.newOrder);

// In newOrder, f1 MUST be at row 2, NOT row 1!
// Col 0 should have: empty at row 0, f2 at row 1, f1 at row 2!
// Col 1 should have: f3 at row 0, f4 at row 1!
assert.strictEqual(
    resBottom.newOrder.includes("f2"),
    true,
    "f2 MUST NOT be overwritten or deleted when dragging f1 to row 2!"
);

assert.deepStrictEqual(
    resBottom.newOrder,
    ["", "f2", "f1", "f3", "f4"],
    "f1 MUST occupy row 2, and f2 MUST remain at row 1!"
);

console.log("✓ Test 1 passed: tile occupies bottom row without swapping into second last row");

// -------------------------------------------------------------
// Test 2: Dragging tile to the far right column in overview.js must NOT expand canvas / column width
// The width of the canvas should not expand unless user explicitly presses Expand Grid
// -------------------------------------------------------------
console.log("\n=== Test 2: Dragging tile to far right column does NOT expand grid columns ===");

const overviewJs = fs.readFileSync("media/overview.js", "utf8");
const sandbox = {
    cellsNeeded: () => 1,
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

const matchClamp = overviewJs.match(/function clampTargetToGridCapacityLocal[\s\S]*?\n\}/);
assert(matchClamp, "clampTargetToGridCapacityLocal must be found in media/overview.js");
vm.runInContext(matchClamp[0], sandbox);

const matchReorder = overviewJs.match(/function reorderSpanningItemsLocal[\s\S]*?return \{[\s\S]*?\};\n\}/);
assert(matchReorder, "reorderSpanningItemsLocal must be found in media/overview.js");
vm.runInContext(matchReorder[0], sandbox);

const testFiles = [{ id: "f1" }, { id: "f2" }, { id: "f3" }, { id: "f4" }];
// Suppose extraCols = 1 from a previous Expand Grid
const initialLayout = sandbox.buildSpanningGridLocal(testFiles, 1.777, null, 1, 0);
// Far right column is initialLayout.cols - 1 (col 2)
// Place f1 at col 2 (the far right column):
const orderWithFarRight = ["", "f2", "f3", "f4", "f1"];
const afterLayout = sandbox.buildSpanningGridLocal(testFiles, 1.777, orderWithFarRight, 1, 0);
console.log("Layout after placing in far right column: cols =", afterLayout.cols);

assert.strictEqual(
    afterLayout.cols,
    initialLayout.cols,
    `Grid cols MUST NOT expand when dragging to far right column! Expected ${initialLayout.cols}, got ${afterLayout.cols}`
);

// Verify reorderSpanningItemsLocal inside overview.js also places tile in bottom row
const localBottomRes = sandbox.reorderSpanningItemsLocal(
    files,
    ["f1", "f2", "f3", "f4"],
    allocations,
    "f1",
    0, 2, // targetCol 0, targetRow 2
    4, 3, // maxAllowedCols 4, maxAllowedRows 3
    2     // wrapRows 2
);
console.log("overview.js reorderSpanningItemsLocal bottom move result:", localBottomRes.newOrder);
assert.deepStrictEqual(
    [...localBottomRes.newOrder],
    ["", "f2", "f1", "f3", "f4"],
    "overview.js reorderSpanningItemsLocal MUST place f1 at row 2 and keep f2 at row 1!"
);

console.log("✓ Test 2 passed: grid width/columns do not expand on far right drag, and overview.js bottom drag succeeds");
console.log("\n=== ALL FOLDER DRAG BOTTOM ROW & RIGHT COL TESTS PASSED ===");
