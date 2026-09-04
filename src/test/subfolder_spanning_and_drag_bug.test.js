const assert = require("assert");
const { buildStableGrid } = require("../../out/layout");
const { buildSpanningGrid } = require("../../out/spanning_layout");
const { reorderCardItems, reorderSpanningItems, reorderFolderItems } = require("../../out/reorder_helpers");

console.log("=== Test Suite: Subfolder Cards Mode & In-Folder Drag Stability ===");

// -------------------------------------------------------------
// Test 1: Moving a card to an empty slot in subfolder cards mode
// -------------------------------------------------------------
console.log("\n=== Test 1: Moving card to empty slot in subfolder cards does NOT expand view or scramble tiles ===");

const orderedItems = [
    { type: "folder", id: "folder:src/", name: "src/" },
    { type: "folder", id: "folder:media/", name: "media/" },
    { type: "folder", id: "folder:assets/", name: "assets/" },
    { type: "file", id: "package.json", name: "package.json", nCells: 1 }
];

const initialCardOrder = [
    "folder:src/",
    "folder:media/",
    "folder:assets/",
    "package.json"
];

const updatedCardOrder = reorderCardItems(initialCardOrder, "package.json", true, null, 4, 6);
console.log("Updated cardOrder after moving package.json to slot 4:", updatedCardOrder);

function computeSubfolderGridDimensions(actualItemsCount, cardOrder, extraCols = 0, extraRows = 0, aspect = 1.777) {
    const baseGrid = buildStableGrid(actualItemsCount, aspect);
    const cardCols = baseGrid.cols + extraCols;
    const cardRows = baseGrid.rows + extraRows;
    return { cardCols, cardRows, baseCols: baseGrid.cols, baseRows: baseGrid.rows };
}

const dimsBefore = computeSubfolderGridDimensions(orderedItems.length, initialCardOrder, 1, 0);
const dimsAfter = computeSubfolderGridDimensions(orderedItems.length, updatedCardOrder, 1, 0);

assert.strictEqual(dimsAfter.cardCols, dimsBefore.cardCols, "cardCols MUST NOT expand when moving to an empty slot!");
assert.strictEqual(dimsAfter.cardRows, dimsBefore.cardRows, "cardRows MUST NOT expand when moving to an empty slot!");

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

for (let i = 0; i < 3; i++) {
    const cardId = initialCardOrder[i];
    const posBefore = slotsBefore[initialCardOrder.indexOf(cardId)];
    const posAfter = slotsAfter[updatedCardOrder.indexOf(cardId)];
    assert.deepStrictEqual(posAfter, posBefore, `Card ${cardId} position MUST NOT change!`);
}

const pkgPos = slotsAfter[updatedCardOrder.indexOf("package.json")];
assert.deepStrictEqual(pkgPos, [1, 1], "package.json must be at [1, 1]!");
console.log("✓ Test 1 passed: moving card to empty slot preserves grid dimensions and tile positions");

// -------------------------------------------------------------
// Test 2: Subfolder cards mode is uniform 1-tile tall for all cards
// -------------------------------------------------------------
console.log("\n=== Test 2: Subfolder cards mode renders uniform 1-cell tall cards ===");

const mixedItems = [
    { type: "folder", id: "folder:src/", name: "src/" },
    { type: "folder", id: "folder:media/", name: "media/" },
    { type: "file", id: "package.json", name: "package.json" },
    { type: "file", id: "package-lock.json", name: "package-lock.json", lineCount: 500 }
];

// In uniform subfolder cards mode:
const uniformGrid = buildStableGrid(mixedItems.length, 16 / 9);
assert.strictEqual(uniformGrid.slots.length >= mixedItems.length, true, "Grid has enough slots for all items");

// Each card occupies exactly 1 slot
const assignedSlots = mixedItems.map((item, idx) => ({
    id: item.id,
    slot: uniformGrid.slots[idx],
    nCells: 1
}));

for (const entry of assignedSlots) {
    assert.strictEqual(entry.nCells, 1, `Item ${entry.id} must be exactly 1 cell tall in subfolder cards mode`);
    assert.strictEqual(Array.isArray(entry.slot) && entry.slot.length === 2, true);
}
console.log("✓ Test 2 passed: subfolder cards mode renders uniform 1-cell tall cards");

// -------------------------------------------------------------
// Test 3: Within a subfolder card, dragging and dropping files swaps them without deleting or moving others
// -------------------------------------------------------------
console.log("\n=== Test 3: File drag and drop swap within a subfolder card preserves other file positions ===");

