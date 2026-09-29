const assert = require("assert");
const fs = require("fs");
const path = require("path");

console.log("=== Test Suite: Expand and Reduce Grid Size Gap Preservation ===");

const { buildSpanningGrid } = require("../../out/spanning_layout.js");
const { reorderSpanningItems } = require("../../out/reorder_helpers.js");

// Test 1: Reproduce wrapRows adaptation inflating totalCells with empty gap tokens
// and shifting files into gaps when expanding or reducing grid size.
console.log("\n--- Test 1: 68 files - moving files to expanded space must not adapt wrapRows on expand/reduce ---");
{
    const files68 = Array.from({ length: 68 }, (_, i) => ({
        id: `file_${i}`,
        path: `src/file_${i}.ts`,
        uri: `file:///src/file_${i}.ts`,
        lineCount: i < 7 ? 1200 : 50
    }));
    const allocs68 = {};
    for (const f of files68) allocs68[f.id] = f.lineCount > 1000 ? 2 : 1;

    // Initial build: wrapRows is 6
    const initialLayout = buildSpanningGrid(files68, files68.map(f => f.id), allocs68);
    const initialWrapRows = initialLayout.wrapRows;
    console.log(`Initial layout: cols=${initialLayout.cols}, rows=${initialLayout.rows}, wrapRows=${initialWrapRows}`);

    // Col 0 initially has file_0 at row 0 (span 2), file_1 at row 2 (span 2), file_2 at row 4 (span 2)
    const p0_init = initialLayout.placements.find(p => p.file.id === "file_0");
    const p1_init = initialLayout.placements.find(p => p.file.id === "file_1");
    const p2_init = initialLayout.placements.find(p => p.file.id === "file_2");
    assert.strictEqual(p0_init.col, 0);
    assert.strictEqual(p0_init.row, 0);

    // User expands space once: cols increases
    const expandedCol = initialLayout.cols + 1;

    // User moves file_0 to expanded column (expandedCol, 0)
    const move1 = reorderSpanningItems(
        files68.map(f => f.id),
        files68.map(f => f.id),
        allocs68,
        "file_0",
        expandedCol,
        0,
        expandedCol + 1,
        initialLayout.rows + 1,
        initialWrapRows
    );

    // After move 1: slot (0, 0) is an empty gap. file_1 is at row 2, file_2 at row 4.
    const layoutAfterMove1 = buildSpanningGrid(files68, move1.newOrder, allocs68, move1.rows);
    const at00_afterMove1 = layoutAfterMove1.placements.find(p => p.col === 0 && p.row === 0);
    assert.strictEqual(at00_afterMove1, undefined, "Slot (0, 0) must be an empty gap left by file_0");
    assert.strictEqual(layoutAfterMove1.wrapRows, move1.rows, "wrapRows must strictly match move1.rows");

    // User now hits "Expand grid space" OR "Reduce grid space"
    // Host executes updateLayoutFromCache -> buildSpanningGrid(files68, move1.newOrder, allocs68, move1.rows)
    const hostLayoutOnExpand = buildSpanningGrid(files68, move1.newOrder, allocs68, move1.rows);
    
    // VERIFICATION: wrapRows must NOT adapt!
    assert.strictEqual(
        hostLayoutOnExpand.wrapRows,
        move1.rows,
        `wrapRows must remain ${move1.rows} and not adapt to ${hostLayoutOnExpand.wrapRows}`
    );

    // VERIFICATION: slot (0, 0) must NOT be filled by any file!
    const at00_onExpand = hostLayoutOnExpand.placements.find(p => p.col === 0 && p.row === 0);
    assert.strictEqual(
        at00_onExpand,
        undefined,
        `File ${at00_onExpand?.file?.id} must NOT move into gap left by file_0 at (0, 0) on Expand/Reduce!`
    );

    // VERIFICATION: file_1 and file_2 must remain at their exact slots
    const p1_expand = hostLayoutOnExpand.placements.find(p => p.file.id === "file_1");
    const p2_expand = hostLayoutOnExpand.placements.find(p => p.file.id === "file_2");
    assert.strictEqual(p1_expand.col, p1_init.col, "file_1 col must remain stable");
    assert.strictEqual(p1_expand.row, p1_init.row, "file_1 row must remain stable");
    assert.strictEqual(p2_expand.col, p2_init.col, "file_2 col must remain stable");
    assert.strictEqual(p2_expand.row, p2_init.row, "file_2 row must remain stable");

    console.log("✓ Test 1 passed: 68 files preserve gaps and wrapRows on expand/reduce grid space");
}

