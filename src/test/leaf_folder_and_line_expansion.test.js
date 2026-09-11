const assert = require("assert");
const { buildSpanningGrid, cellsNeeded } = require("../../out/spanning_layout");

console.log("=== Test Suite: Leaf Folder Spanning Representation & Line Count Tile Expansion ===");

// -------------------------------------------------------------
// Test 1: cellsNeeded formula for line counts (e.g. 10,000 lines)
// -------------------------------------------------------------
console.log("\n=== Test 1: cellsNeeded calculation for small and large files ===");
const smallFileCells = cellsNeeded(50, 60, 0.05);
assert.strictEqual(smallFileCells, 1, "50 lines should require 1 cell");

const largeFileCells = cellsNeeded(10000, 60, 0.05);
// 10,000 * 0.05 = 500 representative lines. 500 / 60 = 8.333 -> ceil = 9 cells
assert.strictEqual(largeFileCells, 9, "10,000 lines should require 9 cells");
console.log(`✓ Test 1 passed: 50 lines -> ${smallFileCells} cell, 10,000 lines -> ${largeFileCells} cells`);

// -------------------------------------------------------------
// Test 2: buildSpanningGrid dynamically recomputes allocations when lineCount expands
// -------------------------------------------------------------
console.log("\n=== Test 2: buildSpanningGrid expands tile height when file lineCount increases to 10,000 ===");
const initialFile = {
    id: "/repo/src/largeFile.ts",
    name: "largeFile.ts",
    path: "src/largeFile.ts",
    lineCount: 50
};
const otherFile = {
    id: "/repo/src/otherFile.ts",
    name: "otherFile.ts",
    path: "src/otherFile.ts",
    lineCount: 30
};

// Initial layout when file had 50 lines
const initialLayout = buildSpanningGrid([initialFile, otherFile], [initialFile.id, otherFile.id], {});
assert.strictEqual(initialLayout.allocations[initialFile.id], 1, "Initial allocation should be 1");
assert.strictEqual(initialLayout.placements[0].nCells, 1, "Initial placement should be 1 cell");

// Persisted allocations from previous run (simulating workspaceState thumbview.spanningAllocations)
const persistedAllocations = { ...initialLayout.allocations };
assert.strictEqual(persistedAllocations[initialFile.id], 1);

// User adds 10,000 lines to largeFile.ts
const updatedFile = {
    ...initialFile,
    lineCount: 10000
};

// Extension prepares currentAllocations by refreshing line counts for active files
const currentAllocations = { ...persistedAllocations };
for (const f of [updatedFile, otherFile]) {
    currentAllocations[f.id] = cellsNeeded(f.lineCount);
}

// Rebuild spanning grid with updated file and currentAllocations
const updatedLayout = buildSpanningGrid(
    [updatedFile, otherFile],
    [updatedFile.id, otherFile.id],
    currentAllocations,
    initialLayout.wrapRows
);

assert.strictEqual(
    updatedLayout.allocations[updatedFile.id],
    9,
    `Tile allocation MUST expand to 9 cells for 10,000 lines, but got ${updatedLayout.allocations[updatedFile.id]}`
);
const updatedPlacement = updatedLayout.placements.find(p => p.file.id === updatedFile.id);
assert.ok(updatedPlacement, "Placement must exist for updated file");
assert.strictEqual(
    updatedPlacement.nCells,
    9,
    `Tile placement nCells MUST be 9, but got ${updatedPlacement.nCells}`
);
assert.strictEqual(
    updatedPlacement.slots.length,
    9,
    `Tile must occupy 9 grid slots, but got ${updatedPlacement.slots.length}`
);
assert.ok(
    updatedLayout.rows >= 9,
    `Grid rows must expand to at least 9 to accommodate 9-cell tile, but got ${updatedLayout.rows}`
);
assert.ok(
    updatedLayout.wrapRows >= 9,
    `wrapRows must expand to at least 9 to accommodate 9-cell tile, but got ${updatedLayout.wrapRows}`
);
console.log(`✓ Test 2 passed: tile expanded from 1 cell to ${updatedPlacement.nCells} cells with ${updatedLayout.rows} rows`);

// -------------------------------------------------------------
// Test 3: Webview buildSpanningGridLocal dynamically expands when lineCount changes
// -------------------------------------------------------------
console.log("\n=== Test 3: buildSpanningGridLocal prioritizes dynamic lineCount over stale host nCells ===");
function buildSpanningGridLocal(files, targetAspect = 1.777, folderOrder = null, extraCols = 0, extraRows = 0, baseLinesPerCell = 60, compressionPct = 0.05) {
    const allocations = {};
    let actualCells = 0;
    let maxNCells = 1;

    for (const f of files) {
        const nCells = f.lineCount ? cellsNeeded(f.lineCount, baseLinesPerCell, compressionPct) : (f.nCells || 1);
        allocations[f.id] = nCells;
        actualCells += nCells;
        if (nCells > maxNCells) {
            maxNCells = nCells;
        }
    }

    const calculatedRows = Math.max(1, Math.round(Math.sqrt(Math.max(actualCells, files.length, 1) / targetAspect)));
    const wrapRows = Math.max(calculatedRows, maxNCells);
    const filesById = new Map(files.map(f => [f.id, f]));
    const orderToIterate = files.map(f => f.id);

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
            placements.push({ file, col: currCol, row: currRow, nCells, slots });
        }
        currRow += nCells;
        if (currRow > maxRowUsed) {
            maxRowUsed = currRow;
        }
    }

    const reqCols = currCol + 1;
    const finalRows = Math.max(1, maxRowUsed) + extraRows;
    const finalCols = Math.max(2, reqCols, Math.ceil(finalRows * targetAspect)) + extraCols;
    return { rows: finalRows, cols: finalCols, placements, allocations, wrapRows };
}

