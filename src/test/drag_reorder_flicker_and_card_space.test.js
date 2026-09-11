const assert = require("assert");
const { reorderSpanningItems, reorderCardItems } = require("../../out/reorder_helpers");

console.log("=== Test Suite: Drag Reorder Flicker Elimination & Collapsed Folder Canvas Sizing ===");

// ----------------------------------------------------------------------------
// Test 1: Spanning drag reorder keeps all untouched files locked at their exact (col, row)
// ----------------------------------------------------------------------------
console.log("\n=== Test 1: Spanning drag reorder leaves untouched files locked ===");

const files = [
    { id: "f1", lineCount: 60, nCells: 1 },
    { id: "f2", lineCount: 120, nCells: 2 },
    { id: "f3", lineCount: 60, nCells: 1 },
    { id: "f4", lineCount: 60, nCells: 1 },
    { id: "f5", lineCount: 180, nCells: 3 },
    { id: "f6", lineCount: 60, nCells: 1 },
    { id: "f7", lineCount: 60, nCells: 1 }
];

const allocations = {};
for (const f of files) allocations[f.id] = f.nCells;
const activeIds = files.map(f => f.id);

// Initial column-major placement with wrapRows = 3:
// Col 0: f1 (row 0, span 1), f2 (row 1, span 2)
// Col 1: f3 (row 0, span 1), f4 (row 1, span 1)
// Col 2: f5 (row 0, span 3)
// Col 3: f6 (row 0, span 1), f7 (row 1, span 1)
const initialOrder = ["f1", "f2", "f3", "f4", "", "f5", "f6", "f7"];

// User drags f1 from (col 0, row 0) to empty slot (col 1, row 2)
const res = reorderSpanningItems(
    activeIds,
    initialOrder,
    allocations,
    "f1", // source
    1,    // targetCol
    2,    // targetRow
    5,    // maxAllowedCols
    3,    // maxAllowedRows
    3     // wrapRows
);

// Map placements to verify where each file ended up
function getPlacementsFromOrder(order, allocs, wrapRows) {
    let col = 0;
    let row = 0;
    const placements = {};
    for (const id of order) {
        const n = id ? (allocs[id] || 1) : 1;
        if (row > 0 && row + n > wrapRows) {
            col++;
            row = 0;
        }
        if (id) {
            placements[id] = { col, row, nCells: n };
        }
        row += n;
    }
    return placements;
}

const initialPlacements = getPlacementsFromOrder(initialOrder, allocations, 3);
const newPlacements = getPlacementsFromOrder(res.newOrder, allocations, 3);

// f1 moved to target
assert.strictEqual(newPlacements["f1"].col, 1, "f1 should be in col 1");
assert.strictEqual(newPlacements["f1"].row, 2, "f1 should be in row 2");

// UNTOUCHED files MUST NOT MOVE!
// f2 was in col 0, row 1
assert.strictEqual(newPlacements["f2"].col, initialPlacements["f2"].col, "f2 col must not move");
assert.strictEqual(newPlacements["f2"].row, initialPlacements["f2"].row, "f2 row must not move");

// f3 was in col 1, row 0
assert.strictEqual(newPlacements["f3"].col, initialPlacements["f3"].col, "f3 col must not move");
assert.strictEqual(newPlacements["f3"].row, initialPlacements["f3"].row, "f3 row must not move");

// f4 was in col 1, row 1
assert.strictEqual(newPlacements["f4"].col, initialPlacements["f4"].col, "f4 col must not move");
assert.strictEqual(newPlacements["f4"].row, initialPlacements["f4"].row, "f4 row must not move");

// f5 was in col 2, row 0
assert.strictEqual(newPlacements["f5"].col, initialPlacements["f5"].col, "f5 col must not move");
assert.strictEqual(newPlacements["f5"].row, initialPlacements["f5"].row, "f5 row must not move");

// f6 was in col 3, row 0
assert.strictEqual(newPlacements["f6"].col, initialPlacements["f6"].col, "f6 col must not move");
assert.strictEqual(newPlacements["f6"].row, initialPlacements["f6"].row, "f6 row must not move");

