const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
const { reorderSpanningItems, expandSpanningGridOrder, reduceSpanningGridOrder } = require("../../out/reorder_helpers");

console.log("=== Test Suite: Coordinate-Stable Grid & Symmetric Space Expansion ===");

// -------------------------------------------------------------
// Test 1: expandSpanningGridOrder preserves exact (col, row) placements
// -------------------------------------------------------------
console.log("\n=== Test 1: expandSpanningGridOrder preserves exact (col, row) placements ===");

// Grid of 2 cols x 2 rows:
// Col 0: A (row 0), B (row 1)
// Col 1: C (row 0), D (row 1)
const order1 = ["A", "B", "C", "D"];
const allocations1 = { A: 1, B: 1, C: 1, D: 1 };
const exp1 = expandSpanningGridOrder(order1, allocations1, 2, 2);

console.log("Expanded order (from 2x2 to 3x3):", exp1.newOrder);
assert.strictEqual(exp1.rows, 3, "New grid rows should be 3");
assert.strictEqual(exp1.cols, 3, "New grid cols should be 3");

// In 3x3:
// Col 0: row 0 = A, row 1 = B, row 2 = ""
// Col 1: row 0 = C, row 1 = D, row 2 = "" (trailing popped)
// 1D order: ["A", "B", "", "C", "D"]
assert.deepStrictEqual(
    exp1.newOrder,
    ["A", "B", "", "C", "D"],
    "Every existing tile must remain at exact (col, row) coordinates with holes inserted at bottom and right"
);
console.log("✓ Test 1 passed: expandSpanningGridOrder is coordinate-stable");

// -------------------------------------------------------------
// Test 2: reduceSpanningGridOrder reverses expansion without reflowing remaining items
// -------------------------------------------------------------
console.log("\n=== Test 2: reduceSpanningGridOrder reverses expansion ===");

const red1 = reduceSpanningGridOrder(exp1.newOrder, allocations1, 3, 3, 2, 2);
console.log("Reduced order (from 3x3 back to 2x2):", red1.newOrder);
assert.strictEqual(red1.rows, 2, "Reduced grid rows should be 2");
assert.strictEqual(red1.cols, 2, "Reduced grid cols should be 2");
assert.deepStrictEqual(
    red1.newOrder,
    ["A", "B", "C", "D"],
    "Reducing grid space must return items to their exact 2x2 positions without reflow"
);
console.log("✓ Test 2 passed: reduceSpanningGridOrder successfully restores 2x2 positions");

// -------------------------------------------------------------
// Test 3: Dragging file to bottom empty row does NOT expand grid dimensions
// -------------------------------------------------------------
console.log("\n=== Test 3: Dragging file to bottom empty row does NOT expand grid dimensions ===");

// In 3x3 grid, user drags A (at col 0, row 0) to bottom empty row (col 0, row 2)
const resDragBottom = reorderSpanningItems(
    ["A", "B", "C", "D"],
    exp1.newOrder,
    allocations1,
    "A",
    0, // targetCol = 0
    2, // targetRow = 2 (bottom empty row)
    3, // maxAllowedCols = 3
    3, // maxAllowedRows = 3
    3  // wrapRows = 3
);

console.log("Result after dragging A to bottom row:", resDragBottom.newOrder);
assert.strictEqual(resDragBottom.rows, 3, "Grid rows must remain strictly 3");
assert.strictEqual(resDragBottom.cols, 3, "Grid cols must remain strictly 3");

// Col 0: row 0 = "", row 1 = B, row 2 = A
// Col 1: row 0 = C, row 1 = D, row 2 = "" (trailing popped)
assert.deepStrictEqual(
    resDragBottom.newOrder,
    ["", "B", "A", "C", "D"],
    "A must be placed at (0, 2), B remains at (0, 1), C at (1, 0), D at (1, 1)"
);
console.log("✓ Test 3 passed: dragging to bottom empty row preserves grid dimensions and file coordinates");

// -------------------------------------------------------------
// Test 4: Dragging file to an empty slot in another column does NOT move random files
// -------------------------------------------------------------
console.log("\n=== Test 4: Dragging file to empty slot preserves untouched files ===");

// User drags D from (1, 1) to empty slot at (2, 0)
const resDragEmpty = reorderSpanningItems(
    ["A", "B", "C", "D"],
    resDragBottom.newOrder,
    allocations1,
    "D",
    2, // targetCol = 2
    0, // targetRow = 0
    3, // maxAllowedCols = 3
    3, // maxAllowedRows = 3
    3  // wrapRows = 3
);