// Test 2: Moving files to rightmost expanded column, then reducing grid size must not drop files or move them into gaps
console.log("\n--- Test 2: Reducing grid space must not drop tiles beyond maxAllowedCols or fill gaps ---");
{
    const files = Array.from({ length: 12 }, (_, i) => ({
        id: `file_${i}`,
        path: `src/file_${i}.ts`,
        uri: `file:///src/file_${i}.ts`,
        lineCount: 50
    }));
    const allocs = {};
    for (const f of files) allocs[f.id] = 1;

    const initial = buildSpanningGrid(files, files.map(f => f.id), allocs);
    // Initial: 4 cols x 3 rows (wrapRows = 3)
    // Move file_0 to col 4 (expanded column)
    const move1 = reorderSpanningItems(
        files.map(f => f.id),
        files.map(f => f.id),
        allocs,
        "file_0",
        4, 0,
        5, 3,
        initial.wrapRows
    );

    // Move file_1 to col 4, row 1
    const move2 = reorderSpanningItems(
        files.map(f => f.id),
        move1.newOrder,
        allocs,
        "file_1",
        4, 1,
        5, 3,
        move1.rows
    );

    // Gaps exist at (0, 0) and (0, 1)
    const layoutBeforeReduce = buildSpanningGrid(files, move2.newOrder, allocs, move2.rows);
    assert.strictEqual(layoutBeforeReduce.placements.find(p => p.col === 0 && p.row === 0), undefined);
    assert.strictEqual(layoutBeforeReduce.placements.find(p => p.col === 0 && p.row === 1), undefined);

    // Now grid size is reduced (e.g. maxAllowedCols requested as 4)
    // When reorderSpanningItems runs on move2.newOrder with maxAllowedCols = 4:
    // It must NOT drop file_0 or file_1!
    const moveAfterReduce = reorderSpanningItems(
        files.map(f => f.id),
        move2.newOrder,
        allocs,
        "file_2",
        3, 2,
        4, 3, // caller requests maxAllowedCols = 4
        move2.rows
    );

    assert(moveAfterReduce.newOrder.includes("file_0"), "file_0 must not be dropped when maxAllowedCols < file col");
    assert(moveAfterReduce.newOrder.includes("file_1"), "file_1 must not be dropped when maxAllowedCols < file col");

    const layoutAfterReduce = buildSpanningGrid(files, moveAfterReduce.newOrder, allocs, moveAfterReduce.rows);
    const at00 = layoutAfterReduce.placements.find(p => p.col === 0 && p.row === 0);
    const at01 = layoutAfterReduce.placements.find(p => p.col === 0 && p.row === 1);
    assert.strictEqual(at00, undefined, "Slot (0, 0) must remain an empty gap after reduce");
    assert.strictEqual(at01, undefined, "Slot (0, 1) must remain an empty gap after reduce");

    console.log("✓ Test 2 passed: tiles beyond maxAllowedCols are preserved and do not fill gaps on reduce");
}

