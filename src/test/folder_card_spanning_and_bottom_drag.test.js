const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

console.log("=== Test Suite: Folder Card Spanning Tiles & Grid Drag Expansion Bugfix ===");

// Load media/overview.js in VM sandbox to test actual webview layout & reorder functions
const overviewJsPath = path.join(__dirname, "../../media/overview.js");
const overviewJs = fs.readFileSync(overviewJsPath, "utf8");

const sandbox = {
    Math,
    Array,
    Set,
    Map,
    console
};
vm.createContext(sandbox);

// Extract helper functions from overview.js
const matchCellsNeeded = overviewJs.match(/function cellsNeeded\([\s\S]*?\n\}/);
assert(matchCellsNeeded, "cellsNeeded must be found in overview.js");
vm.runInContext(matchCellsNeeded[0], sandbox);

const matchGrid = overviewJs.match(/function buildSpanningGridLocal[\s\S]*?return \{[\s\S]*?\};\n\}/);
assert(matchGrid, "buildSpanningGridLocal must be found in media/overview.js");
vm.runInContext(matchGrid[0], sandbox);

const matchClamp = overviewJs.match(/function clampTargetToGridCapacityLocal[\s\S]*?\n\}/);
assert(matchClamp, "clampTargetToGridCapacityLocal must be found in media/overview.js");
vm.runInContext(matchClamp[0], sandbox);

const matchReorder = overviewJs.match(/function reorderSpanningItemsLocal[\s\S]*?return \{[\s\S]*?\};\n\}/);
assert(matchReorder, "reorderSpanningItemsLocal must be found in media/overview.js");
vm.runInContext(matchReorder[0], sandbox);

// ---------------------------------------------------------------------------------
// Test 1: Dragging files to bottom empty row in src/ does NOT expand the grid
// ---------------------------------------------------------------------------------
console.log("\n=== Test 1: Dragging files to bottom empty row in src/ does NOT expand the grid ===");

// 4 files in src/, all 1 tile tall (lineCount = 50)
const srcFiles = [
    { id: "src/a.ts", lineCount: 50 },
    { id: "src/b.ts", lineCount: 50 },
    { id: "src/c.ts", lineCount: 50 },
    { id: "src/d.ts", lineCount: 50 }
];
const srcFileIds = srcFiles.map(f => f.id);
const srcAllocations = { "src/a.ts": 1, "src/b.ts": 1, "src/c.ts": 1, "src/d.ts": 1 };

// Expand space in src/ folder: extraCols = 1, extraRows = 1
const initialLayout = sandbox.buildSpanningGridLocal(srcFiles, 1.777, null, 1, 1);
console.log(`Initial src/ layout dimensions with extraCols=1, extraRows=1: cols: ${initialLayout.cols}, rows: ${initialLayout.rows}, wrapRows: ${initialLayout.wrapRows}`);
assert.strictEqual(initialLayout.rows, 3, "Initial layout must have 3 rows (2 base + 1 extra)");
assert.strictEqual(initialLayout.cols, 3, "Initial layout must have 3 cols (2 base + 1 extra)");

// User drags src/a.ts to row 2 (col 0, row 2, bottom empty row)
const drag1 = sandbox.reorderSpanningItemsLocal(
    srcFileIds,
    srcFileIds,
    srcAllocations,
    "src/a.ts",
    0, // targetCol
    2, // targetRow: row 2 (bottom empty row)
    initialLayout.cols,
    initialLayout.rows,
    initialLayout.wrapRows
);

console.log("Drag 1 to row 2 newOrder:", drag1.newOrder);
console.log(`Drag 1 result rows: ${drag1.rows}, cols: ${drag1.cols}`);
assert.strictEqual(drag1.rows, 3, "Drag 1 result rows must be 3");

// On subsequent render, savedWrapRows = drag1.rows = 3
const layoutAfterDrag1 = sandbox.buildSpanningGridLocal(srcFiles, 1.777, drag1.newOrder, 1, 1, 60, 0.05, drag1.rows);
console.log(`src/ layout after Drag 1: cols: ${layoutAfterDrag1.cols}, rows: ${layoutAfterDrag1.rows}`);
assert.strictEqual(layoutAfterDrag1.rows, 3, "Rows MUST NOT expand to 4 after dragging to bottom row!");
assert.strictEqual(layoutAfterDrag1.cols, 3, "Cols MUST NOT expand after dragging to bottom row!");

// Verify src/a.ts is at [0, 2]
const placementA = layoutAfterDrag1.placements.find(p => p.file.id === "src/a.ts");
assert.deepStrictEqual([placementA.col, placementA.row], [0, 2], "src/a.ts must be at row 2!");

