// Spatial stability regressions reported by the owner: the saved order lost its gaps on restart,
// swapping tiles of different heights dropped or duplicated untouched tiles (which then reappeared
// in the far-right column), folder layouts filled the user's gaps with new files, and Expand Grid
// Space or a growing file could turn the whole view into folder cards. Also: auto-ignores follow
// the threshold, and episodes record the view they were chosen in.
const assert = require("assert");
const { PersistentFileOrder } = require("../../out/state");
const { reorderSpanningItems } = require("../../out/layout_core");
// scanner.ts imports vscode; its pure functions do not use it.
const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    return request === "vscode" ? {} : originalLoad.call(this, request, ...rest);
};
const { autoIgnoresToUnhide } = require("../../out/scanner");
Module._load = originalLoad;
const { sanitizeEpisode } = require("../../out/study/study_events");
const { loadOverview } = require("./helpers/overview_harness");

console.log("--- Test 1: the saved order comes back exactly after a restart, gaps included ---");
const saved = ["a", "", "b", "", "", "c", "stale-id"];
const restored = new PersistentFileOrder();
restored.restore(saved);
assert.deepStrictEqual(restored.getOrder(), saved);
const viaUpdate = new PersistentFileOrder();
viaUpdate.update(saved);
assert.notDeepStrictEqual(viaUpdate.getOrder(), saved, "update() is not a restore (it drops repeated gaps)");
console.log("✓ Test 1 passed");

console.log("--- Test 2: a drop swaps the dragged tile's cells with an equal block at the target, nothing else ---");
const { displayToFlowRow } = require("../../out/layout_core");
const columns = (order, alloc, wrap) => {
    const out = [];
    let c = 0, r = 0;
    for (const id of order) {
        const n = id ? (alloc[id] || 1) : 1;
        if (r > 0 && r + n > wrap) { c++; r = 0; }
        out[c] = out[c] || Array(wrap).fill("0");
        for (let i = 0; i < n; i++) out[c][r + i] = id || "0";
        r += n;
    }
    return out.map(x => x.join(";"));
};
const drop = (order, alloc, src, tc, tr) => {
    const res = reorderSpanningItems(Object.keys(alloc), order, alloc, src, tc, tr, 2, 3, 3);
    return res.rejected ? "rejected" : columns(res.newOrder, alloc, res.rows).join(" ");
};
// The owner's examples (each column is 3 cells: [top; middle; bottom]).
assert.strictEqual(drop(["1", "", "2", "", ""], { 1: 2, 2: 1 }, "1", 1, 0), "2;0;0 1;1;0", "[1;1;0] onto [2;0;0]: the 2 and the empty cell swap with 1;1");
assert.strictEqual(drop(["1", "", "2", "3", ""], { 1: 2, 2: 1, 3: 1 }, "1", 1, 0), "2;3;0 1;1;0", "[1;1;0] onto [2;3;0]: 1;1 swaps with 2;3");
assert.strictEqual(drop(["1", "", "2", "3", ""], { 1: 2, 2: 1, 3: 1 }, "1", 1, 1), "3;0;0 2;1;1", "1;1 onto the 3: [2;1;1] and [3;0;0]");
assert.strictEqual(drop(["1", "", "2", "3", ""], { 1: 2, 2: 1, 3: 1 }, "2", 0, 0), "2;3;0 1;1;0", "dragging the 2 onto 1;1 swaps the same blocks");
assert.strictEqual(drop(["1", "", "x", "y", ""], { 1: 2, x: 1, y: 1 }, "1", 0, 1), "0;1;1 x;y;0", "a two-tall tile moves down one row");
assert.strictEqual(drop(["1", "", "", "x", "y", ""], { 1: 1, x: 1, y: 1 }, "1", 0, 2), "0;0;1 x;y;0", "a drop on empty space moves only the dropped tile");

// Randomized: every tile survives exactly once, no two tiles overlap, and tiles outside the source
// and target columns never move.
const place = (order, alloc, wrap) => {
    const at = {};
    let c = 0, r = 0;
    for (const id of order) {
        const n = id ? (alloc[id] || 1) : 1;
        if (r > 0 && r + n > wrap) { c++; r = 0; }
        if (id) at[id] = [c, r];
        r += n;
    }
    return at;
};
let seed = 11;
const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
for (let t = 0; t < 3000; t++) {
    const n = 6 + rnd(12), wrap = 4 + rnd(4);
    const alloc = {};
    const ids = [];
    for (let i = 0; i < n; i++) { ids.push(`f${i}`); alloc[`f${i}`] = 1 + rnd(3); }
    const order = [];
    for (const id of ids) { order.push(id); if (rnd(4) === 0) order.push(""); }
    const src = ids[rnd(n)];
    const cols = Math.ceil(n * 3 / wrap) + 1;
    const before = place(order, alloc, wrap);
    const tc = rnd(cols);
    const res = reorderSpanningItems(ids, order, alloc, src, tc, rnd(wrap), cols, wrap, wrap);
    if (res.rejected) {
        assert.deepStrictEqual(res.newOrder, order, "a rejected drop changes nothing");
        continue;
    }
    const out = res.newOrder.filter(Boolean);
    for (const id of ids) {
        assert.strictEqual(out.filter(x => x === id).length, 1, `${id} appears exactly once (case ${t})`);
    }
    const after = place(res.newOrder, alloc, res.rows);
    const cells = new Set();
    for (const id of ids) {
        for (let i = 0; i < alloc[id]; i++) {
            const key = `${after[id][0]},${after[id][1] + i}`;
            assert(!cells.has(key), `no two tiles share a cell (case ${t})`);
            cells.add(key);
        }
        if (before[id][0] !== before[src][0] && before[id][0] !== tc) {
            assert.deepStrictEqual(after[id], before[id], `${id} is in neither column and must not move (case ${t})`);
        }
    }
}
// Drawn rows to flow rows: a file that grew from 1 to 3 cells pushes the next tile's drawing down.
assert.strictEqual(displayToFlowRow(["g", "a", ""], { g: 1, a: 1 }, { g: 3, a: 1 }, 6, 0, 3), 1, "row 3 is drawn a, flow row 1");
assert.strictEqual(displayToFlowRow(["g", "a", ""], { g: 1, a: 1 }, { g: 3, a: 1 }, 6, 0, 1), 0, "inside the grown tile: its flow row");
assert.strictEqual(displayToFlowRow(["g", "a", ""], { g: 1, a: 1 }, { g: 3, a: 1 }, 6, 0, 5), 3, "below the column's tiles, one to one");
console.log("✓ Test 2 passed");

