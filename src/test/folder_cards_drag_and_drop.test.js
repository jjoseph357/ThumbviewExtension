const assert = require("assert");
const { reorderCardItems, reorderSpanningItems } = require("../../out/reorder_helpers");
const { buildSpanningGrid } = require("../../out/spanning_layout");

console.log("=== Test Suite: Folder Cards & Empty Space Drag-and-Drop ===");

function mockFile(id, path, lineCount = 50) {
    return {
        id,
        path,
        uri: "file:///" + path,
        lineCount,
        lines: new Array(Math.min(lineCount, 50)).fill({ text: "const x = 1;", indent: 0, length: 12, category: "normal" })
    };
}

// Test 1: Dragging a file card to an empty slot when currentCardIds has files
// Previously, if cardOrder in workspaceState didn't have the file card, it would return untouched
// or append to the far right.
console.log("\n=== Test 1: Dragging file card to empty slot in folder cards overview ===");
{
    const visibleCards = ["folder:src/", "folder:media/", "package.json", ""];
    // User drags "package.json" (index 2) to empty slot at index 3
    const updated = reorderCardItems(visibleCards, "package.json", true, null, 3, 4);
    console.log("Updated cardOrder:", updated);
    assert.strictEqual(updated[3], "package.json", "package.json should be placed at target slot index 3");
    assert.strictEqual(updated[2], "", "slot index 2 should now be an empty gap");
    console.log("✓ Test 1 passed: file card placed at exact empty slot in folder cards mode");
}

// Test 2: Spanning layout in folder drill-down - wrapRows consistency
// If wrapRows is 2 (e.g. 4 files in folder), dragging f1 to col 2, row 0 must keep f1 at col 2, row 0
console.log("\n=== Test 2: Spanning layout in folder drill-down preserves target col/row ===");
{
    const files = [
        mockFile("f1", "src/a.ts"),
        mockFile("f2", "src/b.ts"),
        mockFile("f3", "src/c.ts"),
        mockFile("f4", "src/d.ts")
    ];
    const initialOrder = ["f1", "f2", "f3", "f4"];
    const allocs = { f1: 1, f2: 1, f3: 1, f4: 1 };
    const wrapRows = 2;
    // Initial:
    // Col 0: f1 (row 0), f2 (row 1)
    // Col 1: f3 (row 0), f4 (row 1)
    // Col 2: empty slots
    // User drags f1 to Col 2, Row 0 (empty space)
    const result = reorderSpanningItems(
        ["f1", "f2", "f3", "f4"],
        initialOrder,
        allocs,
        "f1",
        2, // targetCol
        0, // targetRow
        4, // maxAllowedCols
        2, // maxAllowedRows
        wrapRows
    );
    console.log("Reorder result newOrder:", result.newOrder);

    // Verify layout with wrapRows 2
    const layout = buildSpanningGrid(files, result.newOrder, allocs, wrapRows);
    const p1 = layout.placements.find(p => p.file.id === "f1");
    console.log("f1 placement after move:", p1 ? { col: p1.col, row: p1.row } : null);
    assert.strictEqual(p1?.col, 2, "f1 should be placed at col 2");
    assert.strictEqual(p1?.row, 0, "f1 should be placed at row 0");
    console.log("✓ Test 2 passed: f1 placed at col 2, row 0 without shifting far to the right");
}
