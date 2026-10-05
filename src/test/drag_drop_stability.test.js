// Real mouse drags in the webview (spanning root), checked against the host's own layout of the
// order the webview sends: a two-tall tile grabbed by its lower half moves down exactly one row; a
// drop on empty space below a file that grew moves only the dropped tile; and after any drop no two
// tiles are drawn over each other (the webview lays every tile out from the new order).
const assert = require("assert");
const { loadOverview } = require("./helpers/overview_harness");
const { buildSpanningGrid } = require("../../out/spanning_layout");
const { cellsNeeded } = require("../../out/layout_core");

global.MouseEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
const h = loadOverview([]);
h.resizeTo(1200, 800);
h.flushFrames();
const { getData } = h.exports;

// lineCount 300 is one cell, 1500 two cells (cellsNeeded at 60 lines per cell, 5%).
const mk = (id, lines) => ({ id, path: `w/${id}.ts`, uri: `file:///ws/w/${id}.ts`, lineCount: lines, contentVersion: 1, lines: ["x"] });

let hostSeq = 0;
function send(files, order, flowOverrides = {}) {
    const flow = {};
    for (const f of files) flow[f.id] = flowOverrides[f.id] || undefined;
    for (const k of Object.keys(flow)) if (flow[k] === undefined) delete flow[k];
    // Drawn heights follow the line count, as extension.ts computes them (displayCells).
    const display = Object.fromEntries(files.map(f => [f.id, cellsNeeded(f.lineCount, 60, 0.05)]));
    const layout = buildSpanningGrid(files, order, flow, 3, null, 16 / 9, 60, 0.05, display);
    const payloadFiles = layout.placements.map(p => ({ ...p.file, slot: [p.col, p.row], slots: p.slots, nCells: p.nCells }));
    h.onMessage({ data: {
        command: "data", mode: "spanning_grid", files: payloadFiles, fileOrder: order,
        slotFlowCells: { root: layout.allocations },
        layout: { cols: layout.cols, rows: layout.rows, wrapRows: layout.wrapRows, flowCols: layout.flowCols, flowRows: layout.flowRows, baseFlowCols: layout.flowCols, baseFlowRows: layout.flowRows },
        dragReorderMode: "swap", minCellWidth: 10, minCellHeight: 10,
        reorderSeq: hostSeq // as the host does: the last drop it has processed
    } });
    h.flushFrames();
    return layout;
}

function drag(file, fromY, toY) {
    const ev = (type, x, y, buttons) => h.fireElement("map", type, { type, button: 0, buttons, clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} });
    const x = file._cell.x + file._cell.w / 2;
    h.postedMessages.length = 0;
    ev("mousedown", x, fromY, 1);
    ev("mousemove", x, fromY + 5, 1);
    h.flushFrames(2);
    ev("mousemove", x, toY, 1);
    h.flushFrames(2);
    ev("mouseup", x, toY, 0);
    h.flushFrames(3);
    const msg = h.postedMessages.filter(m => m.command === "reorderFile").pop();
    if (msg) hostSeq = msg.reorderSeq;
    return msg;
}

function assertNoOverlap(label) {
    const seen = new Map();
    for (const f of getData().files) {
        for (const s of f.slots || [f.slot]) {
            const key = `${s[0]},${s[1]}`;
            assert(!seen.has(key), `${label}: ${f.id} and ${seen.get(key)} are drawn in the same cell ${key}`);
            seen.set(key, f.id);
        }
    }
}

function slotsById() {
    return Object.fromEntries(getData().files.map(f => [f.id, String(f.slot)]));
}

console.log("--- Test 1: a two-tall tile grabbed by its lower half moves down one row ---");
{
    const files = [mk("T", 1500), mk("a", 300), mk("b", 300), mk("c", 300), mk("d", 300), mk("e", 300)];
    const order = ["T", "", "", "a", "b", "", "c", "d", "e"];
    send(files, order);
    const before = slotsById();
    const T = getData().files.find(f => f.id === "T");
    const cellH = T._cell.h / 2;
    const msg = drag(T, T._cell.y + cellH * 1.5, T._cell.y + cellH * 2.5);
    assert(msg, "the move is sent to the host");
    const after = slotsById();
    assert.strictEqual(after.T, "0,1", `T moves down one row, not two (${after.T})`);
    for (const id of ["a", "b", "c", "d", "e"]) assert.strictEqual(after[id], before[id], `${id} does not move`);
    // The host lays out the order it receives exactly as the webview drew it.
    const host = buildSpanningGrid(files, msg.currentOrder, {}, msg.wrapRows, null, 16 / 9, 60, 0.05, Object.fromEntries(files.map(f => [f.id, cellsNeeded(f.lineCount, 60, 0.05)])));
    for (const p of host.placements) assert.strictEqual(`${p.col},${p.row}`, after[p.file.id], `host and webview agree on ${p.file.id}`);
    assertNoOverlap("after moving T");
}
console.log("✓ Test 1 passed");