// Test 3: Webview host 'data' message must include fileOrder so consecutive moves don't lose gaps
console.log("\n--- Test 3: Webview retains data.fileOrder across host 'data' messages ---");
{
    const listeners = {};
    const mockElements = {};
    const mockCtx = {
        save: () => {}, restore: () => {}, fillRect: () => {}, strokeRect: () => {}, fillText: () => {},
        measureText: (t) => ({ width: (t || "").length * 6 }),
        beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, stroke: () => {}, fill: () => {},
        arc: () => {}, closePath: () => {}, rect: () => {}, clip: () => {}, drawImage: () => {},
        clearRect: () => {}, setLineDash: () => {}, setTransform: () => {}, scale: () => {},
        lineWidth: 1, fillStyle: "#000", strokeStyle: "#000", font: "10px sans-serif", globalAlpha: 1
    };
    const mockElement = (id) => {
        if (!mockElements[id]) {
            let _innerHTML = "";
            const children = [];
            const el = {
                id, style: {}, classList: { contains: () => false, add: () => {}, remove: () => {}, toggle: () => {} },
                appendChild: (child) => children.push(child), children, textContent: "", value: "",
                _listeners: {},
                addEventListener: (event, fn) => { el._listeners[event] = fn; listeners[id + ":" + event] = fn; },
                contains: () => false, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1920, height: 1080 }),
                getContext: () => mockCtx, clientWidth: 1920, clientHeight: 1080
            };
            Object.defineProperty(el, "innerHTML", { get: () => _innerHTML, set: (val) => { _innerHTML = val; } });
            mockElements[id] = el;
        }
        return mockElements[id];
    };

    const windowListeners = {};
    global.window = {
        innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1, _listeners: windowListeners,
        addEventListener: (event, fn) => { windowListeners[event] = fn; },
        removeEventListener: () => {}, focus: () => {}
    };
    global.MutationObserver = class { observe() {} disconnect() {} };
    global.document = {
        body: { classList: { contains: () => false }, style: {} },
        getElementById: (id) => mockElement(id),
        createElement: (tag) => {
            const children = [];
            return {
                tag, style: {}, classList: { contains: () => false, add: () => {}, remove: () => {}, toggle: () => {} },
                appendChild: (child) => children.push(child), children, innerHTML: "", textContent: "",
                title: "", onclick: null, getContext: () => mockCtx, width: 1920, height: 1080
            };
        },
        addEventListener: (event, fn) => { listeners["document:" + event] = fn; },
        hasFocus: () => true
    };
    global.getComputedStyle = () => ({ getPropertyValue: () => "" });
    const postedMessages = [];
    global.vscode = { postMessage: (msg) => { postedMessages.push(msg); }, getState: () => null, setState: () => {} };
    global.acquireVsCodeApi = () => global.vscode;
    global.requestAnimationFrame = (fn) => fn();
    global.cancelAnimationFrame = () => {};

    const overviewPath = path.join(__dirname, "../../media/overview.js");
    let code = fs.readFileSync(overviewPath, "utf8");
    code += `
    module.exports = {
        render, getData: () => data, setData: (d) => { data = d; },
        getActiveRenderGrid: () => activeRenderGrid,
        triggerExpandSpace, triggerReduceSpace,
        handleMessage: (msg) => window._listeners["message"]({ data: msg }),
        getUserReorderedFileSlots: () => userReorderedFileSlots,
        reorderSpanningItemsLocal: reorderSpanningItems
    };
    `;
    const mod = {};
    new Function("module", "exports", code)(mod, mod);
    const wv = mod.exports;

    const files = Array.from({ length: 12 }, (_, i) => ({
        id: `file_${i}`,
        path: `src/file_${i}.ts`,
        uri: `file:///src/file_${i}.ts`,
        lineCount: 50
    }));
    const allocs = {};
    for (const f of files) allocs[f.id] = 1;

    const initialLayout = buildSpanningGrid(files, files.map(f => f.id), allocs);
    const expectedOrderWithGaps = ["", "file_1", "file_2", "file_3", "file_4", "file_5", "file_6", "file_7", "file_8", "file_9", "file_10", "file_11", "file_0"];

    wv.handleMessage({
        command: "data",
        mode: "spanning_grid",
        files: initialLayout.placements.map(p => ({ ...p.file, slot: [p.col, p.row], nCells: p.nCells, slots: p.slots })),
        extraCols: 1,
        extraRows: 1,
        fileOrder: expectedOrderWithGaps,
        layout: {
            cols: initialLayout.cols + 1,
            rows: initialLayout.rows + 1,
            wrapRows: initialLayout.wrapRows
        }
    });

    const data = wv.getData();
    assert.deepStrictEqual(data.fileOrder, expectedOrderWithGaps, "data.fileOrder must be preserved when sent in data message");
    console.log("✓ Test 3 passed: webview preserves data.fileOrder from host data message");
}

console.log("\n=== ALL GAP PRESERVATION TESTS PASSED ===");
