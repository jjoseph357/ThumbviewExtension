// Behavioral tests for spatial stability: ignoring a file inside a focused folder, or an item
// among folder cards, leaves an empty slot and every other tile keeps its exact position; the
// next added item fills the earliest hole it fits in (spanning holes keep their height). A fake
// host stores whatever the webview asks it to persist (saveLayoutOrder) and echoes it back in
// later payloads, as extension.ts does. Also checks the webview's generated copy of
// src/layout_core.ts is current and behaves like the source.
const assert = require("assert");
const path = require("path");
const { loadOverview } = require("./helpers/overview_harness");
const { loadTs } = require("./helpers/load_ts");

const h = loadOverview(["fillLayoutHoles"]);
const { flushFrames, resizeTo, onMessage, postedMessages } = h;
const { getData, fillLayoutHoles: webviewFill } = h.exports;

const host = { folderOrders: {}, folderCardOrders: {}, cardOrder: [], slotFootprints: {}, slotFlowCells: {}, folderWrapRows: {}, folderCardWrapRows: {}, cardWrapRows: null };
function applySaves() {
    for (const m of postedMessages.splice(0)) {
        if (m.command !== "saveLayoutOrder") continue;
        if (m.scope === "rootCards") host.cardOrder = m.ids;
        else if (m.scope === "folderCards") host.folderCardOrders[m.folder] = m.ids;
        else host.folderOrders[m.folder] = m.ids;
        const scopeKey = m.scope === "folderFiles" ? `folder:${m.folder}` : `cards:${m.scope === "folderCards" ? m.folder : ""}`;
        host.slotFootprints[scopeKey] = { ...(host.slotFootprints[scopeKey] || {}), ...(m.footprints || {}) };
        host.slotFlowCells[scopeKey] = { ...(host.slotFlowCells[scopeKey] || {}), ...(m.flowCells || {}) };
        if (typeof m.wrapRows === "number") {
            if (m.scope === "rootCards") host.cardWrapRows = m.wrapRows;
            else if (m.scope === "folderCards") host.folderCardWrapRows[m.folder] = m.wrapRows;
            else host.folderWrapRows[m.folder] = m.wrapRows;
        }
    }
}

function makeFile(p, lineCount = 20) {
    return {
        id: p, path: p, uri: `file:///ws/${p}`, lineCount,
        lines: [{ text: "const a = 1;" }, { text: "export { a };" }]
    };
}

function payload(files, mode, naturalCells = {}) {
    const all = files.map((f, i) => ({ ...f, slot: [i % 30, Math.floor(i / 30)] }));
    const cols = Math.max(4, Math.ceil(Math.sqrt(all.length * 16 / 9)));
    return {
        command: "data", mode, files: all,
        layout: { cols, rows: Math.max(4, Math.ceil(all.length / cols)) },
        naturalCells,
        slotFootprints: JSON.parse(JSON.stringify(host.slotFootprints)),
        slotFlowCells: JSON.parse(JSON.stringify(host.slotFlowCells)),
        folderOrders: JSON.parse(JSON.stringify(host.folderOrders)),
        folderCardOrders: JSON.parse(JSON.stringify(host.folderCardOrders)),
        cardOrder: [...host.cardOrder],
        folderWrapRows: { ...host.folderWrapRows },
        folderCardWrapRows: { ...host.folderCardWrapRows },
        cardWrapRows: host.cardWrapRows
    };
}

function send(msg) {
    onMessage({ data: msg });
    flushFrames();
    applySaves();
}

function fileCells() {
    const out = {};
    for (const f of getData().files) if (f._cell) out[f.id] = { ...f._cell };
    return out;
}

function cardCells() {
    const out = {};
    for (const c of getData()._folderCards || []) {
        out[c.path || c.folderPath || c.id] = { x: c.x, y: c.y };
    }
    for (const f of getData().files) if (f._cell) out[f.id] = { x: f._cell.x, y: f._cell.y };
    return out;
}

