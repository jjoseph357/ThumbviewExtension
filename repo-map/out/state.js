"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PersistentFileOrder = void 0;
class PersistentFileOrder {
    seenFiles = [];
    update(ids) {
        const current = new Set(ids);
        const holes = [];
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
            }
            else {
                this.seenFiles.push(id);
            }
        }
    }
    reflow(currentIds) {
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
exports.PersistentFileOrder = PersistentFileOrder;
//# sourceMappingURL=state.js.map