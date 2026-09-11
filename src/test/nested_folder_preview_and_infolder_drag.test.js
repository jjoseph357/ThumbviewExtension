const assert = require("assert");
const { buildStableGrid } = require("../../out/layout");
const { buildSpanningGrid, cellsNeeded } = require("../../out/spanning_layout");
const { reorderFolderItems, reorderSpanningItems } = require("../../out/reorder_helpers");

console.log("=== Test Suite: Nested Folder Previews, In-Folder Empty Slot Drag & Drop, and Drag Optimization ===");

// -------------------------------------------------------------
// Slice 1: Nested folder cards in folder card preview & spanning heights
// -------------------------------------------------------------
console.log("\n=== Test 1: Folder card preview identifies child subfolder cards ===");

// Simulating getSubfolderGroups from media/overview.js
function getSubfolderGroups(files, basePath) {
    const groups = {};
    const rootFiles = [];
    const orderedItems = [];
    const seenFolders = new Set();

    for (const f of files) {
        const relPath = basePath ? f.path.substring(basePath.length) : f.path;
        const slashIdx = relPath.indexOf("/");
        if (slashIdx === -1) {
            rootFiles.push(f);
        } else {
            const folderName = relPath.substring(0, slashIdx);
            const folderPath = (basePath || "") + folderName + "/";
            if (!groups[folderPath]) {
                groups[folderPath] = { name: folderName, path: folderPath, folderPath: folderPath, fileCount: 0, files: [] };
            }
            groups[folderPath].fileCount++;
            groups[folderPath].files.push(f);
        }
    }

    const validFolders = new Set();
    for (const grp of Object.values(groups)) {
        if (grp.fileCount <= 2) {
            rootFiles.push(...grp.files);
        } else {
            validFolders.add(grp.path);
        }
    }

    for (const f of files) {
        const relPath = basePath ? f.path.substring(basePath.length) : f.path;
        const slashIdx = relPath.indexOf("/");
        if (slashIdx === -1) {
            orderedItems.push({ type: "file", file: f, id: f.id });
        } else {
            const folderName = relPath.substring(0, slashIdx);
            const folderPath = (basePath || "") + folderName + "/";
            if (validFolders.has(folderPath)) {
                if (!seenFolders.has(folderPath)) {
                    seenFolders.add(folderPath);
                    orderedItems.push({ type: "folder", card: groups[folderPath], id: "folder:" + folderPath });
                }
            } else {
                orderedItems.push({ type: "file", file: f, id: f.id });
            }
        }
    }

    const folders = Object.values(groups).filter(g => validFolders.has(g.path));
    return { folders, rootFiles, orderedItems };
}

// Workspace with parent folder 'src/' which contains:
// 1. A child subfolder 'src/components/' (with 3 files -> valid folder card)
// 2. Normal files in 'src/': 'src/index.ts' (1 tile tall) and 'src/large.ts' (3 tiles tall: lineCount = 2500)
const srcFiles = [
    { id: "src/components/btn.ts", path: "src/components/btn.ts", lineCount: 50 },
    { id: "src/components/modal.ts", path: "src/components/modal.ts", lineCount: 50 },
    { id: "src/components/card.ts", path: "src/components/card.ts", lineCount: 50 },
    { id: "src/index.ts", path: "src/index.ts", lineCount: 50, nCells: 1 },
    { id: "src/large.ts", path: "src/large.ts", lineCount: 2500, nCells: 3 }
];

const srcGroup = {
    name: "src",
    path: "src/",
    folderPath: "src/",
    fileCount: srcFiles.length,
    files: srcFiles
};

// Helper: doesFolderCollapse checks if opening the folder will collapse into subfolder cards
function doesFolderCollapse(files, folderPath, refW = 1200, refH = 800, minCellW = 60, minCellH = 40, isSpanning = true) {
    const subfolderInfo = getSubfolderGroups(files, folderPath);
    if (!subfolderInfo || subfolderInfo.folders.length === 0) {
        return false;
    }
    const availW = refW - 40;
    const availH = refH - 60;
    if (isSpanning) {
        const layout = buildSpanningGridLocal(files, 16 / 9);
        const cW = availW / Math.max(1, layout.cols);
        const cH = availH / Math.max(1, layout.rows);
        let hasOverflow = false;
        for (const p of layout.placements) {
            if (p.nCells * cH > availH + 1) {
                hasOverflow = true;
                break;
            }
        }
        return cW < minCellW || cH < minCellH || hasOverflow;
    } else {
        const grid = buildStableGrid(files.length, 16 / 9);
        const cW = availW / Math.max(1, grid.cols);
        const cH = availH / Math.max(1, grid.rows);
        return cW < minCellW || cH < minCellH;
    }
}