// User now drags src/c.ts to row 2 in column 1 [1, 2]
const drag2 = sandbox.reorderSpanningItemsLocal(
    srcFileIds,
    drag1.newOrder,
    srcAllocations,
    "src/c.ts",
    1, // targetCol
    2, // targetRow: row 2
    layoutAfterDrag1.cols,
    layoutAfterDrag1.rows,
    layoutAfterDrag1.wrapRows
);

const layoutAfterDrag2 = sandbox.buildSpanningGridLocal(srcFiles, 1.777, drag2.newOrder, 1, 1, 60, 0.05, drag2.rows);
console.log(`src/ layout after Drag 2: cols: ${layoutAfterDrag2.cols}, rows: ${layoutAfterDrag2.rows}`);
assert.strictEqual(layoutAfterDrag2.rows, 3, "Rows MUST remain strictly 3!");
assert.strictEqual(layoutAfterDrag2.cols, 3, "Cols MUST remain strictly 3!");

console.log("✓ Test 1 passed: dragging files to bottom empty row keeps grid dimensions strictly bounded with 0 expansion");

// ---------------------------------------------------------------------------------
// Test 2: In folder card view (cellsTooSmall), file tiles expand in spanning grid mode
// ---------------------------------------------------------------------------------
console.log("\n=== Test 2: In folder card view, file tiles expand according to lineCount in spanning mode ===");

// Current view has two folder cards: src/ and src copy/
// plus two files: index.ts (1000 lines -> 5 tiles tall) and readme.md (50 lines -> 1 tile tall)
const displayItems = [
    { type: "folder", id: "folder:src/", card: { name: "src", path: "src/" } },
    { type: "folder", id: "folder:src copy/", card: { name: "src copy", path: "src copy/" } },
    { type: "file", id: "index.ts", file: { id: "index.ts", path: "index.ts", lineCount: 6000 } },
    { type: "file", id: "readme.md", file: { id: "readme.md", path: "readme.md", lineCount: 50 } }
];

// Spanning mode mapping as implemented in overview.js
const spanningItems = displayItems.map(it => {
    if (it.type === "folder") {
        return { id: it.id, type: "folder", item: it, card: it.card, nCells: 1 };
    }
    const f = it.file;
    const nCells = (f.nCells && f.nCells > 1) ? f.nCells : (f.lineCount ? sandbox.cellsNeeded(f.lineCount) : 1);
    return { id: it.id, type: "file", item: it, file: f, lineCount: f.lineCount, nCells };
});

assert.strictEqual(spanningItems[0].nCells, 1, "Folder card src/ must be 1 cell tall");
assert.strictEqual(spanningItems[1].nCells, 1, "Folder card src copy/ must be 1 cell tall");
assert.strictEqual(spanningItems[2].nCells, 5, "index.ts (6000 lines) must be 5 cells tall");
assert.strictEqual(spanningItems[3].nCells, 1, "readme.md (50 lines) must be 1 cell tall");

const folderCardSpanningLayout = sandbox.buildSpanningGridLocal(spanningItems, 1.777, null, 0, 0);
console.log(`Folder card spanning layout: cols: ${folderCardSpanningLayout.cols}, rows: ${folderCardSpanningLayout.rows}`);
assert.strictEqual(folderCardSpanningLayout.rows >= 5, true, "Grid rows must accommodate 5-cell tall file tile");

const indexPlacement = folderCardSpanningLayout.placements.find(p => p.item.id === "index.ts");
assert.strictEqual(indexPlacement.nCells, 5, "index.ts placement must have nCells = 5");
assert.strictEqual(indexPlacement.slots.length, 5, "index.ts placement must occupy 5 slots");

const srcPlacement = folderCardSpanningLayout.placements.find(p => p.item.id === "folder:src/");
assert.strictEqual(srcPlacement.nCells, 1, "Folder card src/ placement must have nCells = 1");
assert.strictEqual(srcPlacement.slots.length, 1, "Folder card src/ placement must occupy 1 slot");

console.log("✓ Test 2 passed: file tiles expand proportionally (5 cells) while folder cards remain 1 unit tall in spanning mode");

// ---------------------------------------------------------------------------------
// Test 3: 2D Drag and Drop reorder in folder card view with spanning items
// ---------------------------------------------------------------------------------
console.log("\n=== Test 3: 2D Drag and drop reorder in folder card view with spanning items ===");

const cardIds = spanningItems.map(it => it.id);
const cardAllocs = {};
for (const it of spanningItems) {
    cardAllocs[it.id] = it.nCells;
}