console.log("--- Test 3: a folder's layout never fills a gap the user left with a new file ---");
const h = loadOverview(["buildSpanningGridLocal", "triggerReduceSpace"]);
const file = (id, lines) => ({ id, path: `pkg/${id}`, uri: `file:///ws/pkg/${id}`, lineCount: lines, contentVersion: 1, lines: [] });
const local = h.exports.buildSpanningGridLocal([file("a", 10), file("b", 10), file("new", 10)], 16 / 9, ["a", "", "b"], 0, 0, 60, 0.05, 10);
const at = id => local.placements.find(p => (p.file ? p.file.id : p.id) === id);
assert.strictEqual(at("b").row - at("a").row, 2, "b keeps its place after the gap");
assert(!(at("new").col === at("a").col && at("new").row === at("a").row + 1), "the new file does not take the user's gap");
console.log("✓ Test 3 passed");

console.log("--- Test 4: only adding files (or a smaller minimum tile size) turns the root into folder cards ---");
h.resizeTo(1600, 900);
h.flushFrames();
const many = n => Array.from({ length: n }, (_, i) => ({
    id: `d${i % 5}/x${i}.ts`, path: `d${i % 5}/x${i}.ts`, uri: `file:///ws/d${i % 5}/x${i}.ts`, lineCount: 5, contentVersion: 1,
    lines: ["const x = 1;"], slot: [i % 25, Math.floor(i / 25)]
}));
const rootPayload = (files, layout, extra = {}) => ({ command: "data", mode: "spanning_grid", files, layout, minCellWidth: 40, minCellHeight: 28, ...extra });
const cards = () => (h.exports.getData()._folderCards || []).length > 0;
h.onMessage({ data: rootPayload(many(300), { cols: 25, rows: 12, flowCols: 25, flowRows: 12 }) });
h.flushFrames();
assert(!cards(), "a readable grid shows tiles");
h.onMessage({ data: rootPayload(many(300), { cols: 37, rows: 24, flowCols: 37, flowRows: 24 }, { extraCols: 12, extraRows: 12, folderExtraCols: { "": 12 }, folderExtraRows: { "": 12 } }) });
h.flushFrames();
assert(!cards(), "Expand Grid Space never turns the view into folder cards");
const grown = many(300);
grown[290] = { ...grown[290], nCells: 20 }; // a file near the bottom grew far past its column
h.onMessage({ data: rootPayload(grown, { cols: 40, rows: 30, flowCols: 25, flowRows: 12 }) });
h.flushFrames();
assert(!cards(), "files growing past the flow size never turn the view into folder cards");
// Reduce Grid Space right at the limit: 29 base columns are readable (40.3 px of the 1168 px reference);
// the webview lowers its extra count before the host's next payload, which used to look like 30 (38.9 px).
h.onMessage({ data: rootPayload(many(300), { cols: 31, rows: 14, flowCols: 31, flowRows: 14, baseFlowCols: 29, baseFlowRows: 12 }, { extraCols: 2, extraRows: 2, folderExtraCols: { "": 2 }, folderExtraRows: { "": 2 } }) });
h.flushFrames();
assert(!cards(), "29 base columns are readable");
h.exports.triggerReduceSpace();
h.flushFrames();
assert(!cards(), "Reduce Grid Space never turns the view into folder cards");
h.onMessage({ data: rootPayload(many(1200), { cols: 45, rows: 27, flowCols: 45, flowRows: 27 }) });
h.flushFrames();
assert(cards(), "many more files do");
console.log("✓ Test 4 passed");

console.log("--- Test 5: raising the auto-ignore threshold shows folders auto-ignore hid ---");
const listed = [...Array.from({ length: 40 }, (_, i) => `docs/p${i}.md`), ...Array.from({ length: 80 }, (_, i) => `data/r${i}.csv`)];
assert.deepStrictEqual(autoIgnoresToUnhide(listed, 50, ["docs/", "data/", "mine/"], [], ["docs/", "data/"]), ["docs/"], "docs/ (40 files) no longer qualifies at 50; data/ (80) still does");
assert.deepStrictEqual(autoIgnoresToUnhide(listed, 0, ["docs/", "data/", "mine/"], [], ["docs/", "data/"]), ["docs/", "data/"], "0 turns auto-ignore off");
assert.deepStrictEqual(autoIgnoresToUnhide(listed, 0, ["docs/", "mine/"], [], ["data/"]), [], "only recorded folders that are still ignored; the user's own ignores are never touched");
console.log("✓ Test 5 passed");

console.log("--- Test 6: episodes say which view the target was chosen in ---");
assert.strictEqual(sanitizeEpisode({ viewKind: "cards" }).view_kind, "cards");
assert.strictEqual(sanitizeEpisode({ viewKind: "elsewhere" }).view_kind, null);
console.log("✓ Test 6 passed");

console.log("\nAll restart, swap, and collapse stability tests passed.");
process.exit(0);