// Appending past the end can add a column, which scales every cell (like a window resize) but
// must never change any tile's column or row.
function gridIndex(cells, id) {
    const unitW = Math.min(...Object.values(cells).map(c => c.w));
    const unitH = Math.min(...Object.values(cells).map(c => c.h));
    return { col: Math.round((cells[id].x - 16) / unitW), row: Math.round((cells[id].y - 64) / unitH) };
}

function assertSameSlots(before, after, ids, label) {
    for (const id of ids) {
        assert(after[id], `${label}: ${id} must still be shown`);
        assert.deepStrictEqual(gridIndex(after, id), gridIndex(before, id), `${label}: ${id} must keep its column and row`);
    }
}

function assertUnmoved(before, after, ids, label) {
    for (const id of ids) {
        assert.deepStrictEqual(after[id], before[id], `${label}: ${id} must not move`);
    }
}

resizeTo(1600, 900);
flushFrames();

// --- Folder drill-down, both modes -------------------------------------------------------
for (const mode of ["uniform_grid", "spanning_grid"]) {
    console.log(`\n=== ${mode}: folder drill-down ===`);
    host.folderOrders = {};
    host.folderWrapRows = {};
    const spanning = mode === "spanning_grid";
    const folder = [];
    for (let i = 0; i < 12; i++) {
        const p = `src/f${String(i).padStart(2, "0")}.ts`;
        folder.push(makeFile(p, spanning && p === "src/f05.ts" ? 3000 : 20)); // f05 spans 3 cells
    }
    const alloc = { "src/f05.ts": spanning ? 3 : 1 };

    send(payload(folder, mode, alloc));
    send({ command: "setFocusedFolder", folder: "src/" });
    assert.deepStrictEqual(host.folderOrders["src/"], folder.map(f => f.id), "first view persists the order on screen");
    const before = fileCells();

    const ignoredId = "src/f05.ts";
    const remaining = folder.filter(f => f.id !== ignoredId);
    send(payload(remaining, mode, alloc));
    const afterIgnore = fileCells();
    assertUnmoved(before, afterIgnore, remaining.map(f => f.id), "ignore");
    assert.strictEqual(afterIgnore[ignoredId], undefined, "the ignored file leaves an empty slot");
    console.log(`✓ ${mode}: ignoring a file moves nothing`);

    // A shorter file fills the top of the hole; the remainder stays empty (Option B).
    const small = makeFile("src/new_small.ts", 20);
    send(payload([...remaining, small], mode, { ...alloc, [small.id]: 1 }));
    const afterSmall = fileCells();
    assert.strictEqual(afterSmall[small.id].x, before[ignoredId].x, "new file takes the hole's column");
    assert.strictEqual(afterSmall[small.id].y, before[ignoredId].y, "new file takes the hole's row");
    assertUnmoved(before, afterSmall, remaining.map(f => f.id), "fill");
    console.log(`✓ ${mode}: the next added file fills the empty slot and nothing moves`);

    if (spanning) {
        // A file taller than the remaining hole must not squeeze in; it appends instead.
        const tall = makeFile("src/new_tall.ts", 3000);
        send(payload([...remaining, small, tall], mode, { ...alloc, [small.id]: 1, [tall.id]: 3 }));
        const afterTall = fileCells();
        assertSameSlots(before, afterTall, remaining.map(f => f.id), "tall append");
        assertSameSlots(afterSmall, afterTall, [small.id], "tall append");
        console.log("✓ spanning_grid: a file taller than the free hole appends instead of re-flowing");

        // Unignoring the original after its hole was reused moves nothing already placed.
        send(payload([...remaining, small, tall, folder[5]], mode, { ...alloc, [small.id]: 1, [tall.id]: 3 }));
        assertSameSlots(afterTall, fileCells(), [...remaining.map(f => f.id), small.id, tall.id], "unignore");
        console.log("✓ spanning_grid: unignoring a file whose hole was reused moves nothing");
    }
    send({ command: "setFocusedFolder", folder: "" });
}

