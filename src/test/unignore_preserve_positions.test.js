const assert = require("assert");
const { buildSpanningGrid, integrateNewFilesPreservingPositions } = require("../../out/spanning_layout");

console.log("=== Test Suite: Unignore Preserves Existing Positions ===");

function mockFile(id, path, lineCount = 50) {
    return {
        id,
        path,
        uri: "file:///" + path,
        lineCount,
        lines: new Array(Math.min(lineCount, 50)).fill({ text: "const x = 1;", indent: 0, length: 12, category: "normal" })
    };
}

// Create 10 initial files
const initialFiles = [];
for (let i = 0; i < 10; i++) {
    initialFiles.push(mockFile(`init_${i}`, `src/init_${i}.ts`));
}
const initialOrder = initialFiles.map(f => f.id);
const initialAllocs = {};
initialFiles.forEach(f => { initialAllocs[f.id] = 1; });

// Initial layout with 2 rows: 5 cols x 2 rows
const initialLayout = buildSpanningGrid(initialFiles, initialOrder, initialAllocs, 2);
console.log("Initial layout rows:", initialLayout.rows, "cols:", initialLayout.cols);
const initialPositions = new Map();
for (const p of initialLayout.placements) {
    initialPositions.set(p.file.id, { col: p.col, row: p.row });
}
console.log("Sample initial positions:", [
    initialPositions.get("init_0"),
    initialPositions.get("init_1"),
    initialPositions.get("init_2"),
    initialPositions.get("init_3")
]);

// Now unignore 40 new files (total 50 files)
const newFiles = [];
for (let i = 0; i < 40; i++) {
    newFiles.push(mockFile(`new_${i}`, `folder/new_${i}.ts`));
}
const allFiles = [...initialFiles, ...newFiles];
const allAllocs = { ...initialAllocs };
newFiles.forEach(f => { allAllocs[f.id] = 1; });

// Integrate new files preserving existing positions
const { newOrder, wrapRows } = integrateNewFilesPreservingPositions(
    initialLayout.placements,
    newFiles.map(f => f.id),
    allAllocs,
    16 / 9
);

console.log("New wrapRows:", wrapRows);
const newLayout = buildSpanningGrid(allFiles, newOrder, allAllocs, wrapRows);
console.log("New layout rows:", newLayout.rows, "cols:", newLayout.cols);

// Verification 1: ALL 10 initial files MUST maintain their exact col and row!
for (const [id, initialPos] of initialPositions.entries()) {
    const newPos = newLayout.placements.find(p => p.file.id === id);
    assert(newPos, `File ${id} must exist in new layout`);
    assert.strictEqual(
        newPos.col,
        initialPos.col,
        `File ${id} col should not reflow! Initial col: ${initialPos.col}, new col: ${newPos.col}`
    );
    assert.strictEqual(
        newPos.row,
        initialPos.row,
        `File ${id} row should not reflow! Initial row: ${initialPos.row}, new row: ${newPos.row}`
    );
}
console.log("✓ Verified: All 10 existing files maintained their exact positions!");

// Verification 2: New files are placed below (row >= 2 in cols 0..4) AND to the right (col >= 5)
let placedBelow = 0;
let placedToRight = 0;
for (const f of newFiles) {
    const p = newLayout.placements.find(item => item.file.id === f.id);
    assert(p, `New file ${f.id} must be placed`);
    if (p.col < 5 && p.row >= 2) {
        placedBelow++;
    }
    if (p.col >= 5) {
        placedToRight++;
    }
}
console.log(`New files placed below existing cards: ${placedBelow}, placed to the right: ${placedToRight}`);
assert(placedBelow > 0, "New files must be placed in empty rows below existing cards");
assert(placedToRight > 0, "New files must be placed in new columns to the right");

console.log("✓ ALL UNIGNORE PRESERVE POSITIONS TESTS PASSED");
