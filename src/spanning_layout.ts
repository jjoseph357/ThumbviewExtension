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
// before dividing into cells — so a single huge file can't dominate the whole grid.
export function cellsNeeded(
    lineCount: number,
    baseLinesPerCell = 60,
    compressionPct = 0.05
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
    forceBreakBeforeId: string | null = null,
    targetAspect = 1.777,
    baseLinesPerCell = 60,
    compressionPct = 0.05
): SpanningLayoutResult {
    const allocations: { [id: string]: number } = { ...existingAllocations };
    const filesById = new Map<string, RepoFile>();
    for (const f of files) {
        filesById.set(f.id, f);
    }

    let totalCells = 0;
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
    }

    const gridRows = savedGridRows && savedGridRows > 0
        ? savedGridRows
        : Math.max(1, Math.round(Math.sqrt((totalCells || files.length || 1) / targetAspect)));

    let currCol = 0;
    let currRow = 0;
    const placements: SpanningPlacement[] = [];

    for (const fid of seenFileOrder) {
        if (!fid) {
            if (currRow > 0 && currRow + 1 > gridRows) {
                currCol++;
                currRow = 0;
            }
            currRow += 1;
            continue;
        }

        const file = filesById.get(fid);
        const nCells = allocations[fid] || 1;

        const mustBreak = fid === forceBreakBeforeId
            ? currRow > 0
            : currRow > 0 && currRow + nCells > gridRows;

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
    }

    return {
        rows: gridRows,
        cols: currCol + 1,
        placements,
        allocations
    };
}