// --- Growth keeps column membership (folder view) --------------------------------------
console.log("\n=== spanning_grid: a growing file never pushes files into another column ===");
host.folderOrders = {};
host.folderWrapRows = {};
host.slotFlowCells = {};
host.slotFootprints = {};
{
    const files = [];
    for (let i = 0; i < 12; i++) files.push(makeFile(`lib2/g${String(i).padStart(2, "0")}.ts`, 20));
    send(payload(files, "spanning_grid"));
    send({ command: "setFocusedFolder", folder: "lib2/" });
    const before = fileCells();
    const colOf = (cells, id) => gridIndex(cells, id).col;
    const colsBefore = Object.fromEntries(files.map(f => [f.id, colOf(before, f.id)]));
    const widthBefore = before[files[0].id].w;
    const heightBefore = before[files[0].id].h;

    // g00 (top of column 0) grows to 3 cells: its column overflows the frozen height.
    const grown = files.map(f => (f.id === "lib2/g00.ts" ? makeFile(f.path, 3000) : f));
    send(payload(grown, "spanning_grid"));
    const after = fileCells();
    for (const f of files) {
        assert.strictEqual(colOf(after, f.id), colsBefore[f.id], `${f.id} must stay in its column when g00 grows`);
    }
    assert.strictEqual(Math.round(after["lib2/g00.ts"].h / after["lib2/g01.ts"].h), 3, "the grown file is drawn 3 cells tall");
    assert(after["lib2/g01.ts"].y > before["lib2/g01.ts"].y, "files below the grown file shift down within the column");
    const aspectBefore = widthBefore / heightBefore;
    const aspectAfter = after["lib2/g01.ts"].w / after["lib2/g01.ts"].h;
    assert(Math.abs(aspectAfter - aspectBefore) / aspectBefore < 0.35, `cells keep roughly their aspect ratio (${aspectBefore.toFixed(2)} -> ${aspectAfter.toFixed(2)})`);
    console.log("✓ growth: no file changes column; rows and columns were added to keep the cell aspect");

    send(payload(files, "spanning_grid"));
    const shrunk = fileCells();
    for (const f of files) {
        assert.strictEqual(colOf(shrunk, f.id), colsBefore[f.id], `${f.id} must stay in its column when g00 shrinks back`);
    }
    console.log("✓ shrink: no file changes column");
    send({ command: "setFocusedFolder", folder: "" });
}

// --- Growth keeps column membership (host root layout) -----------------------------------
console.log("\n=== host buildSpanningGrid: frozen flow cells keep columns when a file grows ===");
{
    const { buildSpanningGrid } = loadTs("../spanning_layout.ts");
    const files = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, path: `r${i}.ts`, lineCount: 20 }));
    const order = files.map(f => f.id);
    const first = buildSpanningGrid(files, order, {}, null);
    const flow = { ...first.allocations };
    const grownFiles = files.map(f => (f.id === "r0" ? { ...f, lineCount: 3000 } : f));
    const display = Object.fromEntries(grownFiles.map(f => [f.id, f.id === "r0" ? 3 : 1]));
    const grownLayout = buildSpanningGrid(grownFiles, order, flow, first.wrapRows, null, 16 / 9, 60, 0.05, display);
    const colBefore = Object.fromEntries(first.placements.map(p => [p.file.id, p.col]));
    for (const p of grownLayout.placements) {
        assert.strictEqual(p.col, colBefore[p.file.id], `${p.file.id} must keep its column at the root`);
    }
    assert.strictEqual(grownLayout.placements.find(p => p.file.id === "r0").nCells, 3, "r0 is displayed 3 cells tall");
    assert(grownLayout.rows > first.rows, "an overflowing column adds rows");
    assert(grownLayout.cols > first.cols, "columns are added in proportion to keep the cell aspect");
    console.log("✓ root: growth adds rows and columns instead of re-wrapping");
}

