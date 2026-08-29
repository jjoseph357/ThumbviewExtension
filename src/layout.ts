export const DEFAULT_TARGET_ASPECT = 16 / 9;
export const MIN_GRID_ROWS = 1;
export const MIN_GRID_COLS = 2;

export interface Placement {
    x: number;
    y: number;
    width: number;
    height: number;
}

export function buildStableGrid(
    nCells: number,
    targetAspect = DEFAULT_TARGET_ASPECT
) {
    let rows = MIN_GRID_ROWS;
    let cols = Math.max(MIN_GRID_COLS, Math.ceil(rows * targetAspect));

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

        for (let r = 0; r < rows; r++) {
            for (let c = cols; c < newCols; c++) {
                slots.push([c, r]);
            }
        }

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