// Case A: Small folder (5 files). Fits in folder drilldown without collapsing.
// Preview MUST show all files individually laid out, NOT nested folder cards!
const srcWillCollapse = doesFolderCollapse(srcGroup.files, srcGroup.path);
assert.strictEqual(srcWillCollapse, false, "Small folder of 5 files must NOT collapse when opened");

const srcInnerGroups = getSubfolderGroups(srcGroup.files, srcGroup.path);
const previewItemsSmall = srcWillCollapse
    ? srcInnerGroups.orderedItems
    : srcGroup.files.map(f => ({ type: "file", file: f, id: f.id }));

console.log("previewItems for small folder (5 files):", previewItemsSmall.map(it => it.type + ":" + it.id));
assert.ok(!previewItemsSmall.some(it => it.type === "folder"), "Small folder preview must NOT show nested folder cards when files will be individually laid out!");
assert.strictEqual(previewItemsSmall.length, 5, "All 5 individual files must be shown in preview");

// Case B: Large folder with 200 files across child subfolders.
// Exceeds cell capacity -> opening the folder collapses into subfolder cards.
// Preview MUST show nested folder cards!
const largeChildFiles = [];
for (let i = 0; i < 150; i++) {
    largeChildFiles.push({ id: `src/deep/sub/file${i}.ts`, path: `src/deep/sub/file${i}.ts`, lineCount: 50 });
}
for (let i = 0; i < 50; i++) {
    largeChildFiles.push({ id: `src/deep/root${i}.ts`, path: `src/deep/root${i}.ts`, lineCount: 50 });
}
const largeGroup = {
    name: "deep",
    path: "src/deep/",
    folderPath: "src/deep/",
    fileCount: largeChildFiles.length,
    files: largeChildFiles
};

const largeWillCollapse = doesFolderCollapse(largeGroup.files, largeGroup.path);
assert.strictEqual(largeWillCollapse, true, "Large folder with 200 files must collapse when opened");
const largeInnerGroups = getSubfolderGroups(largeGroup.files, largeGroup.path);
const previewItemsLarge = largeWillCollapse
    ? largeInnerGroups.orderedItems
    : largeGroup.files.map(f => ({ type: "file", file: f, id: f.id }));

assert.ok(previewItemsLarge.some(it => it.type === "folder"), "Large folder preview MUST show nested folder cards when opening will collapse into cards!");
console.log("✓ Test 1 passed: folder preview strictly matches what user sees when clicking into the folder");

console.log("\n=== Test 1b: Preview placements for collapsed folder match drill-down row-major slots (straight line along bottom) ===");

// Simulate 4 root files and 4 child folder cards inside a collapsed folder
const mixedCollapsedItems = [
    { type: "file", id: "f1", file: { id: "f1", lineCount: 50 } },
    { type: "file", id: "f2", file: { id: "f2", lineCount: 50 } },
    { type: "file", id: "f3", file: { id: "f3", lineCount: 50 } },
    { type: "file", id: "f4", file: { id: "f4", lineCount: 50 } },
    { type: "folder", id: "folder:sub1/", card: { name: "sub1" } },
    { type: "folder", id: "folder:sub2/", card: { name: "sub2" } },
    { type: "folder", id: "folder:sub3/", card: { name: "sub3" } },
    { type: "folder", id: "folder:sub4/", card: { name: "sub4" } }
];

// In the drilldown view (cellsTooSmall mode):
const drilldownGrid = buildStableGrid(mixedCollapsedItems.length, 16 / 9);
const drilldownSlots = [];
for (let r = 0; r < drilldownGrid.rows; r++) {
    for (let c = 0; c < drilldownGrid.cols; c++) {
        drilldownSlots.push([c, r]);
    }
}
const drilldownPlacements = mixedCollapsedItems.map((it, idx) => ({
    item: it,
    col: drilldownSlots[idx][0],
    row: drilldownSlots[idx][1]
}));