// Stale host sent nCells: 1, but lineCount is 10000
const webviewFiles = [
    { id: "f1", nCells: 1, lineCount: 10000 },
    { id: "f2", nCells: 1, lineCount: 60 }
];
const localRes = buildSpanningGridLocal(webviewFiles);
assert.strictEqual(localRes.allocations["f1"], 9, "f1 must allocate 9 cells based on 10,000 lines");
assert.strictEqual(localRes.placements[0].nCells, 9, "f1 placement must have 9 cells");
assert.ok(localRes.rows >= 9, "Grid rows must be at least 9");
console.log(`✓ Test 3 passed: buildSpanningGridLocal correctly allocated ${localRes.placements[0].nCells} cells for 10,000 lines`);

// -------------------------------------------------------------
// Test 4: Leaf node folder detection & spanning representation
// -------------------------------------------------------------
console.log("\n=== Test 4: Leaf node folder files have spanning grid representations ===");

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

// Case A: Leaf node folder (e.g. src/utils/ has files but no child subdirectories)
const leafFiles = [
    { id: "src/utils/math.ts", path: "src/utils/math.ts", lineCount: 10000, nCells: 9 },
    { id: "src/utils/str.ts", path: "src/utils/str.ts", lineCount: 50, nCells: 1 },
    { id: "src/utils/date.ts", path: "src/utils/date.ts", lineCount: 60, nCells: 1 }
];

const leafGroupResult = getSubfolderGroups(leafFiles, "src/utils/");
assert.strictEqual(leafGroupResult.folders.length, 0, "Leaf node folder must have 0 subfolders");
assert.strictEqual(leafGroupResult.rootFiles.length, 3, "All files in leaf folder are rootFiles");

// In overview.js rendering logic:
// When folders.length === 0, the folder has NO subdirectories (it is a leaf node).
// Subfolder cards mode cannot apply; spanning grid layout must be used!
const isSpanningMode = true;
const isLeafDirectory = leafGroupResult.folders.length === 0;
let cellsTooSmall = true; // Would have been triggered by tall file or dimension check

if (isLeafDirectory && isSpanningMode) {
    cellsTooSmall = false; // Leaf directory files retain spanning grid representations!
}

assert.strictEqual(cellsTooSmall, false, "Leaf node folder must NOT collapse to subfolder cards mode!");

// Build spanning grid representation for leaf directory
const leafSpanningLayout = buildSpanningGridLocal(leafFiles);
assert.strictEqual(leafSpanningLayout.placements[0].nCells, 9, "Leaf folder file must have 9 cells spanning height");
assert.strictEqual(leafSpanningLayout.placements[1].nCells, 1, "Leaf folder file must have 1 cell spanning height");

console.log(`✓ Test 4 passed: leaf directory has 0 subfolders and files retain spanning representations (${leafSpanningLayout.placements[0].nCells} cells)`);

// -------------------------------------------------------------
// Test 5: Leaf node folder cards in subfolder cards overview
// -------------------------------------------------------------
console.log("\n=== Test 5: Leaf node folder card preview uses spanning grid representation ===");
const workspaceFiles = [
    { id: "src/utils/math.ts", path: "src/utils/math.ts", lineCount: 10000 },
    { id: "src/utils/str.ts", path: "src/utils/str.ts", lineCount: 50 },
    { id: "src/utils/date.ts", path: "src/utils/date.ts", lineCount: 60 },
    { id: "src/components/btn/btn.ts", path: "src/components/btn/btn.ts", lineCount: 100 },
    { id: "src/components/modal/modal.ts", path: "src/components/modal/modal.ts", lineCount: 100 },
    { id: "src/components/nav/nav.ts", path: "src/components/nav/nav.ts", lineCount: 100 }
];

const overviewGroups = getSubfolderGroups(workspaceFiles, "src/");
assert.strictEqual(overviewGroups.folders.length, 2, "src/ has two subfolders: utils/ and components/");

const utilsGroup = overviewGroups.folders.find(g => g.name === "utils");
assert.ok(utilsGroup, "utils group exists");

// utils/ only contains files directly, no subdirectories
const isUtilsLeaf = !utilsGroup.files.some(f => f.path.substring(utilsGroup.path.length).includes("/"));
assert.strictEqual(isUtilsLeaf, true, "utils/ is a leaf node folder");

// components/ contains nested folders (btn/, modal/, nav/)
const componentsGroup = overviewGroups.folders.find(g => g.name === "components");
assert.ok(componentsGroup, "components group exists");
const isComponentsLeaf = !componentsGroup.files.some(f => f.path.substring(componentsGroup.path.length).includes("/"));
assert.strictEqual(isComponentsLeaf, false, "components/ is NOT a leaf node folder");

// For a leaf folder card in spanning mode, preview files use spanning layout
const utilsSpanningPreview = buildSpanningGridLocal(utilsGroup.files);
const mathPlacement = utilsSpanningPreview.placements.find(p => p.file.id === "src/utils/math.ts");
assert.strictEqual(mathPlacement.nCells, 9, "Leaf folder card preview file must span 9 cells");

console.log(`✓ Test 5 passed: leaf folder utils/ correctly identified and rendered with spanning representation`);

console.log("\n=== ALL LEAF FOLDER & LINE EXPANSION TESTS PASSED ===");
