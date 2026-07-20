export interface Placement {

    x: number;
    y: number;
    width: number;
    height: number;
}

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