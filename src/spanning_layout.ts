// spanning_grid layout mode: unlike layout.ts's one-cell-per-file uniform grid, a tall
// file here occupies several vertically-stacked cells so its thumbnail gets proportionally
// more room. Per-file cell counts and the derived row count are persisted by the caller
// (extension.ts) so they don't recompute — and reshuffle the grid — on every rescan.
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

// Files at or under baseLinesPerCell get exactly 1 cell. Above that, growth is
// compressed to compressionPct of the real line count (never below baseLinesPerCell)
// before dividing into cells — so a single huge file can't dominate the whole grid;
// e.g. with the defaults, a 6000-line file gets 10 cells, not 100.
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

// existingAllocations/savedGridRows let the caller persist a file's cell count and the
// grid's row count across rescans (extension.ts does, in workspaceState) — a file's
// allocation is only computed once, the first time it's seen, and never recomputed
// afterward, so unrelated files don't jump around just because one file grew or shrank.
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

    // Column-major placement: walk files in seenFileOrder, stacking each one's cells
    // down the current column; once a file wouldn't fully fit before gridRows, start
    // a fresh column instead of splitting it across two columns.
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