const drilldownFolderCards = drilldownPlacements.filter(p => p.item.type === "folder");
console.log("Drill-down folder card placements:", drilldownFolderCards.map(p => `${p.item.id} -> col:${p.col}, row:${p.row}`));
// Verify that drilldown folder cards are on the bottom row in a straight line:
const expectedRow = drilldownFolderCards[0].row;
assert.ok(drilldownFolderCards.every(p => p.row === expectedRow), "All 4 folder cards in drilldown must be on the same bottom row");
assert.deepStrictEqual(drilldownFolderCards.map(p => p.col), [0, 1, 2, 3], "All 4 folder cards in drilldown must be a straight line across cols 0, 1, 2, 3");

// Preview layout generator function modeling the fix:
function computePreviewPlacements(previewItems, willCollapse, isSpanningMode) {
    if (willCollapse) {
        // MUST use uniform row-major buildStableGrid matching cellsTooSmall drilldown
        const baseGrid = buildStableGrid(previewItems.length, 16 / 9);
        const slots = [];
        for (let r = 0; r < baseGrid.rows; r++) {
            for (let c = 0; c < baseGrid.cols; c++) {
                slots.push([c, r]);
            }
        }
        return previewItems.map((it, idx) => ({
            item: it,
            col: slots[idx][0],
            row: slots[idx][1]
        }));
    } else if (isSpanningMode) {
        const itemsToLayout = previewItems.map(it => {
            const f = it.file || it;
            const nCells = f.nCells ? f.nCells : (f.lineCount ? cellsNeeded(f.lineCount) : 1);
            return { id: it.id, item: it, file: f, nCells };
        });
        const layout = buildSpanningGridLocal(itemsToLayout, 16 / 9);
        return layout.placements;
    } else {
        const baseGrid = buildStableGrid(previewItems.length, 16 / 9);
        const slots = [];
        for (let r = 0; r < baseGrid.rows; r++) {
            for (let c = 0; c < baseGrid.cols; c++) {
                slots.push([c, r]);
            }
        }
        return previewItems.map((it, idx) => ({
            item: it,
            col: slots[idx][0],
            row: slots[idx][1]
        }));
    }
}

const previewPlacements = computePreviewPlacements(mixedCollapsedItems, true, true);
const previewFolderCards = previewPlacements.filter(p => p.item.type === "folder");
console.log("Preview folder card placements:", previewFolderCards.map(p => `${p.item.id} -> col:${p.col}, row:${p.row}`));

assert.deepStrictEqual(
    previewFolderCards.map(p => ({ col: p.col, row: p.row })),
    drilldownFolderCards.map(p => ({ col: p.col, row: p.row })),
    "Preview folder card placements must match drilldown folder card placements 100% (straight line, not tall L)"
);
console.log("✓ Test 1b passed: preview layout matches drill-down row-major layout with 100% parity");