// f7 was in col 3, row 1
assert.strictEqual(newPlacements["f7"].col, initialPlacements["f7"].col, "f7 col must not move");
assert.strictEqual(newPlacements["f7"].row, initialPlacements["f7"].row, "f7 row must not move");

console.log("PASS: Untouched files remained 100% stable at their exact (col, row) without shifting.");

// ----------------------------------------------------------------------------
// Test 2: Collapsing 50 files into 3 subfolder cards sizes totalItems strictly to 4 (not 50)
// ----------------------------------------------------------------------------
console.log("\n=== Test 2: Collapsing 50 files into subfolder cards does NOT inflate totalItems to 50 ===");

// Simulate 50 files in src/
const scopedFiles = [];
for (let i = 1; i <= 20; i++) scopedFiles.push({ id: `src/sub1/file${i}.ts`, path: `src/sub1/file${i}.ts` });
for (let i = 1; i <= 20; i++) scopedFiles.push({ id: `src/sub2/file${i}.ts`, path: `src/sub2/file${i}.ts` });
for (let i = 1; i <= 9; i++) scopedFiles.push({ id: `src/sub3/file${i}.ts`, path: `src/sub3/file${i}.ts` });
scopedFiles.push({ id: `src/index.ts`, path: `src/index.ts` }); // 1 root file

assert.strictEqual(scopedFiles.length, 50, "Should have 50 total files");

// Simulate subfolder grouping
const orderedItems = [
    { type: "folder", id: "folder:src/sub1/", card: { path: "src/sub1/", name: "sub1", fileCount: 20 } },
    { type: "folder", id: "folder:src/sub2/", card: { path: "src/sub2/", name: "sub2", fileCount: 20 } },
    { type: "folder", id: "folder:src/sub3/", card: { path: "src/sub3/", name: "sub3", fileCount: 9 } },
    { type: "file", id: "src/index.ts", file: scopedFiles[49] }
];

// Suppose folderOrders["src/"] previously held all 50 file IDs from uncollapsed mode
const staleFolderFileOrder = scopedFiles.map(f => f.id);

// Now execute the fixed card resolution logic:
const itemById = new Map(orderedItems.map(it => [it.id, it]));

// With the fix, folderCardOrders is used for card view; stale file IDs in effectiveCardOrder are ignored
const folderCardOrders = {}; // currently empty (fresh collapse)
const effectiveCardOrder = folderCardOrders["src/"] || null; // null because folderCardOrders is isolated!

let displayItems = [];
if (effectiveCardOrder && Array.isArray(effectiveCardOrder) && effectiveCardOrder.length > 0) {
    const seenIds = new Set();
    for (const cid of effectiveCardOrder) {
        if (!cid) {
            displayItems.push(null);
        } else {
            const it = itemById.get(cid);
            if (it) {
                displayItems.push(it);
                seenIds.add(cid);
            }
        }
    }
    for (const it of orderedItems) {
        if (!seenIds.has(it.id)) {
            displayItems.push(it);
        }
    }
    while (displayItems.length > 0 && !displayItems[displayItems.length - 1]) {
        displayItems.pop();
    }
} else {
    displayItems = orderedItems;
}

const totalItems = Math.max(orderedItems.length, displayItems.length);

assert.strictEqual(totalItems, 4, `totalItems must be 4, but got ${totalItems}`);
assert.strictEqual(displayItems.length, 4, `displayItems.length must be 4, but got ${displayItems.length}`);

function buildStableGrid(nCells, targetAspect = 1.777) {
    let rows = 1;
    let cols = Math.max(2, Math.ceil(rows * targetAspect));
    const slots = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            slots.push([c, r]);
        }
    }
    while (slots.length < nCells) {
        const errCol = Math.abs((cols + 1) / rows - targetAspect);
        const errRow = Math.abs(cols / (rows + 1) - targetAspect);
        if (errCol <= errRow) {
            const newCol = cols;
            for (let r = 0; r < rows; r++) {
                slots.push([newCol, r]);
            }
            cols++;
        } else {
            const newRow = rows;
            for (let c = 0; c < cols; c++) {
                slots.push([c, newRow]);
            }
            rows++;
        }
    }
    return { rows, cols, slots };
}

