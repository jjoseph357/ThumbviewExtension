const assert = require("assert");
const path = require("path");
const fs = require("fs");

const Module = require("module");
const origRequire = Module.prototype.require;
Module.prototype.require = function (request) {
    if (request === "vscode") {
        return {
            workspace: {
                asRelativePath: (p) => (p && p.fsPath) || p,
                fs: { stat: async () => ({ size: 100, mtime: 12345 }) }
            }
        };
    }
    return origRequire.apply(this, arguments);
};

const { buildStableGrid, findSlotIndex } = require("../../out/layout");
const { moveItemToEmptySlot, reorderFolderItems, reorderSpanningItems } = require("../../out/reorder_helpers");
const { clearScanCache } = require("../../out/scanner");

console.log("=== Test Suite: Grid Aspect Ratio, Drag to Empty Slots, & Scanner ===");

// -------------------------------------------------------------
// 1. Grid Aspect Ratio and Empty Space Elimination (~230 files)
// -------------------------------------------------------------
console.log("\n=== 1. Grid Aspect Ratio and Empty Space Elimination (~230 files) ===");

const grid230 = buildStableGrid(230);
console.log(`230 files layout: ${grid230.cols} cols x ${grid230.rows} rows (total slots: ${grid230.slots.length})`);

// Old buggy layout produced 22 cols x 12 rows (264 slots), leaving 6 empty rows in cols 20-21 and entire row 11 empty
// New layout produces 20 cols x 12 rows (240 slots)
assert.strictEqual(grid230.cols, 20, "230 files should produce 20 columns");
assert.strictEqual(grid230.rows, 12, "230 files should produce 12 rows");
assert.strictEqual(grid230.slots.length, 240, "Total slots should be 240");

// Check that rows 0..10 are 100% full across all 20 columns
const occupiedSlots = new Set(grid230.slots.slice(0, 230).map(s => `${s[0]},${s[1]}`));
for (let r = 0; r < 11; r++) {
    for (let c = 0; c < 20; c++) {
        assert(occupiedSlots.has(`${c},${r}`), `Row ${r}, Col ${c} must be occupied`);
    }
}
// Row 11 has the remaining 10 files (cols 0..9)
for (let c = 0; c < 10; c++) {
    assert(occupiedSlots.has(`${c},11`), `Row 11, Col ${c} must be occupied`);
}
// Trailing 10 slots in row 11 are empty
for (let c = 10; c < 20; c++) {
    assert(!occupiedSlots.has(`${c},11`), `Row 11, Col ${c} should be empty slot`);
}

// Ensure NO columns are completely empty
for (let c = 0; c < 20; c++) {
    let colOccupied = false;
    for (let r = 0; r < 12; r++) {
        if (occupiedSlots.has(`${c},${r}`)) {
            colOccupied = true;
            break;
        }
    }
    assert(colOccupied, `Column ${c} must not be empty`);
}

// Ensure NO rows are completely empty
for (let r = 0; r < 12; r++) {
    let rowOccupied = false;
    for (let c = 0; c < 20; c++) {
        if (occupiedSlots.has(`${c},${r}`)) {
            rowOccupied = true;
            break;
        }
    }
    assert(rowOccupied, `Row ${r} must not be empty`);
}
console.log("✓ Verified: 0 completely empty rows, 0 completely empty columns for 230 files");

// -------------------------------------------------------------
// 2. Prefix Stability Across Diverse Cell Counts
// -------------------------------------------------------------
console.log("\n=== 2. Prefix Stability Across Diverse Cell Counts ===");

const cellCounts = [50, 100, 200, 230, 240, 250, 300, 400];
const layouts = cellCounts.map(n => buildStableGrid(n));

for (let i = 0; i < layouts.length - 1; i++) {
    const smaller = layouts[i];
    const larger = layouts[i + 1];
    for (let idx = 0; idx < smaller.slots.length; idx++) {
        assert.strictEqual(
            smaller.slots[idx][0],
            larger.slots[idx][0],
            `Slot ${idx} X must match between count ${cellCounts[i]} and ${cellCounts[i + 1]}`
        );
        assert.strictEqual(
            smaller.slots[idx][1],
            larger.slots[idx][1],
            `Slot ${idx} Y must match between count ${cellCounts[i]} and ${cellCounts[i + 1]}`
        );
    }
}
console.log("✓ Verified: 100% prefix stability across all cell counts");

// -------------------------------------------------------------
// 3. findSlotIndex Accuracy
// -------------------------------------------------------------
console.log("\n=== 3. findSlotIndex Accuracy ===");

for (const [col, row] of [[0, 0], [5, 2], [19, 11], [15, 10], [10, 11]]) {
    const slotIdx = findSlotIndex(col, row, 230);
    const layout = buildStableGrid(slotIdx + 1);
    assert.strictEqual(layout.slots[slotIdx][0], col, `Slot index ${slotIdx} must match col ${col}`);
    assert.strictEqual(layout.slots[slotIdx][1], row, `Slot index ${slotIdx} must match row ${row}`);
}
console.log("✓ Verified: findSlotIndex accurately resolves coordinates");

// -------------------------------------------------------------
// 4. Drag and Drop to Empty Slots (Preserving Gaps)
// -------------------------------------------------------------
console.log("\n=== 4. Drag and Drop to Empty Slots (Preserving Gaps) ===");

// Moving an item to an empty slot leaves "" at source and places item at target
const order1 = ["fileA", "fileB", "fileC", "fileD"];
const updated1 = moveItemToEmptySlot(order1, "fileB", 6, 10);
assert.strictEqual(updated1[0], "fileA");
assert.strictEqual(updated1[1], "", "Source index must become an empty hole");
assert.strictEqual(updated1[2], "fileC");
assert.strictEqual(updated1[3], "fileD");
assert.strictEqual(updated1[4], "");
assert.strictEqual(updated1[5], "");
assert.strictEqual(updated1[6], "fileB", "Target index must receive fileB");

// Reordering folder items with empty slot
const folderOrder = ["f1", "f2", "f3"];
const folderRes = reorderFolderItems(folderOrder, "f1", true, null, 4, 10, "swap");
assert.strictEqual(folderRes[0], "");
assert.strictEqual(folderRes[1], "f2");
assert.strictEqual(folderRes[2], "f3");
assert.strictEqual(folderRes[3], "");
assert.strictEqual(folderRes[4], "f1");

// Spanning reorder with multiple empty slots preserves wrapRows column wrapping
const spanningOrder = ["", "", "", "itemX"]; // 3 empty slots then itemX
const spanningAllocs = { itemX: 1 };
const spanningRes = reorderSpanningItems(["itemX"], spanningOrder, spanningAllocs, "itemX", 1, 0, 4, 2, 2);
// wrapRows = 2: col 0 has slots 0 and 1. Slot 2 wraps to col 1 row 0.
assert(spanningRes.cols <= 4, "Cols within capacity");
assert(spanningRes.rows <= 2, "Rows within wrapRows");
console.log("✓ Verified: Drag to empty slots preserves holes without collapsing files");

console.log("\n=== ALL GRID ASPECT & DRAG REGRESSION TESTS PASSED ===");
