// Keeps a stable file-id -> array-index mapping across rescans. buildStableGrid/
// buildSpanningGrid (layout.ts/spanning_layout.ts) assign grid slots purely by index
// into getOrder()'s array, so an existing file must never change index just because
// other files were added or removed elsewhere in the workspace.

import { fillLayoutHoles } from "./layout_core";

// fillLayoutHoles lives in layout_core.ts, shared with the webview.
export { fillLayoutHoles } from "./layout_core";
export type { HoleFillResult } from "./layout_core";

export class PersistentFileOrder {

    private seenFiles: string[] = [];

    // Deleted/ignored files leave "holes" (their old entry) rather than shifting everything
    // down; newly discovered files fill the earliest hole they fit in, and only append past
    // the end once none fits. This is what keeps every other file's grid slot untouched
    // when the file set changes. In spanning mode pass cell counts: see fillLayoutHoles.
    // Returns footprints for files that filled a taller hole; callers persist them.
    update(ids: string[], cellsOf?: (id: string) => number, holeCellsOf?: (id: string) => number): { [id: string]: number } {
        const { order, footprints } = fillLayoutHoles(this.seenFiles, ids, cellsOf, holeCellsOf);
        this.seenFiles = order;
        return footprints;
    }

    // Unlike update(), this resets the layout order strictly to currentIds (which are
    // sorted by directory-grouped relative path) and eliminates all empty holes.
    reflow(currentIds: string[]) {
        this.seenFiles = [...currentIds];
    }

    getOrder() {
        return this.seenFiles;
    }

    swap(idA: string, idB: string) {
        const i = this.seenFiles.indexOf(idA), j = this.seenFiles.indexOf(idB);
        if (i === -1 || j === -1 || i === j) return;
        [this.seenFiles[i], this.seenFiles[j]] = [this.seenFiles[j], this.seenFiles[i]];
    }

    move(idToMove: string, idTarget: string | null) {
        const from = this.seenFiles.indexOf(idToMove);
        if (from === -1 || idToMove === idTarget) return;
        this.seenFiles.splice(from, 1);
        const to = idTarget === null ? -1 : this.seenFiles.indexOf(idTarget);
        // if idTarget is null, place the tile at the end of the array
        this.seenFiles.splice(to === -1 ? this.seenFiles.length : to, 0, idToMove);
    }

    moveToEmptySlot(idToMove: string, targetIndex: number) {
        const from = this.seenFiles.indexOf(idToMove);
        if (from === -1) return;

        // Leave an empty space where the tile came from so other tiles do not reflow
        this.seenFiles[from] = "";

        while (this.seenFiles.length <= targetIndex) {
            this.seenFiles.push("");
        }

        this.seenFiles[targetIndex] = idToMove;

        // Trim any trailing empty spaces from the end of the array
        while (this.seenFiles.length > 0 && !this.seenFiles[this.seenFiles.length - 1]) {
            this.seenFiles.pop();
        }
    }

    placeAt(idToMove: string, index: number) {
        this.moveToEmptySlot(idToMove, index);
    }

    setOrder(newOrder: string[]) {
        this.seenFiles = [...newOrder];
    }

    /**
     * The order saved by a previous session, exactly as stored, gaps included. Not update(): that
     * treats its argument as live ids and kept only the first "" gap, so after every restart each
     * tile after a later gap moved back.
     */
    restore(saved: string[]) {
        this.seenFiles = saved.map(id => (typeof id === "string" ? id : ""));
    }
}