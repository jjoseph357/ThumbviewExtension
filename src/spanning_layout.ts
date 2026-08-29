import { RepoFile } from "./scanner";

export const DEFAULT_BASE_LINES_PER_CELL = 60;
export const DEFAULT_COMPRESSION_PCT = 0.05;
export const DEFAULT_TARGET_ASPECT = 16 / 9;
export const MIN_GRID_ROWS = 1;
export const MIN_GRID_COLS = 2;

export interface SpanningPlacement {
    file: RepoFile;
    col: number;
    row: number;
    nCells: number;
    slots: Array<[number, number]>;
}

export interface SpanningLayoutResult {
    rows: number;
    cols: number;
    placements: SpanningPlacement[];
    allocations: { [id: string]: number };
    wrapRows: number;
}

export function cellsNeeded(
    lineCount: number,
    baseLinesPerCell = DEFAULT_BASE_LINES_PER_CELL,
    compressionPct = DEFAULT_COMPRESSION_PCT
): number {
    if (lineCount <= baseLinesPerCell) {
        return 1;
    }
    const repLines = Math.max(lineCount * compressionPct, baseLinesPerCell);
    return Math.ceil(repLines / baseLinesPerCell);
}

export function buildSpanningGrid(
    files: RepoFile[],
    seenFileOrder: string[],
    existingAllocations: { [id: string]: number } = {},
    savedGridRows: number | null = null,
    forceBreakBeforeId: string | null = null,
    targetAspect = DEFAULT_TARGET_ASPECT,
    baseLinesPerCell = DEFAULT_BASE_LINES_PER_CELL,
    compressionPct = DEFAULT_COMPRESSION_PCT
): SpanningLayoutResult {
    const allocations: { [id: string]: number } = { ...existingAllocations };
    const filesById = new Map<string, RepoFile>();
    for (const f of files) {
        filesById.set(f.id, f);
    }

    let totalCells = 0;
    let maxNCells = 1;
    for (const fid of seenFileOrder) {
        if (!fid) {
            totalCells += 1;
            continue;
        }
        if (!allocations[fid]) {
            const f = filesById.get(fid);
            allocations[fid] = f ? cellsNeeded(f.lineCount, baseLinesPerCell, compressionPct) : 1;
        }
        totalCells += allocations[fid];
        if (allocations[fid] > maxNCells) {
            maxNCells = allocations[fid];
        }
    }

    const calculatedRows = Math.max(MIN_GRID_ROWS, Math.round(Math.sqrt(Math.max(totalCells, files.length, 1) / targetAspect)));
    const wrapRows = savedGridRows && savedGridRows > 0 ? Math.max(savedGridRows, maxNCells) : Math.max(calculatedRows, maxNCells);

    let currCol = 0;
    let currRow = 0;
    let maxRowUsed = 1;
    const placements: SpanningPlacement[] = [];

    for (const fid of seenFileOrder) {
        const file = fid ? filesById.get(fid) : undefined;
        const nCells = fid ? (allocations[fid] || 1) : 1;

        const mustBreak = fid === forceBreakBeforeId
            ? currRow > 0
            : currRow > 0 && currRow + nCells > wrapRows;

        if (mustBreak) {
            currCol++;
            currRow = 0;
        }

        if (file) {
            const slots: Array<[number, number]> = [];
            for (let i = 0; i < nCells; i++) {
                slots.push([currCol, currRow + i]);
            }

            placements.push({
                file,
                col: currCol,
                row: currRow,
                nCells,
                slots
            });
        }

        currRow += nCells;
        if (currRow > maxRowUsed) {
            maxRowUsed = currRow;
        }
    }

    const reqCols = currCol + 1;
    const finalRows = Math.max(MIN_GRID_ROWS, maxRowUsed, Math.ceil(reqCols / targetAspect));
    const finalCols = Math.max(MIN_GRID_COLS, reqCols, Math.ceil(finalRows * targetAspect));

    return {
        rows: finalRows,
        cols: finalCols,
        placements,
        allocations,
        wrapRows
    };
}