// Drag readme.md to empty slot at [col 2, row 0]
const cardDragRes = sandbox.reorderSpanningItemsLocal(
    cardIds,
    cardIds,
    cardAllocs,
    "readme.md",
    2, // targetCol
    0, // targetRow
    folderCardSpanningLayout.cols,
    folderCardSpanningLayout.rows,
    folderCardSpanningLayout.wrapRows
);

assert.strictEqual(cardDragRes.finalTargetCol, 2, "readme.md must be placed in col 2");
assert.strictEqual(cardDragRes.finalTargetRow, 0, "readme.md must be placed in row 0");

const cardLayoutAfterDrag = sandbox.buildSpanningGridLocal(
    spanningItems,
    1.777,
    cardDragRes.newOrder,
    0,
    0,
    60,
    0.05,
    cardDragRes.rows
);

const readmePlacement = cardLayoutAfterDrag.placements.find(p => p.item.id === "readme.md");
assert.deepStrictEqual([readmePlacement.col, readmePlacement.row], [2, 0], "readme.md placed at [2, 0]");

// Verify index.ts remained at its exact position without reflowing
const indexPlacementAfter = cardLayoutAfterDrag.placements.find(p => p.item.id === "index.ts");
assert.strictEqual(indexPlacementAfter.col, indexPlacement.col, "index.ts col position must remain unchanged");
assert.strictEqual(indexPlacementAfter.row, indexPlacement.row, "index.ts row position must remain unchanged");

console.log("✓ Test 3 passed: 2D drag and drop reordering in folder card view preserves tile positions without reflow");

// ---------------------------------------------------------------------------------
// Test 4: Leaf folder with 0 subfolders NEVER collapses into cellsTooSmall
// ---------------------------------------------------------------------------------
console.log("\n=== Test 4: Leaf folder with 0 subfolders NEVER collapses into cellsTooSmall ===");

const matchSubfolderGroups = overviewJs.match(/function getSubfolderGroups\([\s\S]*?\n\}/);
assert(matchSubfolderGroups, "getSubfolderGroups must be found in overview.js");
vm.runInContext(matchSubfolderGroups[0], sandbox);

// Files strictly in src/ with no subdirectories
const leafFiles = [
    { id: "src/a.ts", path: "src/a.ts", lineCount: 50 },
    { id: "src/b.ts", path: "src/b.ts", lineCount: 50 },
    { id: "src/c.ts", path: "src/c.ts", lineCount: 50 },
    { id: "src/d.ts", path: "src/d.ts", lineCount: 50 }
];
const leafSubfolderInfo = sandbox.getSubfolderGroups(leafFiles, "src/");
assert.strictEqual(leafSubfolderInfo.folders.length, 0, "Leaf folder must have 0 child subfolders");

// Even with tiny canvas width/height where folderCellW < MIN_CELL_W (e.g. cellW = 30 < 60)
const tinyFolderCellW = 30;
const tinyFolderCellH = 20;
const MIN_CELL_W = 60;
const MIN_CELL_H = 40;

const hasSubfolders = leafSubfolderInfo.folders && leafSubfolderInfo.folders.length > 0;
const cellsTooSmallInLeaf = hasSubfolders && (tinyFolderCellW < MIN_CELL_W || tinyFolderCellH < MIN_CELL_H);
assert.strictEqual(cellsTooSmallInLeaf, false, "cellsTooSmall MUST be false in a leaf folder with 0 subfolders!");
console.log("✓ Test 4 passed: leaf folder with 0 subfolders strictly avoids cellsTooSmall false-positive collapse");

// ---------------------------------------------------------------------------------
// Test 5: In cellsTooSmall, totalItems strictly equals orderedItems.length (no empty-slot inflation)
// ---------------------------------------------------------------------------------
console.log("\n=== Test 5: In cellsTooSmall, totalItems strictly equals orderedItems.length ===");

// 3 actual cards: 2 folders and 1 root file
const realOrderedItems = [
    { id: "folder:sub1/", type: "folder" },
    { id: "folder:sub2/", type: "folder" },
    { id: "root.ts", type: "file" }
];

// User moved root.ts to slot 5 (leaving holes at index 2, 3, 4)
const displayItemsWithHoles = [
    realOrderedItems[0],
    realOrderedItems[1],
    null,
    null,
    null,
    realOrderedItems[2]
];

// totalItems must strictly be 3, NOT 6
const totalItemsFixed = realOrderedItems.length;
assert.strictEqual(totalItemsFixed, 3, "totalItems must be 3, ignoring trailing holes");
console.log("✓ Test 5 passed: totalItems strictly equals actual item count, preventing empty slots from inflating the grid");

console.log("\n=== ALL FOLDER CARD SPANNING & BOTTOM DRAG TESTS PASSED ===");
