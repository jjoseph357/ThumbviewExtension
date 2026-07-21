import { RepoFile } from "./scanner";

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
}

export function cellsNeeded(
    lineCount: number,
    baseLinesPerCell = 60,
    compressionPct = 0.10
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
    targetAspect = 1.777,
    baseLinesPerCell = 60,
    compressionPct = 0.10
): SpanningLayoutResult {
    const allocations: { [id: string]: number } = { ...existingAllocations };
    const filesById = new Map<string, RepoFile>();
    for (const f of files) {
        filesById.set(f.id, f);
    }

    // Build per-file info in seen_files order
    const fileInfo: Array<{
        id: string;
        nCells: number;
        file?: RepoFile;
    }> = [];

    for (const fid of seenFileOrder) {
        let n = allocations[fid];
        if (!n) {
            const f = filesById.get(fid);
            n = f ? cellsNeeded(f.lineCount, baseLinesPerCell, compressionPct) : 1;
            allocations[fid] = n;
        }

        const f = filesById.get(fid);
        fileInfo.push({
            id: fid,
            nCells: n,
            file: f
        });
    }

    // Determine grid rows to approximate target aspect ratio if not set
    let gridRows = savedGridRows;
    if (!gridRows || gridRows < 1) {
        let totalCellsEstimate = 0;
        for (const fid of Object.keys(allocations)) {
            totalCellsEstimate += allocations[fid];
        }
        if (totalCellsEstimate === 0) {
            totalCellsEstimate = files.length || 1;
        }
        gridRows = Math.max(1, Math.round(Math.sqrt(totalCellsEstimate / targetAspect)));
    }

    // Column-major placement
    let currCol = 0;
    let currRow = 0;
    const placements: SpanningPlacement[] = [];

    for (const item of fileInfo) {
        // Start a new column if this file's cells don't fit in the current column
        if (currRow > 0 && currRow + item.nCells > gridRows) {
            currCol++;
            currRow = 0;
        }

        if (item.file) {
            const slots: Array<[number, number]> = [];
            for (let i = 0; i < item.nCells; i++) {
                slots.push([currCol, currRow + i]);
            }

            placements.push({
                file: item.file,
                col: currCol,
                row: currRow,
                nCells: item.nCells,
                slots
            });
        }

        currRow += item.nCells;
    }

    const actualCols = currCol + 1;

    return {
        rows: gridRows,
        cols: actualCols,
        placements,
        allocations
    };
}
