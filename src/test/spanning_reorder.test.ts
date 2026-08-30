import * as assert from "assert";
import { buildSpanningGrid } from "../spanning_layout";
import { RepoFile } from "../scanner";

function mockFile(id: string, lineCount: number): RepoFile {
    return {
        id,
        path: `src/${id}.ts`,
        uri: `file:///workspace/src/${id}.ts`,
        lineCount,
        lines: []
    };
}

export function reorderSpanningGrid(
    activeFiles: RepoFile[],
    order: string[],
    savedAllocations: { [id: string]: number },
    savedRows: number | null,
    msg: {
        sourceId: string;
        targetId: string | null;
        targetIsEmpty: boolean;
        targetCol: number;
        targetRow: number;
    }
): string[] {
    const currentLayout = buildSpanningGrid(activeFiles, order, savedAllocations, savedRows);
    const sourceCells = savedAllocations[msg.sourceId] || 1;

    const placementByFileId = new Map<string, (typeof currentLayout.placements)[0]>();
    const placementBySlot = new Map<string, (typeof currentLayout.placements)[0]>();

    for (const p of currentLayout.placements) {
        placementByFileId.set(p.file.id, p);
        for (const s of p.slots) {
            placementBySlot.set(`${s[0]},${s[1]}`, p);
        }
    }

    const sourcePlacement = placementByFileId.get(msg.sourceId);
    const sourceCol = sourcePlacement ? sourcePlacement.col : 0;
    const sourceRow = sourcePlacement ? sourcePlacement.row : 0;

    // Check if dropping onto any file's sub-cell
    let targetPlacement = placementBySlot.get(`${msg.targetCol},${msg.targetRow}`);
    if (targetPlacement && targetPlacement.file.id === msg.sourceId) {
        targetPlacement = undefined;
    }

    // If dropping directly onto an existing file, align to its top anchor
    const targetCol = targetPlacement ? targetPlacement.col : msg.targetCol;
    const targetRow = targetPlacement ? targetPlacement.row : msg.targetRow;

    let reqRows = currentLayout.wrapRows;
    for (const p of currentLayout.placements) {
        reqRows = Math.max(reqRows, p.row + p.nCells);
    }
    const gridRows = Math.max(reqRows, targetRow + sourceCells);
    const maxCol = Math.max(currentLayout.cols - 1, targetCol, sourceCol);

    const grid: string[][] = [];
    for (let c = 0; c <= maxCol; c++) {
        grid.push(new Array(gridRows).fill(""));
    }
    for (const p of currentLayout.placements) {
        for (let i = 0; i < p.nCells; i++) {
            if (p.row + i < gridRows && p.col <= maxCol) {
                grid[p.col][p.row + i] = p.file.id;
            }
        }
    }

    // Identify all target files overlapping the incoming file span in targetCol
    const targetRaw = grid[targetCol].slice(targetRow, targetRow + sourceCells).filter(id => Boolean(id) && id !== msg.sourceId);
    const targetFileIds = Array.from(new Set(targetRaw));
    if (targetPlacement && !targetFileIds.includes(targetPlacement.file.id)) {
        targetFileIds.push(targetPlacement.file.id);
    }

    if (targetFileIds.length === 0) {
        for (let c = 0; c <= maxCol; c++) {
            for (let r = 0; r < gridRows; r++) {
                if (grid[c][r] === msg.sourceId) {
                    grid[c][r] = "";
                }
            }
        }
        for (let i = 0; i < sourceCells; i++) {
            if (targetRow + i < gridRows) {
                grid[targetCol][targetRow + i] = msg.sourceId;
            }
        }
    } else if (sourceCol === targetCol) {
        for (let r = 0; r < gridRows; r++) {
            if (grid[sourceCol][r] === msg.sourceId || targetFileIds.includes(grid[sourceCol][r])) {
                grid[sourceCol][r] = "";
            }
        }

        const minRow = Math.min(sourceRow, targetRow);
        if (sourceRow < targetRow) {
            let curR = minRow;
            for (const tid of targetFileIds) {
                const tc = savedAllocations[tid] || 1;
                for (let i = 0; i < tc; i++) {
                    if (curR + i < gridRows) {
                        grid[sourceCol][curR + i] = tid;
                    }
                }
                curR += tc;
            }
            for (let i = 0; i < sourceCells; i++) {
                if (curR + i < gridRows) {
                    grid[sourceCol][curR + i] = msg.sourceId;
                }
            }
        } else {
            let curR = minRow;
            for (let i = 0; i < sourceCells; i++) {
                if (curR + i < gridRows) {
                    grid[sourceCol][curR + i] = msg.sourceId;
                }
            }
            curR += sourceCells;
            for (const tid of targetFileIds) {
                const tc = savedAllocations[tid] || 1;
                for (let i = 0; i < tc; i++) {
                    if (curR + i < gridRows) {
                        grid[sourceCol][curR + i] = tid;
                    }
                }
                curR += tc;
            }
        }
    } else {
        // Cross-column swap / displacement
        const maxTargetSpan = targetFileIds.reduce((sum, tid) => sum + (savedAllocations[tid] || 1), 0);
        const totalSpan = Math.max(sourceCells, maxTargetSpan);

        let effectiveSourceRow = sourceRow;
        if (sourceCells < maxTargetSpan) {
            effectiveSourceRow = Math.max(0, Math.min(sourceRow, gridRows - totalSpan));
            if (targetRow === 0 && sourceRow < totalSpan) {
                effectiveSourceRow = 0;
            }
        }

        const sourceRaw = grid[sourceCol].slice(effectiveSourceRow, effectiveSourceRow + totalSpan).filter(id => Boolean(id) && !targetFileIds.includes(id));
        const sourceFileIds = Array.from(new Set(sourceRaw));
        if (!sourceFileIds.includes(msg.sourceId)) {
            sourceFileIds.unshift(msg.sourceId);
        }

        // Clear sourceFileIds from sourceCol and targetFileIds from targetCol
        for (let r = 0; r < gridRows; r++) {
            if (sourceFileIds.includes(grid[sourceCol][r])) {
                grid[sourceCol][r] = "";
            }
            if (targetFileIds.includes(grid[targetCol][r])) {
                grid[targetCol][r] = "";
            }
        }

        // Place sourceFileIds in targetCol
        let curTargetR = targetRow;
        for (const sid of sourceFileIds) {
            const sidPlacement = placementByFileId.get(sid);
            const offset = sidPlacement ? Math.max(0, sidPlacement.row - effectiveSourceRow) : (curTargetR - targetRow);
            const destR = (sourceFileIds.length === 1 && sourceCells === 1) ? targetRow : (targetRow + offset);
            const sc = savedAllocations[sid] || 1;
            for (let i = 0; i < sc; i++) {
                if (destR + i < gridRows) {
                    grid[targetCol][destR + i] = sid;
                }
            }
            curTargetR += sc;
        }

        // Place targetFileIds in sourceCol
        let curSourceR = effectiveSourceRow;
        for (const tid of targetFileIds) {
            const tidPlacement = placementByFileId.get(tid);
            const offset = tidPlacement ? Math.max(0, tidPlacement.row - targetRow) : (curSourceR - effectiveSourceRow);
            const destR = (targetFileIds.length === 1 && maxTargetSpan === 1 && targetPlacement && targetPlacement.row === targetRow)
                ? (sourceCells === 1 ? sourceRow : effectiveSourceRow)
                : (effectiveSourceRow + offset);
            const tc = savedAllocations[tid] || 1;
            for (let i = 0; i < tc; i++) {
                if (destR + i < gridRows) {
                    grid[sourceCol][destR + i] = tid;
                }
            }
            curSourceR += tc;
        }
    }

    const newOrder: string[] = [];
    for (let c = 0; c <= maxCol; c++) {
        let r = 0;
        while (r < gridRows) {
            const cell = grid[c][r];
            if (cell) {
                newOrder.push(cell);
                const nCells = savedAllocations[cell] || 1;
                r += nCells;
            } else {
                newOrder.push("");
                r += 1;
            }
        }
    }
    while (newOrder.length > 0 && !newOrder[newOrder.length - 1]) {
        newOrder.pop();
    }
    return Object.assign(newOrder, { newRows: gridRows });
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

runSuite("Spanning Grid Drag and Drop Reordering", () => {
    runTest("Dragging 2-tall file down one tile relocates it with zero duplication", () => {
        const files = [mockFile("Tall2", 120)];
        const order = ["Tall2"];
        const allocs = { Tall2: 2 };
        const msg = { sourceId: "Tall2", targetId: "Tall2", targetIsEmpty: false, targetCol: 0, targetRow: 1 };
        const newOrder = reorderSpanningGrid(files, order, allocs, 3, msg);
        assert.deepStrictEqual([...newOrder], ["", "Tall2"]);
    });

    runTest("Swapping top 1-tall and bottom 2-tall file in the same column", () => {
        const files = [mockFile("Top1", 50), mockFile("Bottom2", 120), mockFile("Other", 50)];
        const order = ["Top1", "Bottom2", "Other"];
        const allocs = { Top1: 1, Bottom2: 2, Other: 1 };
        const msg = { sourceId: "Top1", targetId: "Bottom2", targetIsEmpty: false, targetCol: 0, targetRow: 1 };
        const newOrder = reorderSpanningGrid(files, order, allocs, 3, msg);
        const layout = buildSpanningGrid(files, newOrder, allocs, (newOrder as any).newRows);
        const top = layout.placements.find(p => p.file.id === "Top1");
        const bottom = layout.placements.find(p => p.file.id === "Bottom2");
        assert.strictEqual(bottom?.row, 0);
        assert.strictEqual(top?.row, 2);
    });

    runTest("Dragging bottom 2-tall file up to top 1-tall file in the same column", () => {
        const files = [mockFile("Top1", 50), mockFile("Bottom2", 120), mockFile("Other", 50)];
        const order = ["Top1", "Bottom2", "Other"];
        const allocs = { Top1: 1, Bottom2: 2, Other: 1 };
        const msg = { sourceId: "Bottom2", targetId: "Top1", targetIsEmpty: false, targetCol: 0, targetRow: 0 };
        const newOrder = reorderSpanningGrid(files, order, allocs, 3, msg);
        const layout = buildSpanningGrid(files, newOrder, allocs, (newOrder as any).newRows);
        const top = layout.placements.find(p => p.file.id === "Top1");
        const bottom = layout.placements.find(p => p.file.id === "Bottom2");
        assert.strictEqual(bottom?.row, 0);
        assert.strictEqual(top?.row, 2);
    });

    runTest("Dropping 1-tall file onto the bottom half of a 2-tall file", () => {
        const files = [mockFile("Top1", 50), mockFile("Tall2", 120), mockFile("Other", 50)];
        const order = ["Top1", "Tall2", "Other"];
        const allocs = { Top1: 1, Tall2: 2, Other: 1 };
        const msg = { sourceId: "Top1", targetId: "Tall2", targetIsEmpty: false, targetCol: 1, targetRow: 1 };
        const newOrder = reorderSpanningGrid(files, order, allocs, 2, msg);
        const layout = buildSpanningGrid(files, newOrder, allocs, (newOrder as any).newRows);
        const top = layout.placements.find(p => p.file.id === "Top1");
        const tall = layout.placements.find(p => p.file.id === "Tall2");
        assert.strictEqual(top?.col, 1);
        assert.strictEqual(top?.row, 0);
        assert.strictEqual(tall?.col, 0);
        assert.strictEqual(tall?.row, 0);
    });

    runTest("Dragging bottom half of a 2-tall file onto a 1-tall file", () => {
        const files = [mockFile("Tall2", 120), mockFile("Top1", 50), mockFile("Other", 50)];
        const order = ["Tall2", "Top1", "Other"];
        const allocs = { Tall2: 2, Top1: 1, Other: 1 };
        const msg = { sourceId: "Tall2", targetId: "Top1", targetIsEmpty: false, targetCol: 1, targetRow: 0 };
        const newOrder = reorderSpanningGrid(files, order, allocs, 2, msg);
        const layout = buildSpanningGrid(files, newOrder, allocs, (newOrder as any).newRows);
        const top = layout.placements.find(p => p.file.id === "Top1");
        const tall = layout.placements.find(p => p.file.id === "Tall2");
        assert.strictEqual(top?.col, 0);
        assert.strictEqual(top?.row, 0);
        assert.strictEqual(tall?.col, 1);
        assert.strictEqual(tall?.row, 0);
    });

    runTest("Dragging top of 2-tall file onto empty tile with 1-tall file below", () => {
        const files = [mockFile("Tall2", 120), mockFile("FileB", 50)];
        const order = ["Tall2", "", "FileB"];
        const allocs = { Tall2: 2, FileB: 1 };
        const msg = { sourceId: "Tall2", targetId: null, targetIsEmpty: true, targetCol: 1, targetRow: 0 };
        const newOrder = reorderSpanningGrid(files, order, allocs, 2, msg);
        const layout = buildSpanningGrid(files, newOrder, allocs, (newOrder as any).newRows);
        const tall = layout.placements.find(p => p.file.id === "Tall2");
        const fileB = layout.placements.find(p => p.file.id === "FileB");
        assert.strictEqual(tall?.col, 1);
        assert.strictEqual(tall?.row, 0);
        assert.strictEqual(fileB?.col, 0);
        assert.strictEqual(fileB?.row, 1);
    });

    runTest("Swapping top 1-tall file of [Top1, Bottom1] with 2-tall file moves both 1-tall files", () => {
        const files = [mockFile("Top1", 50), mockFile("Bottom1", 50), mockFile("Tall2", 120), mockFile("C", 50)];
        const order = ["Top1", "Bottom1", "Tall2", "C"];
        const allocs = { Top1: 1, Bottom1: 1, Tall2: 2, C: 1 };
        const msg = { sourceId: "Top1", targetId: "Tall2", targetIsEmpty: false, targetCol: 1, targetRow: 0 };
        const newOrder = reorderSpanningGrid(files, order, allocs, 2, msg);
        const layout = buildSpanningGrid(files, newOrder, allocs, (newOrder as any).newRows);
        const tall = layout.placements.find(p => p.file.id === "Tall2");
        const top = layout.placements.find(p => p.file.id === "Top1");
        const bot = layout.placements.find(p => p.file.id === "Bottom1");
        const c = layout.placements.find(p => p.file.id === "C");
        assert.strictEqual(tall?.col, 0);
        assert.strictEqual(tall?.row, 0);
        assert.strictEqual(top?.col, 1);
        assert.strictEqual(top?.row, 0);
        assert.strictEqual(bot?.col, 1);
        assert.strictEqual(bot?.row, 1);
        assert.strictEqual(c?.col, 2);
        assert.strictEqual(c?.row, 0);
    });

    runTest("Swapping bottom 1-tall file of [Top1, Bottom1] with 2-tall file moves both 1-tall files", () => {
        const files = [mockFile("Top1", 50), mockFile("Bottom1", 50), mockFile("Tall2", 120), mockFile("C", 50)];
        const order = ["Top1", "Bottom1", "Tall2", "C"];
        const allocs = { Top1: 1, Bottom1: 1, Tall2: 2, C: 1 };
        const msg = { sourceId: "Bottom1", targetId: "Tall2", targetIsEmpty: false, targetCol: 1, targetRow: 0 };
        const newOrder = reorderSpanningGrid(files, order, allocs, 2, msg);
        const layout = buildSpanningGrid(files, newOrder, allocs, (newOrder as any).newRows);
        const tall = layout.placements.find(p => p.file.id === "Tall2");
        const top = layout.placements.find(p => p.file.id === "Top1");
        const bot = layout.placements.find(p => p.file.id === "Bottom1");
        assert.strictEqual(tall?.col, 0);
        assert.strictEqual(tall?.row, 0);
        assert.strictEqual(top?.col, 1);
        assert.strictEqual(top?.row, 0);
        assert.strictEqual(bot?.col, 1);
        assert.strictEqual(bot?.row, 1);
    });

    runTest("Swapping 3-tall file with three 1-tall files", () => {
        const files = [mockFile("Tall3", 180), mockFile("F1", 50), mockFile("F2", 50), mockFile("F3", 50), mockFile("End", 50)];
        const order = ["Tall3", "F1", "F2", "F3", "End"];
        const allocs = { Tall3: 3, F1: 1, F2: 1, F3: 1, End: 1 };
        const msg = { sourceId: "F1", targetId: "Tall3", targetIsEmpty: false, targetCol: 0, targetRow: 0 };
        const newOrder = reorderSpanningGrid(files, order, allocs, 3, msg);
        const layout = buildSpanningGrid(files, newOrder, allocs, (newOrder as any).newRows);
        const tall = layout.placements.find(p => p.file.id === "Tall3");
        const f1 = layout.placements.find(p => p.file.id === "F1");
        const f2 = layout.placements.find(p => p.file.id === "F2");
        const f3 = layout.placements.find(p => p.file.id === "F3");
        const end = layout.placements.find(p => p.file.id === "End");
        assert.strictEqual(f1?.col, 0);
        assert.strictEqual(f2?.col, 0);
        assert.strictEqual(f3?.col, 0);
        assert.strictEqual(tall?.col, 1);
        assert.strictEqual(end?.col, 2);
    });

    runTest("Dragging 1-tall file from [Top1, Bottom1] to empty slot preserves other 1-tall file position", () => {
        const files = [mockFile("Top1", 50), mockFile("Bottom1", 50)];
        const order = ["Top1", "Bottom1"];
        const allocs = { Top1: 1, Bottom1: 1 };
        const msg = { sourceId: "Top1", targetId: null, targetIsEmpty: true, targetCol: 1, targetRow: 0 };
        const newOrder = reorderSpanningGrid(files, order, allocs, 2, msg);
        const layout = buildSpanningGrid(files, newOrder, allocs, (newOrder as any).newRows);
        const top = layout.placements.find(p => p.file.id === "Top1");
        const bot = layout.placements.find(p => p.file.id === "Bottom1");
        assert.strictEqual(top?.col, 1);
        assert.strictEqual(top?.row, 0);
        assert.strictEqual(bot?.col, 0);
        assert.strictEqual(bot?.row, 1);
    });

    runTest("Dragging 1-tall file to bottom row places it at bottom row without wrapping to adjacent column", () => {
        const files = [mockFile("A", 50), mockFile("B", 50), mockFile("C", 50), mockFile("D", 50)];
        const order = ["A", "B", "C", "D"];
        const allocs = { A: 1, B: 1, C: 1, D: 1 };
        const msg = { sourceId: "A", targetId: null, targetIsEmpty: true, targetCol: 0, targetRow: 2 };
        const newOrder = reorderSpanningGrid(files, order, allocs, 2, msg);
        const layout = buildSpanningGrid(files, newOrder, allocs, (newOrder as any).newRows);
        const a = layout.placements.find(p => p.file.id === "A");
        const b = layout.placements.find(p => p.file.id === "B");
        const c = layout.placements.find(p => p.file.id === "C");
        const d = layout.placements.find(p => p.file.id === "D");
        assert.strictEqual(b?.col, 0);
        assert.strictEqual(b?.row, 1);
        assert.strictEqual(a?.col, 0);
        assert.strictEqual(a?.row, 2);
        assert.strictEqual(c?.col, 1);
        assert.strictEqual(c?.row, 0);
        assert.strictEqual(d?.col, 1);
        assert.strictEqual(d?.row, 1);
    });

    runTest("Swapping two 1-tall files at different rows across columns swaps exact positions without moving other tiles", () => {
        const files = [mockFile("TopA", 50), mockFile("Source", 50), mockFile("Target", 50), mockFile("BottomB", 50)];
        const order = ["TopA", "Source", "Target", "BottomB"];
        const allocs = { TopA: 1, Source: 1, Target: 1, BottomB: 1 };
        const msg = { sourceId: "Source", targetId: "Target", targetIsEmpty: false, targetCol: 1, targetRow: 0 };
        const newOrder = reorderSpanningGrid(files, order, allocs, 2, msg);
        const layout = buildSpanningGrid(files, newOrder, allocs, (newOrder as any).newRows);
        const topA = layout.placements.find(p => p.file.id === "TopA");
        const source = layout.placements.find(p => p.file.id === "Source");
        const target = layout.placements.find(p => p.file.id === "Target");
        const bottomB = layout.placements.find(p => p.file.id === "BottomB");
        assert.strictEqual(topA?.col, 0);
        assert.strictEqual(topA?.row, 0);
        assert.strictEqual(target?.col, 0);
        assert.strictEqual(target?.row, 1);
        assert.strictEqual(source?.col, 1);
        assert.strictEqual(source?.row, 0);
        assert.strictEqual(bottomB?.col, 1);
        assert.strictEqual(bottomB?.row, 1);
    });
});