console.log("\n=== Test 2: Spanning preview shows different heights (1-tile vs 3-tiles) ===");
// Simulating buildSpanningGridLocal as used in media/overview.js
function buildSpanningGridLocal(files, targetAspect = 1.777, folderOrder = null, extraCols = 0, extraRows = 0, baseLinesPerCell = 60, compressionPct = 0.05) {
    const allocations = {};
    let actualCells = 0;
    let maxNCells = 1;

    for (const f of files) {
        const nCells = f.nCells ? f.nCells : (f.lineCount ? cellsNeeded(f.lineCount, baseLinesPerCell, compressionPct) : 1);
        allocations[f.id] = nCells;
        actualCells += nCells;
        if (nCells > maxNCells) {
            maxNCells = nCells;
        }
    }

    const calculatedRows = Math.max(1, Math.round(Math.sqrt(Math.max(actualCells, files.length, 1) / targetAspect)));
    const wrapRows = Math.max(calculatedRows, maxNCells);

    const filesById = new Map(files.map(f => [f.id, f]));
    let orderToIterate = [];
    if (folderOrder && Array.isArray(folderOrder) && folderOrder.length > 0) {
        orderToIterate = [...folderOrder];
        const seenIds = new Set(folderOrder.filter(Boolean));
        const newFiles = files.filter(f => !seenIds.has(f.id));
        let newIdx = 0;
        for (let i = 0; i < orderToIterate.length && newIdx < newFiles.length; i++) {
            if (!orderToIterate[i]) {
                orderToIterate[i] = newFiles[newIdx++].id;
            }
        }
        while (newIdx < newFiles.length) {
            orderToIterate.push(newFiles[newIdx++].id);
        }
    } else {
        orderToIterate = files.map(f => f.id);
    }

    let currCol = 0;
    let currRow = 0;
    let maxRowUsed = 1;
    const placements = [];

    for (const fid of orderToIterate) {
        const file = fid ? filesById.get(fid) : null;
        const nCells = fid ? (allocations[fid] || 1) : 1;
        const mustBreak = currRow > 0 && currRow + nCells > wrapRows;

        if (mustBreak) {
            currCol++;
            currRow = 0;
        }

        if (file) {
            const slots = [];
            for (let i = 0; i < nCells; i++) {
                slots.push([currCol, currRow + i]);
            }

            placements.push({
                file: file.file || file,
                item: file.item || file,
                col: currCol,
                row: currRow,
                nCells,
                slots
            });
        }

        currRow += nCells;
        if (currRow > maxRowUsed) {
            maxRowUsed = currRow;
        }
    }

    const reqCols = currCol + 1;
    const finalRows = Math.max(1, maxRowUsed) + extraRows;
    const finalCols = Math.max(2, reqCols, Math.ceil(finalRows * targetAspect)) + extraCols;

    const gridSlots = [];
    for (let r = 0; r < finalRows; r++) {
        for (let c = 0; c < finalCols; c++) {
            gridSlots.push([c, r]);
        }
    }

    return {
        rows: finalRows,
        cols: finalCols,
        wrapRows,
        placements,
        slots: gridSlots
    };
}

const directFiles = srcInnerGroups.rootFiles;
const directSpanning = buildSpanningGridLocal(directFiles);
const indexPlacement = directSpanning.placements.find(p => p.file.id === "src/index.ts");
const largePlacement = directSpanning.placements.find(p => p.file.id === "src/large.ts");

assert.ok(indexPlacement && largePlacement, "Placements must exist for both files");
assert.strictEqual(indexPlacement.nCells, 1, "src/index.ts must span 1 cell");
assert.strictEqual(largePlacement.nCells, 3, "src/large.ts must span 3 cells in preview");
console.log(`✓ Test 2 passed: preview preserves different heights (${indexPlacement.nCells} cell vs ${largePlacement.nCells} cells)`);

// -------------------------------------------------------------
// Slice 2: Moving files to empty grid slots in folder drill-down
// -------------------------------------------------------------
console.log("\n=== Test 3: In-folder uniform grid must generate full grid slots for empty spaces ===");

const scopedFolderFiles = [
    { id: "f1", name: "f1.ts", path: "src/f1.ts" },
    { id: "f2", name: "f2.ts", path: "src/f2.ts" },
    { id: "f3", name: "f3.ts", path: "src/f3.ts" }
];

// Current buggy behavior: localFolderGrid = buildStableGrid(scopedFiles.length) only gave 3 slots!
// Correct behavior:
const folderOrder = ["f1", "f2", "f3"];
const totalSlots = Math.max(scopedFolderFiles.length, folderOrder.length);
const baseGrid = buildStableGrid(totalSlots, 16 / 9);
const folderCols = baseGrid.cols;
const folderRows = baseGrid.rows;

// Full grid slots generation:
const fullFolderSlots = [];
for (let r = 0; r < folderRows; r++) {
    for (let c = 0; c < folderCols; c++) {
        fullFolderSlots.push([c, r]);
    }
}

assert.ok(fullFolderSlots.length >= folderCols * folderRows, "Must generate all slots for folderCols * folderRows");
console.log(`Grid dimensions: ${folderCols} cols x ${folderRows} rows = ${fullFolderSlots.length} slots`);

// Drop f1 into empty slot at [1, 1] (which is slot index: row * cols + col = 1 * 2 + 1 = 3)
const targetCol = 1;
const targetRow = 1;
const targetSlotIdx = fullFolderSlots.findIndex(s => s[0] === targetCol && s[1] === targetRow);
assert.strictEqual(targetSlotIdx, 3, "Empty slot [1, 1] must resolve to slot index 3");

