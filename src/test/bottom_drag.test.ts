import * as assert from "assert";
import { buildSpanningGrid } from "../spanning_layout";
import { RepoFile } from "../scanner";

function mockFile(id: string, lineCount = 50): RepoFile {
    return {
        id,
        path: `src/${id}.ts`,
        uri: `file:///workspace/src/${id}.ts`,
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

runSuite("Spanning Grid Bottom-Row Drag & Row Capacity", () => {
    runTest("Dragging a file to bottom row updates row capacity and places file without wrapping", () => {
        const files = [mockFile("A"), mockFile("B"), mockFile("C"), mockFile("D")];
        const initialOrder = ["A", "B", "C", "D"];
        const allocs: { [id: string]: number } = { A: 1, B: 1, C: 1, D: 1 };

        // Step 1: Initial layout
        const layout1 = buildSpanningGrid(files, initialOrder, allocs, null);
        assert.strictEqual(layout1.wrapRows, 2);

        // Step 2: Drag A to col 0, row 2
        const msg = { sourceId: "A", targetId: null, targetIsEmpty: true, targetCol: 0, targetRow: 2 };
        const sourceCells = allocs[msg.sourceId] || 1;

        let reqRows = layout1.wrapRows;
        for (const p of layout1.placements) {
            reqRows = Math.max(reqRows, p.row + p.nCells);
        }
        const gridRows = Math.max(reqRows, msg.targetRow + sourceCells);
        const maxCol = Math.max(layout1.cols - 1, msg.targetCol, 0);

        const grid: string[][] = [];
        for (let c = 0; c <= maxCol; c++) {
            grid.push(new Array(gridRows).fill(""));
        }
        for (const p of layout1.placements) {
            for (let i = 0; i < p.nCells; i++) {
                if (p.row + i < gridRows && p.col <= maxCol) {
                    grid[p.col][p.row + i] = p.file.id;
                }
            }
        }

        // Clear source and place at target
        for (let c = 0; c <= maxCol; c++) {
            for (let r = 0; r < gridRows; r++) {
                if (grid[c][r] === msg.sourceId) grid[c][r] = "";
            }
        }
        for (let i = 0; i < sourceCells; i++) {
            grid[msg.targetCol][msg.targetRow + i] = msg.sourceId;
        }

        const newOrder: string[] = [];
        for (let c = 0; c <= maxCol; c++) {
            let r = 0;
            while (r < gridRows) {
                const cell = grid[c][r];
                if (cell) {
                    newOrder.push(cell);
                    const nCells = allocs[cell] || 1;
                    r += nCells;
                } else {
                    newOrder.push("");
                    r += 1;
                }
            }
        }
        while (newOrder.length > 0 && !newOrder[newOrder.length - 1]) newOrder.pop();

        // Step 3: Verify fixed layout with updated savedRows
        const updatedSavedRows = Math.max(layout1.wrapRows, gridRows);
        const layout2 = buildSpanningGrid(files, newOrder, allocs, updatedSavedRows);

        const a = layout2.placements.find(p => p.file.id === "A");
        const b = layout2.placements.find(p => p.file.id === "B");
        const c = layout2.placements.find(p => p.file.id === "C");
        const d = layout2.placements.find(p => p.file.id === "D");

        assert.strictEqual(b?.col, 0);
        assert.strictEqual(b?.row, 1);
        assert.strictEqual(a?.col, 0);
        assert.strictEqual(a?.row, 2);
        assert.strictEqual(c?.col, 1);
        assert.strictEqual(c?.row, 0);
        assert.strictEqual(d?.col, 1);
        assert.strictEqual(d?.row, 1);
    });
});