console.log("--- Test 2: below a file that grew, a drop on empty space moves only the dropped tile ---");
{
    // g's flow is one cell but it is drawn three tall (it grew), so drawn rows below it differ from flow rows.
    const files = [mk("g", 3000), mk("a", 300), mk("p", 300), mk("q", 300)];
    // Column 0 is g (flow 1, drawn 3), an empty cell (flow row 1, drawn row 3), then a (flow row 2, drawn row 4).
    const order = ["g", "", "a", "", "", "", "p", "q", ""];
    send(files, order, { g: 1 });
    const before = slotsById();
    const p = getData().files.find(f => f.id === "p");
    const a = getData().files.find(f => f.id === "a");
    // Drop p into column 0, on the empty cell drawn just above a (drawn row 3, flow row 1).
    const cellH = p._cell.h;
    const ev = (type, x, y, buttons) => h.fireElement("map", type, { type, button: 0, buttons, clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} });
    h.postedMessages.length = 0;
    const px = p._cell.x + p._cell.w / 2, py = p._cell.y + cellH / 2;
    const tx = a._cell.x + a._cell.w / 2, ty = a._cell.y - cellH / 2;
    ev("mousedown", px, py, 1);
    ev("mousemove", px + 5, py, 1);
    h.flushFrames(2);
    ev("mousemove", tx, ty, 1);
    h.flushFrames(2);
    ev("mouseup", tx, ty, 0);
    h.flushFrames(3);
    const after = slotsById();
    for (const id of ["g", "a", "q"]) assert.strictEqual(after[id], before[id], `${id} does not move (${before[id]} -> ${after[id]})`);
    assert.strictEqual(after.p, "0,3", `p lands on the cell it was dropped on (${after.p})`);
    assertNoOverlap("after dropping p below a grown file");
}
console.log("✓ Test 2 passed");

console.log("--- Test 3: the first drop after a reflow does not add an empty row ---");
{
    // A reflowed layout: compact order, no saved column height (the host computes it).
    const files = Array.from({ length: 61 }, (_, i) => mk(`r${i}`, [300, 1500, 300, 3000, 300][i % 5]));
    const order = files.map(f => f.id);
    const display = Object.fromEntries(files.map(f => [f.id, cellsNeeded(f.lineCount, 60, 0.05)]));
    const layout = buildSpanningGrid(files, order, {}, null, null, 16 / 9, 60, 0.05, display);
    const payloadFiles = layout.placements.map(p => ({ ...p.file, slot: [p.col, p.row], slots: p.slots, nCells: p.nCells }));
    h.onMessage({ data: {
        command: "data", mode: "spanning_grid", files: payloadFiles, fileOrder: order, slotFlowCells: { root: layout.allocations },
        layout: { cols: layout.cols, rows: layout.rows, wrapRows: layout.wrapRows, flowCols: layout.flowCols, flowRows: layout.flowRows, baseFlowCols: layout.flowCols, baseFlowRows: layout.flowRows },
        dragReorderMode: "swap", minCellWidth: 10, minCellHeight: 10, reorderSeq: hostSeq
    } });
    h.flushFrames();
    const rowsBefore = getData().layout.rows;
    const a = getData().files.find(f => f.id === "r0");
    const b = getData().files.find(f => f.id === "r2");
    const ev = (type, x, y, buttons) => h.fireElement("map", type, { type, button: 0, buttons, clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} });
    const ax = a._cell.x + a._cell.w / 2, ay = a._cell.y + 10, bx = b._cell.x + b._cell.w / 2, by = b._cell.y + 10;
    ev("mousedown", ax, ay, 1);
    ev("mousemove", ax + 6, ay, 1);
    h.flushFrames(2);
    ev("mousemove", bx, by, 1);
    h.flushFrames(2);
    ev("mouseup", bx, by, 0);
    h.flushFrames(3);
    assert.strictEqual(getData().layout.rows, rowsBefore, `the grid keeps ${rowsBefore} rows (got ${getData().layout.rows})`);
    assertNoOverlap("after the first drop following a reflow");
}
console.log("✓ Test 3 passed");

console.log("\nAll drag and drop stability tests passed.");
process.exit(0);
