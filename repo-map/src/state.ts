export class PersistentFileOrder {

    private seenFiles: string[] = [];

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

    reflow(currentIds: string[]) {
        const current = new Set(currentIds);
        this.seenFiles = this.seenFiles.filter(id => current.has(id));

        for (const id of currentIds) {
            if (!this.seenFiles.includes(id)) {
                this.seenFiles.push(id);
            }
        }
    }

    getOrder() {
        return this.seenFiles;
    }

}