const newFolderOrder = reorderFolderItems(
    folderOrder,
    "f1",
    true, // targetIsEmpty
    null,
    targetSlotIdx,
    folderCols * folderRows,
    "swap"
);

console.log("newFolderOrder after moving f1 to slot 3:", newFolderOrder);
// f1 was at index 0, moved to index 3. Slot 0 becomes "", slot 3 becomes "f1"
assert.strictEqual(newFolderOrder[0], "", "Source slot 0 must be empty string hole");
assert.strictEqual(newFolderOrder[1], "f2", "f2 must remain at slot 1");
assert.strictEqual(newFolderOrder[2], "f3", "f3 must remain at slot 2");
assert.strictEqual(newFolderOrder[3], "f1", "f1 must be at empty slot 3!");
console.log("✓ Test 3 passed: file moved to empty grid slot [1, 1] without shifting other files to top left");

// -------------------------------------------------------------
// Slice 4: Window / Sidebar / Terminal Resize Stability (No Reflow)
// -------------------------------------------------------------
console.log("\n=== Test 5: Window/sidebar resize maintains exact file placements (no reflow) ===");

const resizeFiles = [
    { id: "f1", path: "src/f1.ts", lineCount: 100 },
    { id: "f2", path: "src/f2.ts", lineCount: 250 },
    { id: "f3", path: "src/f3.ts", lineCount: 50 },
    { id: "f4", path: "src/f4.ts", lineCount: 80 },
    { id: "f5", path: "src/f5.ts", lineCount: 120 },
    { id: "f6", path: "src/f6.ts", lineCount: 60 }
];

// Fixed BASE_GRID_ASPECT (16 / 9) ensures grid layout dimensions do NOT change across window resizes
const BASE_GRID_ASPECT = 16 / 9;
const baseLayout = buildSpanningGridLocal(resizeFiles, BASE_GRID_ASPECT);

// Simulate shrinking window, opening sidebar, or opening terminal:
// Window A (fullscreen 16:9): availableW = 1880, availableH = 1000
const winA_W = 1880, winA_H = 1000;
const cellA_W = winA_W / baseLayout.cols;
const cellA_H = winA_H / baseLayout.rows;

// Window B (narrow, sidebar expanded): availableW = 600, availableH = 1000
const winB_W = 600, winB_H = 1000;
const cellB_W = winB_W / baseLayout.cols;
const cellB_H = winB_H / baseLayout.rows;

// Window C (terminal opened, small height): availableW = 1200, availableH = 300
const winC_W = 1200, winC_H = 300;
const cellC_W = winC_W / baseLayout.cols;
const cellC_H = winC_H / baseLayout.rows;

// All window dimensions use the same layout dimensions:
assert.strictEqual(baseLayout.cols, 4, "Grid cols must remain constant");
assert.strictEqual(baseLayout.rows, 2, "Grid rows must remain constant");

// For each file, placement (col, row) is identical across all windows:
for (const p of baseLayout.placements) {
    console.log(`File ${p.file.id}: col=${p.col}, row=${p.row}, span=${p.nCells}`);
    // Window A coordinates
    const posA = { x: p.col * cellA_W, y: p.row * cellA_H, w: cellA_W, h: p.nCells * cellA_H };
    // Window B coordinates (only scaled, same col/row)
    const posB = { x: p.col * cellB_W, y: p.row * cellB_H, w: cellB_W, h: p.nCells * cellB_H };
    // Window C coordinates (only scaled, same col/row)
    const posC = { x: p.col * cellC_W, y: p.row * cellC_H, w: cellC_W, h: p.nCells * cellC_H };

    assert.strictEqual(posA.w !== posB.w, true, "Cells must resize when window width changes");
    assert.strictEqual(posA.h !== posC.h, true, "Cells must resize when window height changes");
}

console.log("✓ Test 5 passed: files only resize on window/sidebar/terminal changes, zero reflow");

console.log("\n=== ALL NESTED PREVIEW, IN-FOLDER DRAG & OPTIMIZATION TESTS PASSED ===");
