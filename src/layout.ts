import { buildStableGrid } from "./layout_core";

// buildStableGrid lives in layout_core.ts, shared with the webview.
export { buildStableGrid, DEFAULT_TARGET_ASPECT, MIN_GRID_ROWS, MIN_GRID_COLS } from "./layout_core";

export interface Placement {
    x: number;
    y: number;
    width: number;
    height: number;
}

export function slotToIndex(col: number, row: number, cols: number): number {
    return row * cols + col;
}

export function findSlotIndex(col: number, row: number, minCells = 0): number {
    let count = Math.max(minCells, (row + 1) * (col + 1) * 2, 4);
    let layout = buildStableGrid(count);
    let idx = layout.slots.findIndex(s => s[0] === col && s[1] === row);
    while (idx === -1) {
        count += 16;
        layout = buildStableGrid(count);
        idx = layout.slots.findIndex(s => s[0] === col && s[1] === row);
    }
    return idx;
}
