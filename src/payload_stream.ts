// Splits a data payload's file text into what travels in the payload itself and what is streamed
// afterwards in chunks ("fileLines"), so the first frame never waits for the whole workspace's text.
// Returns plain decisions; used by extension.ts and by scripts/benchmark.mjs, which measures it.

/** Line text sent inside the "data" payload before the rest is streamed (UTF-16 code units, about bytes for code). */
export const FIRST_PAYLOAD_LINE_BUDGET = 4 * 1024 * 1024;
/** Line text per streamed "fileLines" message. */
export const STREAM_CHUNK_LINE_BUDGET = 2 * 1024 * 1024;

export interface LineText {
    lines: string[];
    fullLines?: string[];
}

/** Approximate size of a file's line text as sent: characters plus one separator per line. */
export function lineTextSize(file: LineText): number {
    let size = 0;
    for (const line of file.lines) {
        size += line.length + 1;
    }
    if (file.fullLines) {
        for (const line of file.fullLines) {
            size += line.length + 1;
        }
    }
    return size;
}

/**
 * For files in payload order (layout order: column by column in spanning mode, slot order in uniform
 * mode; the whole grid is on screen, so no order is "visible first"), whether each one's text goes
 * inline. Inline until the budget is spent; the first file always goes inline so a payload is never
 * text-free.
 */
export function inlineWithinBudget(sizes: number[], budget: number = FIRST_PAYLOAD_LINE_BUDGET): boolean[] {
    let remaining = budget;
    return sizes.map((size, i) => {
        if (i === 0 || size <= remaining) {
            remaining -= size;
            return true;
        }
        // Once a file does not fit, later ones are streamed too, keeping layout order.
        remaining = -1;
        return false;
    });
}

/** Groups items into chunks whose sizes add up to about `budget` (at least one item per chunk). */
export function chunkBySize<T>(items: T[], sizeOf: (item: T) => number, budget: number = STREAM_CHUNK_LINE_BUDGET): T[][] {
    const chunks: T[][] = [];
    let current: T[] = [];
    let used = 0;
    for (const item of items) {
        const size = sizeOf(item);
        if (current.length > 0 && used + size > budget) {
            chunks.push(current);
            current = [];
            used = 0;
        }
        current.push(item);
        used += size;
    }
    if (current.length > 0) {
        chunks.push(current);
    }
    return chunks;
}
