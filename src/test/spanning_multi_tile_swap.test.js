const assert = require("assert");
const { runWebviewCore } = require("./helpers/webview_core");
const fs = require("fs");
const vm = require("vm");
const { reorderSpanningItems } = require("../../out/reorder_helpers");

console.log("=== Test Suite: Spanning Multi-Tile Swap & Relative Gap Preservation ===");

// -------------------------------------------------------------
// Test 1: 5-tall tile swaps with [1; 0; 1; 1; 0] pattern in reorder_helpers.ts
// -------------------------------------------------------------
console.log("\n=== Test 1: 5-tall tile swaps with [1; 0; 1; 1; 0] pattern ===");

// Grid of 2 cols x 5 rows:
// Col 0: fileBig (rows 0..4, 5 cells tall)
// Col 1: f1 (row 0, 1 cell), "" (row 1), f2 (row 2, 1 cell), f3 (row 3, 1 cell), "" (row 4)
// Total pattern in Col 1: [1, 0, 1, 1, 0]
const activeIds = ["fileBig", "f1", "f2", "f3"];
const allocations = { fileBig: 5, f1: 1, f2: 1, f3: 1 };
const initialOrder = ["fileBig", "f1", "", "f2", "f3", ""];
const cols = 2;
const rows = 5;
const wrapRows = 5;

// Drag fileBig (from col 0, row 0) to col 1, row 0:
const res = reorderSpanningItems(
    activeIds,
    initialOrder,
    allocations,
    "fileBig",
    1, // targetCol
    0, // targetRow
    cols,
    rows,
    wrapRows
);

console.log("Reorder result newOrder:", res.newOrder);

// Unpack newOrder into 2D grid matrix to inspect column placements:
function unpackOrderToGrid(order, allocs, numCols, numRows) {
    const grid = [];
    for (let c = 0; c < numCols; c++) {
        grid.push(new Array(numRows).fill(""));
    }
    let currCol = 0;
    let currRow = 0;
    for (const id of order) {
        const n = id ? (allocs[id] || 1) : 1;
        if (currRow > 0 && currRow + n > numRows) {
            currCol++;
            currRow = 0;
        }
        if (currCol >= numCols) break;
        if (!id) {
            currRow += 1;
            continue;
        }
        for (let i = 0; i < n; i++) {
            if (currRow + i < numRows) {
                grid[currCol][currRow + i] = id;
            }
        }
        currRow += n;
    }
    return grid;
}

const resultGrid = unpackOrderToGrid(res.newOrder, allocations, cols, rows);
console.log("Col 0 after swap (swapped location):", resultGrid[0]);
console.log("Col 1 after swap (target location):", resultGrid[1]);

// Column 1 MUST have fileBig in all 5 rows:
assert.deepStrictEqual(
    resultGrid[1],
    ["fileBig", "fileBig", "fileBig", "fileBig", "fileBig"],
    "Target column must contain fileBig across all 5 rows"
);

// Column 0 (the swapped location) MUST preserve the exact relative orientation [1; 0; 1; 1; 0]:
// row 0: f1, row 1: "", row 2: f2, row 3: f3, row 4: ""
assert.deepStrictEqual(
    resultGrid[0],
    ["f1", "", "f2", "f3", ""],
    "Swapped tiles in Col 0 MUST maintain their exact orientation relative to one another [1; 0; 1; 1; 0], NOT [1; 1; 1; 0; 0]!"
);

console.log("✓ Test 1 passed: reorder_helpers preserves relative tile orientation [1; 0; 1; 1; 0]!");

// -------------------------------------------------------------
// Test 2: Overview.js reorderSpanningItems behaves identically
// -------------------------------------------------------------
console.log("\n=== Test 2: Overview.js reorderSpanningItems preserves [1; 0; 1; 1; 0] ===");

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

runWebviewCore(overviewJs, sandbox);


const localRes = sandbox.reorderSpanningItems(
    activeIds,
    initialOrder,
    allocations,
    "fileBig",
    1,
    0,
    cols,
    rows,
    wrapRows
);

const localGrid = unpackOrderToGrid(localRes.newOrder, allocations, cols, rows);
console.log("Overview.js Col 0 after swap:", localGrid[0]);
console.log("Overview.js Col 1 after swap:", localGrid[1]);

assert.deepStrictEqual(
    localGrid[1],
    ["fileBig", "fileBig", "fileBig", "fileBig", "fileBig"],
    "Overview.js target column must contain fileBig across all 5 rows"
);

assert.deepStrictEqual(
    localGrid[0],
    ["f1", "", "f2", "f3", ""],
    "Overview.js swapped tiles in Col 0 MUST maintain their exact orientation [1; 0; 1; 1; 0]!"
);

console.log("✓ Test 2 passed: media/overview.js reorderSpanningItems preserves [1; 0; 1; 1; 0]!");

console.log("\n=== ALL MULTI-TILE SPANNING SWAP TESTS PASSED ===");
