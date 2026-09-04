const assert = require("assert");

console.log("=== Test Suite: Tall File Vertical Overflow Triggers Folder Cards ===");

function checkRootCellsTooSmall(rectW, rectH, gridCols, gridRows, files, minCellW = 60, minCellH = 40) {
    const GRID_SIDE_MARGIN = 16;
    const GRID_TOP_MARGIN = 44;
    const GRID_BOTTOM_MARGIN = 16;

    const availableW = rectW - (GRID_SIDE_MARGIN * 2);
    const availableH = rectH - GRID_TOP_MARGIN - GRID_BOTTOM_MARGIN;

    const rootCellW = availableW / Math.max(1, gridCols);
    const rootCellH = availableH / Math.max(1, gridRows);

    let hasTallFileOverflow = false;
    if (files && Array.isArray(files)) {
        for (const f of files) {
            const slot = f.slot;
            const nCells = f.nCells || 1;
            const fileH = rootCellH * nCells;
            if (fileH > availableH) {
                hasTallFileOverflow = true;
                break;
            }
            if (slot && typeof slot[1] === "number") {
                const y = GRID_TOP_MARGIN + slot[1] * rootCellH;
                if (y + fileH > rectH || y > rectH) {
                    hasTallFileOverflow = true;
                    break;
                }
            }
        }
    }

    return rootCellW < minCellW || rootCellH < minCellH || hasTallFileOverflow;
}

// Test 1: Window has reasonable cell height (e.g. 50px >= 40px) so basic rootCellH < 40 would be false,
// BUT a tall file (nCells = 8) exceeds available vertical space.
// It must trigger folder cards so the tall file does not disappear.
{
    const files = [
        { id: "f1", slot: [0, 0], nCells: 8, path: "src/tallFile.ts" },
        { id: "f2", slot: [1, 0], nCells: 1, path: "src/normalFile.ts" }
    ];
    // Window: 800 x 360 px.
    // availableH = 360 - 44 - 16 = 300px.
    // gridRows = 6 -> rootCellH = 300 / 6 = 50px (>= 40px!).
    // Without tall file check: rootCellH < 40 is FALSE!
    // But file f1 height is 50 * 8 = 400px > 300px availableH!
    // y + fileH = 44 + 400 = 444px > 360px rectH!
    const shouldGroupIntoCards = checkRootCellsTooSmall(800, 360, 4, 6, files);
    assert.strictEqual(shouldGroupIntoCards, true, "Must trigger folder cards when a tall file overflows vertical space");
    console.log("✓ Test 1 passed: Tall file vertical overflow correctly triggers folder cards");
}

// Test 2: Normal files that fit within canvas do NOT trigger false positives
{
    const normalFiles = [
        { id: "f1", slot: [0, 0], nCells: 2, path: "src/a.ts" },
        { id: "f2", slot: [0, 2], nCells: 1, path: "src/b.ts" },
        { id: "f3", slot: [1, 0], nCells: 1, path: "src/c.ts" }
    ];
    // Window: 1200 x 800 px.
    // availableH = 740px. gridRows = 4 -> rootCellH = 185px.
    // max y + fileH = 44 + 2 * 185 + 185 = 599px < 800px.
    const shouldGroupIntoCards = checkRootCellsTooSmall(1200, 800, 4, 4, normalFiles);
    assert.strictEqual(shouldGroupIntoCards, false, "Normal files that fit should remain in tile mode");
    console.log("✓ Test 2 passed: Normal files fitting vertically remain in tile mode");
}

console.log("✓ ALL TALL FILE TESTS PASSED");
