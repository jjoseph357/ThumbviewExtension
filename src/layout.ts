// uniform_grid layout mode: packs `nCells` items into a near-`targetAspect` grid of
// [col, row] slots. Used by extension.ts (host side, the real data) and duplicated in
// media/overview.js (webview side, only for a focused-folder sub-grid — see the note
// in that file's header). Keep both copies in sync if this algorithm changes.
export interface Placement {

    x: number;
    y: number;
    width: number;
    height: number;
}

// Slot i always refers to the same [col, row] position across calls with growing
// nCells: PersistentFileOrder (state.ts) assigns each file a stable index into this
// grid, so slots must never be renumbered once handed out — growth always appends
// new columns to existing rows first, then new rows, rather than recomputing the
// whole grid from scratch.
export function buildStableGrid(
    nCells: number,
    targetAspect = 1.777
) {

    let rows = 1;
    let cols = Math.max(2, Math.ceil(rows * targetAspect));

    const slots: Array<[number, number]> = [];

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            slots.push([c, r]);
        }
    }

    while (slots.length < nCells) {

        const newRows = rows + 1;
        const newCols = Math.max(
            cols,
            Math.ceil(newRows * targetAspect)
        );

        // New columns on the existing rows first...
        for (let r = 0; r < rows; r++) {
            for (let c = cols; c < newCols; c++) {
                slots.push([c, r]);
            }
        }

        // ...then the newly added row(s) across all columns.
        for (let r = rows; r < newRows; r++) {
            for (let c = 0; c < newCols; c++) {
                slots.push([c, r]);
            }
        }

        rows = newRows;
        cols = newCols;
    }

    return {
        rows,
        cols,
        slots
    };
}

export function slotToIndex(col: number, row: number, cols: number): number {
    const index = row * cols + col;
    return index;
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