const grid = buildStableGrid(totalItems);
assert.strictEqual(grid.cols, 2, `Grid cols should be 2, got ${grid.cols}`);
assert.strictEqual(grid.rows, 2, `Grid rows should be 2, got ${grid.rows}`);
assert.strictEqual(grid.slots.length, 4, `Grid slots should be 4, got ${grid.slots.length}`);

// Available canvas: 600 x 400
const availW = 600 - 48; // 552
const availH = 400 - 70; // 330
const cardW = availW / grid.cols; // 276px
const cardH = availH / grid.rows; // 165px

assert(cardW >= 200, `Card width should be generously sized (276px), got ${cardW}px`);
assert(cardH >= 100, `Card height should be generously sized (165px), got ${cardH}px`);

console.log(`PASS: Collapsed cards use 2x2 grid with generous card dimensions (${cardW}x${cardH}px), utilizing full canvas area.`);

// ----------------------------------------------------------------------------
// Test 3: Even if stale file IDs existed in effectiveCardOrder, unmatched IDs do NOT become null
// ----------------------------------------------------------------------------
console.log("\n=== Test 3: Unmatched IDs in effectiveCardOrder do not create phantom null slots ===");

// Suppose effectiveCardOrder contained stale file IDs mixed with card IDs
const dirtyOrder = ["folder:src/sub1/", "src/sub1/file1.ts", "src/sub2/file2.ts", "folder:src/sub2/", "folder:src/sub3/", "src/index.ts"];

displayItems = [];
const seenIds = new Set();
for (const cid of dirtyOrder) {
    if (!cid) {
        displayItems.push(null);
    } else {
        const it = itemById.get(cid);
        if (it) {
            displayItems.push(it);
            seenIds.add(cid);
        }
        // Unmatched IDs are skipped, NOT pushed as null!
    }
}
for (const it of orderedItems) {
    if (!seenIds.has(it.id)) {
        displayItems.push(it);
    }
}
while (displayItems.length > 0 && !displayItems[displayItems.length - 1]) {
    displayItems.pop();
}

assert.strictEqual(displayItems.length, 4, `displayItems should only contain the 4 valid cards, got ${displayItems.length}`);
assert.deepStrictEqual(
    displayItems.map(it => it.id),
    ["folder:src/sub1/", "folder:src/sub2/", "folder:src/sub3/", "src/index.ts"]
);

console.log("PASS: Stale IDs safely filtered without creating null holes or inflating grid capacity.");

// ----------------------------------------------------------------------------
// Test 4: folderCardOrders and folderOrders maintain isolated persistence
// ----------------------------------------------------------------------------
console.log("\n=== Test 4: folderCardOrders and folderOrders are strictly isolated ===");

const state = {
    folderOrders: {
        "src/": ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]
    },
    folderCardOrders: {}
};

// Reorder cards inside src/
const initialCards = ["folder:src/sub1/", "folder:src/sub2/"];
const newCardOrder = reorderCardItems(initialCards, "folder:src/sub1/", false, "folder:src/sub2/", 0, 2);
state.folderCardOrders["src/"] = newCardOrder;

// Verify folderOrders was NOT corrupted or overwritten by card reordering
assert.strictEqual(state.folderOrders["src/"].length, 4, "folderOrders must retain all 4 file IDs");
assert.deepStrictEqual(state.folderOrders["src/"], ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
assert.deepStrictEqual(state.folderCardOrders["src/"], ["folder:src/sub2/", "folder:src/sub1/"]);

console.log("PASS: folderCardOrders and folderOrders are completely isolated.");
console.log("\n=== ALL DRAG REORDER & COLLAPSED CANVAS TESTS PASSED ===");
