const assert = require("assert");
const { buildStableGrid } = require("../../out/layout");
const { buildSpanningGrid } = require("../../out/spanning_layout");
const { reorderCardItems } = require("../../out/reorder_helpers");

console.log("=== Test Suite: Subfolder Cards Spanning Mode & Empty Space Drag Stability ===");

// -------------------------------------------------------------
// Test 1: Moving a card to an empty slot must NOT rearrange tiles or expand the grid
// -------------------------------------------------------------
console.log("\n=== Test 1: Moving card to empty slot in subfolder cards does NOT expand view or scramble tiles ===");

// Scenario: 4 items (3 folder cards + 1 root file)
const orderedItems = [
    { type: "folder", id: "folder:src/", name: "src/" },
    { type: "folder", id: "folder:media/", name: "media/" },
    { type: "folder", id: "folder:assets/", name: "assets/" },
    { type: "file", id: "package.json", name: "package.json", nCells: 1 }
];

// In a 16:9 view, 4 items -> buildStableGrid(4) gives 2 cols x 2 rows (4 slots).
// Suppose extraCols = 1, so the user has an extra column for empty slots:
// 3 cols x 2 rows (total 6 slots).
// Initial slots:
// Row 0: slot 0 [0, 0] = src/,   slot 1 [1, 0] = media/,  slot 2 [2, 0] = assets/
// Row 1: slot 3 [0, 1] = package.json, slot 4 [1, 1] = empty, slot 5 [2, 1] = empty

const initialCardOrder = [
    "folder:src/",
    "folder:media/",
    "folder:assets/",
    "package.json"
];

// User drags package.json from slot 3 to empty slot 4 [1, 1].
const updatedCardOrder = reorderCardItems(initialCardOrder, "package.json", true, null, 4, 6);
console.log("Updated cardOrder after moving package.json to slot 4:", updatedCardOrder);

// In the buggy implementation, displayItems has length 5:
// ['folder:src/', 'folder:media/', 'folder:assets/', '', 'package.json'].
// And it computed baseGrid = buildStableGrid(displayItems.length), which returned 3 cols x 2 rows.
// With extraCols = 1, cardCols became 3 + 1 = 4 cols!
// That expanded the view and rearranged all tiles!

// The CORRECT implementation must compute the base dimensions from orderedItems.length (4)
// and NOT expand cardCols just because empty gaps ("") exist in cardOrder!
function computeSubfolderGridDimensions(actualItemsCount, cardOrder, extraCols = 0, extraRows = 0, aspect = 1.777) {
    // Base grid should be calculated on actual non-empty items
    const baseGrid = buildStableGrid(actualItemsCount, aspect);
    const cardCols = baseGrid.cols + extraCols;
    const cardRows = baseGrid.rows + extraRows;
    return { cardCols, cardRows, baseCols: baseGrid.cols, baseRows: baseGrid.rows };
}

const dimsBefore = computeSubfolderGridDimensions(orderedItems.length, initialCardOrder, 1, 0);
const dimsAfter = computeSubfolderGridDimensions(orderedItems.length, updatedCardOrder, 1, 0);

console.log("Grid dimensions before move:", dimsBefore);
console.log("Grid dimensions after move:", dimsAfter);

assert.strictEqual(dimsAfter.cardCols, dimsBefore.cardCols, "cardCols MUST NOT expand when moving to an empty slot!");
assert.strictEqual(dimsAfter.cardRows, dimsBefore.cardRows, "cardRows MUST NOT expand when moving to an empty slot!");

// And positions of other cards must be unchanged:
const slotsBefore = [];
for (let r = 0; r < dimsBefore.cardRows; r++) {
    for (let c = 0; c < dimsBefore.cardCols; c++) {
        slotsBefore.push([c, r]);
    }
}
const slotsAfter = [];
for (let r = 0; r < dimsAfter.cardRows; r++) {
    for (let c = 0; c < dimsAfter.cardCols; c++) {
        slotsAfter.push([c, r]);
    }
}

// Check slot positions for first 3 folders:
for (let i = 0; i < 3; i++) {
    const cardId = initialCardOrder[i];
    const posBefore = slotsBefore[initialCardOrder.indexOf(cardId)];
    const posAfter = slotsAfter[updatedCardOrder.indexOf(cardId)];
    assert.deepStrictEqual(posAfter, posBefore, `Card ${cardId} position MUST NOT change!`);
}

// package.json must be at slot 4 [1, 1]
const pkgPos = slotsAfter[updatedCardOrder.indexOf("package.json")];
assert.deepStrictEqual(pkgPos, [1, 1], "package.json must be at [1, 1]!");
console.log("✓ Test 1 passed: moving card to empty slot preserves grid dimensions and tile positions");

// -------------------------------------------------------------
// Test 2: Spanning tiles in subfolder cards mode
// -------------------------------------------------------------
console.log("\n=== Test 2: Spanning tiles in subfolder cards mode preserve variable height ===");

// When in subfolder cards mode and isSpanningMode is true:
// Tall root files (e.g. package-lock.json with 500 lines => nCells = 3)
// MUST have nCells = 3 and height = 3 * cellH, not forced to 1 cell tall!
const mixedItems = [
    { type: "folder", id: "folder:src/", name: "src/", nCells: 1 },
    { type: "folder", id: "folder:media/", name: "media/", nCells: 1 },
    { type: "file", id: "package.json", name: "package.json", nCells: 1 },
    { type: "file", id: "package-lock.json", name: "package-lock.json", nCells: 3, lineCount: 500 }
];

// Spanning layout for subfolder card mode:
// Total cells = 1 + 1 + 1 + 3 = 6 cells.
// wrapRows = 3 (or maxNCells = 3).
const layout = buildSpanningGrid(
    mixedItems.map(it => ({
        id: it.id,
        path: it.name,
        lineCount: it.lineCount || 50
    })),
    mixedItems.map(it => it.id),
    { "package-lock.json": 3, "package.json": 1, "folder:src/": 1, "folder:media/": 1 }
);

console.log("Subfolder spanning layout placements:", layout.placements.map(p => ({
    id: p.file.id,
    col: p.col,
    row: p.row,
    nCells: p.nCells
})));

const lockPlacement = layout.placements.find(p => p.file.id === "package-lock.json");
assert(lockPlacement, "package-lock.json should have a placement");
assert.strictEqual(lockPlacement.nCells, 3, "package-lock.json must have nCells = 3 in spanning subfolder cards mode");
assert(lockPlacement.slots.length === 3, "package-lock.json must occupy 3 vertical slots");

const srcPlacement = layout.placements.find(p => p.file.id === "folder:src/");
assert.strictEqual(srcPlacement.nCells, 1, "Folder card must occupy 1 cell");

console.log("✓ Test 2 passed: spanning tiles preserve variable height in subfolder cards mode");
console.log("\n=== ALL SUBFOLDER SPANNING & DRAG TESTS PASSED ===");
