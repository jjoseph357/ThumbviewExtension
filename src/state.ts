// Keeps a stable file-id -> array-index mapping across rescans. buildStableGrid/
// buildSpanningGrid (layout.ts/spanning_layout.ts) assign grid slots purely by index
// into getOrder()'s array, so an existing file must never change index just because
// other files were added or removed elsewhere in the workspace.
export class PersistentFileOrder {

    private seenFiles: string[] = [];

    // Deleted files leave "holes" (their old index) rather than shifting everything
    // down; newly discovered files fill the oldest hole first, and only append past
    // the end once no holes remain. This is what keeps every other file's grid slot
    // untouched when the file set changes.
    update(ids: string[]) {

        const current = new Set(ids);

        const holes: number[] = [];

        for (let i = 0; i < this.seenFiles.length; i++) {
            if (!current.has(this.seenFiles[i])) {
                holes.push(i);
            }
        }

        const newFiles = ids.filter(x => !this.seenFiles.includes(x));

        for (const id of newFiles) {

            const hole = holes.shift();

            if (hole !== undefined) {
                this.seenFiles[hole] = id;
            } else {
                this.seenFiles.push(id);
            }
        }
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

    placeAt(idToMove: string, index: number) {
        const from = this.seenFiles.indexOf(idToMove);
        if (from === -1) return;
        this.seenFiles.splice(from, 1);
        const adjusted = index > from ? index - 1 : index;
        const clamped = Math.max(0, Math.min(adjusted, this.seenFiles.length));
        this.seenFiles.splice(clamped, 0, idToMove);
    }
}