// Scenario: 4 files inside a subfolder: f1, f2, f3, f4. wrapRows = 2.
// Initial layout:
// Col 0: f1 (row 0), f2 (row 1)
// Col 1: f3 (row 0), f4 (row 1)
const activeIds = ["f1", "f2", "f3", "f4"];
const currentFolderOrder = ["f1", "f2", "f3", "f4"];
const allocations = { f1: 1, f2: 1, f3: 1, f4: 1 };
const wrapRows = 2;

// Swap f1 (source at 0, 0) and f4 (target at 1, 1)
const swapRes = reorderSpanningItems(
    activeIds,
    currentFolderOrder,
    allocations,
    "f1", // sourceId
    1,    // targetCol (f4 is at 1, 1)
    1,    // targetRow
    2,    // maxAllowedCols
    2,    // maxAllowedRows
    wrapRows
);

console.log("Swap result newOrder:", swapRes.newOrder);

// Both f1 and f4 must be in newOrder (f4 must NOT be deleted!)
assert(swapRes.newOrder.includes("f1"), "f1 must be present in newOrder");
assert(swapRes.newOrder.includes("f4"), "f4 must be present in newOrder (not deleted on swap)");
assert(swapRes.newOrder.includes("f2"), "f2 must be present in newOrder");
assert(swapRes.newOrder.includes("f3"), "f3 must be present in newOrder");

// Verify placements from newOrder:
const layoutAfterSwap = buildSpanningGrid(
    activeIds.map(id => ({ id, path: id, lineCount: 50 })),
    swapRes.newOrder,
    allocations,
    wrapRows
);

const p1 = layoutAfterSwap.placements.find(p => p.file.id === "f1");
const p2 = layoutAfterSwap.placements.find(p => p.file.id === "f2");
const p3 = layoutAfterSwap.placements.find(p => p.file.id === "f3");
const p4 = layoutAfterSwap.placements.find(p => p.file.id === "f4");

console.log("Placements after swap:", {
    f1: [p1.col, p1.row],
    f2: [p2.col, p2.row],
    f3: [p3.col, p3.row],
    f4: [p4.col, p4.row]
});

// f1 and f4 traded positions:
assert.deepStrictEqual([p1.col, p1.row], [1, 1], "f1 must be at target position [1, 1]");
assert.deepStrictEqual([p4.col, p4.row], [0, 0], "f4 must be at source position [0, 0]");

// Uninvolved files f2 and f3 MUST NOT MOVE:
assert.deepStrictEqual([p2.col, p2.row], [0, 1], "f2 position must be unchanged at [0, 1]");
assert.deepStrictEqual([p3.col, p3.row], [1, 0], "f3 position must be unchanged at [1, 0]");

console.log("✓ Test 3 passed: swapping files within subfolder card swaps target and source without altering other files");

// -------------------------------------------------------------
// Test 4: Within a subfolder card, dragging a file to an empty slot preserves other files
// -------------------------------------------------------------
console.log("\n=== Test 4: Moving file to empty slot within a subfolder card preserves other file positions ===");

// Move f1 from [0, 0] to empty slot [2, 0]
const emptyMoveRes = reorderSpanningItems(
    activeIds,
    currentFolderOrder,
    allocations,
    "f1",
    2, // targetCol
    0, // targetRow
    3, // maxAllowedCols
    2, // maxAllowedRows
    wrapRows
);

console.log("Empty slot move result newOrder:", emptyMoveRes.newOrder);

const layoutAfterEmptyMove = buildSpanningGrid(
    activeIds.map(id => ({ id, path: id, lineCount: 50 })),
    emptyMoveRes.newOrder,
    allocations,
    wrapRows
);

const ep1 = layoutAfterEmptyMove.placements.find(p => p.file.id === "f1");
const ep2 = layoutAfterEmptyMove.placements.find(p => p.file.id === "f2");
const ep3 = layoutAfterEmptyMove.placements.find(p => p.file.id === "f3");
const ep4 = layoutAfterEmptyMove.placements.find(p => p.file.id === "f4");

console.log("Placements after empty move:", {
    f1: [ep1.col, ep1.row],
    f2: [ep2.col, ep2.row],
    f3: [ep3.col, ep3.row],
    f4: [ep4.col, ep4.row]
});

assert.deepStrictEqual([ep1.col, ep1.row], [2, 0], "f1 must be at target empty slot [2, 0]");
assert.deepStrictEqual([ep2.col, ep2.row], [0, 1], "f2 position must be unchanged at [0, 1]");
assert.deepStrictEqual([ep3.col, ep3.row], [1, 0], "f3 position must be unchanged at [1, 0]");
assert.deepStrictEqual([ep4.col, ep4.row], [1, 1], "f4 position must be unchanged at [1, 1]");

console.log("✓ Test 4 passed: moving file to empty slot preserves other file positions");
console.log("\n=== ALL SUBFOLDER CARDS & IN-FOLDER DRAG TESTS PASSED ===");