console.log("Result after dragging D to (2, 0):", resDragEmpty.newOrder);
// Col 0: "", "B", "A"
// Col 1: "C", "", ""
// Col 2: "D", "", ""
assert.strictEqual(resDragEmpty.newOrder[0], "", "Col 0 row 0 empty");
assert.strictEqual(resDragEmpty.newOrder[1], "B", "Col 0 row 1 is B");
assert.strictEqual(resDragEmpty.newOrder[2], "A", "Col 0 row 2 is A");
assert.strictEqual(resDragEmpty.newOrder[3], "C", "Col 1 row 0 is C");
assert.strictEqual(resDragEmpty.newOrder[4], "", "Col 1 row 1 empty (D was moved)");
assert.strictEqual(resDragEmpty.newOrder[5], "", "Col 1 row 2 empty");
assert.strictEqual(resDragEmpty.newOrder[6], "D", "Col 2 row 0 is D");
assert.strictEqual(resDragEmpty.rows, 3, "Rows must remain 3");
assert.strictEqual(resDragEmpty.cols, 3, "Cols must remain 3");
console.log("✓ Test 4 passed: dragging to empty slot does not move random files");

// -------------------------------------------------------------
// Test 5: overview.js buildSpanningGridLocal allows rows to expand when extraRows > 0
// -------------------------------------------------------------
console.log("\n=== Test 5: overview.js buildSpanningGridLocal allows rows to expand ===");

const overviewCode = fs.readFileSync("media/overview.js", "utf8");
const sandbox = {
    cellsNeeded: () => 1,
    Math,
    Map,
    Set,
    Array,
    console
};
vm.createContext(sandbox);
const matchGrid = overviewCode.match(/function buildSpanningGridLocal[\s\S]*?return \{[\s\S]*?\};\n\}/);
assert(matchGrid, "buildSpanningGridLocal must be found in media/overview.js");
vm.runInContext(matchGrid[0], sandbox);

const testFiles = [
    { id: "f1", lineCount: 10, nCells: 1 },
    { id: "f2", lineCount: 10, nCells: 1 },
    { id: "f3", lineCount: 10, nCells: 1 },
    { id: "f4", lineCount: 10, nCells: 1 }
];

// Base grid without extraRows
const baseGrid = sandbox.buildSpanningGridLocal(testFiles, 1.777, ["f1", "f2", "f3", "f4"], 0, 0);
console.log("Base grid rows:", baseGrid.rows, "cols:", baseGrid.cols);
assert.strictEqual(baseGrid.rows, 2, "Base grid rows should be 2 for 4 files");

// Expanded grid with extraRows = 1 and extraCols = 1
const expandedGrid = sandbox.buildSpanningGridLocal(
    testFiles,
    1.777,
    ["f1", "f2", "", "f3", "f4", "", "", "", ""],
    1, // extraCols = 1
    1, // extraRows = 1
    60,
    0.05,
    3  // savedWrapRows = 3
);

console.log("Expanded grid rows:", expandedGrid.rows, "cols:", expandedGrid.cols, "wrapRows:", expandedGrid.wrapRows);
assert.strictEqual(expandedGrid.rows >= 3, true, "Expanded grid rows MUST be at least 3");
assert.strictEqual(expandedGrid.wrapRows >= 3, true, "Expanded grid wrapRows MUST be at least 3");

// Verify placement coordinates in expandedGrid:
const pF1 = expandedGrid.placements.find(p => p.file.id === "f1");
const pF2 = expandedGrid.placements.find(p => p.file.id === "f2");
const pF3 = expandedGrid.placements.find(p => p.file.id === "f3");
const pF4 = expandedGrid.placements.find(p => p.file.id === "f4");

assert.deepStrictEqual([pF1.col, pF1.row], [0, 0], "f1 at (0, 0)");
assert.deepStrictEqual([pF2.col, pF2.row], [0, 1], "f2 at (0, 1)");
assert.deepStrictEqual([pF3.col, pF3.row], [1, 0], "f3 at (1, 0)");
assert.deepStrictEqual([pF4.col, pF4.row], [1, 1], "f4 at (1, 1)");

console.log("✓ Test 5 passed: buildSpanningGridLocal properly expands rows and preserves placements");

console.log("\n=== ALL COORDINATE-STABLE GRID TESTS PASSED! ===");
