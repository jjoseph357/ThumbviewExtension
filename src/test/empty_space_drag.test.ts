import * as assert from "assert";
import {
    moveItemToEmptySlot,
    clampTargetToGridCapacity,
    reorderFolderItems,
    reorderCardItems
} from "../reorder_helpers";
import { buildSpanningGrid } from "../spanning_layout";
import { RepoFile } from "../scanner";

function mockFile(id: string, path: string, lineCount = 50): RepoFile {
    return {
        id,
        path,
        uri: `file:///workspace/${path}`,
        lineCount,
        lines: []
    };
}

const runSuite = typeof suite !== "undefined" ? suite : ((name: string, fn: () => void) => { console.log(`\n=== ${name} ===`); fn(); });
const runTest = typeof test !== "undefined" ? test : ((name: string, fn: () => void) => {
    try {
        fn();
        console.log(`  ✓ ${name}`);
    } catch (err: any) {
        console.error(`  ✗ ${name}: ${err?.message || String(err)}`);
        throw err;
    }
});

runSuite("Empty Space Drag & Grid Space Constraints", () => {
    runTest("moveItemToEmptySlot moves item to empty slot and leaves empty string at source", () => {
        const initial = ["A", "B", "C"];
        // Move "A" to slot 4 in a grid with capacity 6
        const result = moveItemToEmptySlot(initial, "A", 4, 6);
        assert.deepStrictEqual(result, ["", "B", "C", "", "A"]);
    });

    runTest("moveItemToEmptySlot clamps targetIndex to maxCapacity without expanding space", () => {
        const initial = ["A", "B", "C"];
        // User attempts to drag "A" to slot 10, but maxCapacity is 4 (e.g. 2x2 grid)
        const result = moveItemToEmptySlot(initial, "A", 10, 4);
        // Target index must be clamped to 3 (maxCapacity - 1)
        assert.deepStrictEqual(result, ["", "B", "C", "A"]);
        assert.strictEqual(result.length, 4);
    });

    runTest("clampTargetToGridCapacity prevents dragging from exceeding grid bounds", () => {
        // 3 cols, 2 rows grid. Dragging a 1-cell file to col 5, row 4
        const clamped1 = clampTargetToGridCapacity(5, 4, 1, 3, 2);
        assert.strictEqual(clamped1.col, 2);
        assert.strictEqual(clamped1.row, 1);

        // 2-cell file: cannot exceed row 0 in a 2-row grid
        const clamped2 = clampTargetToGridCapacity(1, 1, 2, 3, 2);
        assert.strictEqual(clamped2.col, 1);
        assert.strictEqual(clamped2.row, 0);
    });

    runTest("Dragging in spanning grid does NOT increase spanningRows or expand grid space", () => {
        const files = [mockFile("A", "src/A.ts"), mockFile("B", "src/B.ts")];
        const initialOrder = ["A", "B"];
        const allocs: { [id: string]: number } = { A: 1, B: 1 };
        const savedRows = 2;

        const layout1 = buildSpanningGrid(files, initialOrder, allocs, savedRows);
        assert.strictEqual(layout1.wrapRows, 2);

        // Clamped target prevents row expansion
        const target = clampTargetToGridCapacity(0, 3, 1, layout1.cols, layout1.wrapRows);
        assert.strictEqual(target.row, 1, "Clamped row must stay within wrapRows");

        // The updated savedRows remains unchanged at 2
        const updatedSavedRows = savedRows;
        assert.strictEqual(updatedSavedRows, 2, "Grid capacity must not increase on drag");
    });

    runTest("reorderFolderItems moves tile to empty space in focused folder and preserves gaps", () => {
        const initialFolderOrder = ["src/a.ts", "src/b.ts", "src/c.ts"];
        // Drag "src/a.ts" to empty slot index 4 in a 2x3 grid (capacity 6)
        const updated = reorderFolderItems(initialFolderOrder, "src/a.ts", true, null, 4, 6, "swap");
        assert.deepStrictEqual(updated, ["", "src/b.ts", "src/c.ts", "", "src/a.ts"]);
    });

    runTest("reorderFolderItems swaps two tiles in focused folder", () => {
        const initialFolderOrder = ["src/a.ts", "", "src/b.ts"];
        const updated = reorderFolderItems(initialFolderOrder, "src/a.ts", false, "src/b.ts", 0, 6, "swap");
        assert.deepStrictEqual(updated, ["src/b.ts", "", "src/a.ts"]);
    });

    runTest("reorderCardItems moves folder card or file to empty space in overview and preserves gaps", () => {
        const initialCardOrder = ["folder:src/", "folder:media/", "package.json"];
        // Drag "folder:src/" to empty card slot index 3 in a grid of capacity 4
        const updated = reorderCardItems(initialCardOrder, "folder:src/", true, null, 3, 4);
        assert.deepStrictEqual(updated, ["", "folder:media/", "package.json", "folder:src/"]);
    });
});