// --- Growth never flips the root into folder cards ---------------------------------------
console.log("\n=== growth-inflated grid does not trigger folder-card collapse ===");
{
    const files = [];
    for (let d = 0; d < 3; d++) for (let i = 0; i < 8; i++) files.push(makeFile(`pkg${d}/m${i}.ts`));
    const msg = payload(files, "spanning_grid");
    files.forEach((f, i) => { msg.files[i].slot = [Math.floor(i / 4), i % 4]; msg.files[i].nCells = 1; });
    // Display grid inflated by a grown file (40 cols would make reference cells unreadable);
    // the pre-overflow flow grid (6 x 4) is perfectly readable.
    msg.layout = { cols: 40, rows: 27, wrapRows: 4, flowCols: 6, flowRows: 4 };
    send(msg);
    assert.strictEqual((getData()._folderCards || []).length, 0, "root must stay in file-tile mode");
    console.log("✓ collapse checks use the pre-overflow grid");
}

// --- Root folder cards --------------------------------------------------------------------
console.log("\n=== folder cards: ignoring an item ===");
host.cardOrder = [];
const cardFiles = [];
for (let d = 0; d < 8; d++) {
    for (let i = 0; i < 60; i++) cardFiles.push(makeFile(`dir${d}/f${i}.ts`));
}
const rootFiles = [makeFile("a_root.ts"), makeFile("b_root.ts"), makeFile("c_root.ts")];
send(payload([...rootFiles, ...cardFiles], "uniform_grid"));
assert(host.cardOrder.length > 0, "first card view persists the card order");
const cardsBefore = cardCells();
assert(Object.keys(cardsBefore).length >= 9, "folder cards and root-file cards are laid out");
send(payload([rootFiles[0], rootFiles[2], ...cardFiles], "uniform_grid"));
const cardsAfter = cardCells();
const stillShown = Object.keys(cardsBefore).filter(id => id !== "b_root.ts");
assertUnmoved(cardsBefore, cardsAfter, stillShown, "card ignore");
console.log("✓ folder cards: ignoring a root file shown as a card moves no other card");

// --- Transition stability window ----------------------------------------------------------
console.log("\n=== reveal waits for the size to hold after a transition ===");
onMessage({ data: { command: "hideForTransition", transitionId: 100 } });
onMessage({ data: { command: "showAfterTransition", transitionId: 100 } });
flushFrames(4); // ~64ms
assert.strictEqual(document.body.style.opacity, "0", "not revealed before the settle window");
resizeTo(1500, 880); // late Zen/maximize animation step
flushFrames(4);
assert.strictEqual(document.body.style.opacity, "0", "a late resize restarts the settle window");
flushFrames();
assert.strictEqual(document.body.style.opacity, "1", "reveals once the new size holds");
console.log("✓ reveal waits for a stable size after the host's settled signal");

// --- Shared core is current ------------------------------------------------------------
console.log("\n=== webview's generated layout_core block matches src/layout_core.ts ===");
require("child_process").execFileSync(process.execPath, [path.join(__dirname, "../../scripts/sync-webview-core.mjs"), "--check"], { stdio: "inherit" });
const hostFill = loadTs("../layout_core.ts").fillLayoutHoles;
let seed = 7;
const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
for (let trial = 0; trial < 300; trial++) {
    const pool = Array.from({ length: 12 }, (_, i) => `id${i}`);
    const order = Array.from({ length: rand(12) }, () => (rand(5) === 0 ? "" : pool[rand(12)]))
        .filter((id, i, arr) => !id || arr.indexOf(id) === i);
    const live = pool.filter(() => rand(2) === 0);
    const cells = Object.fromEntries(pool.map(id => [id, 1 + rand(3)]));
    const sizedArgs = [order, live, id => cells[id], id => cells[id]];
    assert.deepStrictEqual(webviewFill(...sizedArgs), hostFill(...sizedArgs), `trial ${trial} sized`);
    assert.deepStrictEqual(webviewFill(order, live), hostFill(order, live), `trial ${trial} uniform`);
}
console.log("✓ the generated block is current, and 300 random orders give identical results");

console.log("\nAll folder ignore stability tests passed.");
process.exit(0);
