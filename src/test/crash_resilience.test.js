// Behavioral tests for the F4-spam crash mitigations: coalesced toggles, the re-entrant layout
// lock (src/locks.ts, transpiled in memory), and the byte-budgeted canvas cache in the webview.
const assert = require("assert");
const { loadOverview } = require("./helpers/overview_harness");
const { loadTs } = require("./helpers/load_ts");


const { createReentrantLock, createCoalescedToggle } = loadTs("../locks.ts");
const tick = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    console.log("=== Test Suite: Crash resilience (F4 spam) ===");

    console.log("\n--- Test 1: spammed toggles coalesce by parity ---");
    for (const [extraPresses, expectedRuns] of [[0, 1], [1, 2], [4, 1], [5, 2]]) {
        let runs = 0;
        const toggle = createCoalescedToggle(async () => { runs++; await tick(5); });
        const first = toggle();
        for (let i = 0; i < extraPresses; i++) toggle();
        await first;
        assert.strictEqual(runs, expectedRuns, `${extraPresses} presses during a toggle must run ${expectedRuns} toggle(s) total`);
    }
    console.log("✓ Test 1 passed");

    console.log("\n--- Test 2: layout lock never overlaps sequences ---");
    const lock = createReentrantLock();
    let active = 0;
    let maxActive = 0;
    const sequence = () => lock(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await tick(3);
        active--;
    });
    await Promise.all([sequence(), sequence(), sequence()]);
    assert.strictEqual(maxActive, 1, "two Zen/maximize sequences must never interleave");
    console.log("✓ Test 2 passed");

    console.log("\n--- Test 3: lock is re-entrant (close called from inside a toggle) ---");
    const order = [];
    await lock(async () => {
        order.push("outer-start");
        await lock(async () => { order.push("inner"); });
        order.push("outer-end");
    });
    assert.deepStrictEqual(order, ["outer-start", "inner", "outer-end"], "nested locked call must run inline, not deadlock");
    console.log("✓ Test 3 passed");

    console.log("\n--- Test 4: a failing sequence does not wedge the lock ---");
    await lock(async () => { throw new Error("boom"); }).catch(() => {});
    let ranAfterFailure = false;
    await lock(async () => { ranAfterFailure = true; });
    assert(ranAfterFailure, "the next sequence must still run after a failure");
    console.log("✓ Test 4 passed");

    console.log("\n--- Test 4b: a hung layout sequence cannot block the queue forever ---");
    const shortLock = createReentrantLock(20);
    shortLock(() => new Promise(() => {})); // e.g. a workbench command that never resolves
    let ranAfterHang = false;
    await shortLock(async () => { ranAfterHang = true; });
    assert(ranAfterHang, "the watchdog must release the queue after a hung task");
    let hungRuns = 0;
    const hungToggle = createCoalescedToggle(() => { hungRuns++; return new Promise(() => {}); }, fn => fn(), 20);
    await hungToggle();
    await hungToggle();
    assert.strictEqual(hungRuns, 2, "F4 must keep working after a toggle hangs (no swallowed presses)");
    console.log("✓ Test 4b passed");

    console.log("\n--- Test 4c: timers can detach from lock ownership ---");
    const detachLock = createReentrantLock();
    let innerRanInline = null;
    await detachLock(async () => {
        await new Promise(resolve => setTimeout(() => detachLock.exit(() => {
            // Detached: this call must queue behind the running task instead of running inline.
            let ranNow = false;
            detachLock(async () => { ranNow = true; });
            innerRanInline = ranNow;
            resolve();
        }), 1));
    });
    assert.strictEqual(innerRanInline, false, "a detached timer callback must not run locked work inline");
    console.log("✓ Test 4c passed");

    console.log("\n--- Test 5: canvas cache is bounded by bytes and releases evicted canvases ---");
    const h = loadOverview(["CanvasLRU"]);
    const { CanvasLRU } = h.exports;
    const makeCanvas = (w, h2) => ({ width: w, height: h2 });
    const cache = new CanvasLRU(100, 3 * 100 * 100 * 4); // room for three 100x100 canvases
    const a = makeCanvas(100, 100), b = makeCanvas(100, 100), c = makeCanvas(100, 100), d = makeCanvas(100, 100);
    cache.set("a", a);
    cache.set("b", b);
    cache.set("c", c);
    assert.strictEqual(cache.get("a"), a, "a is still cached and becomes most recently used");
    cache.set("d", d);
    assert.strictEqual(cache.get("b"), undefined, "the least recently used entry is evicted when bytes exceed the budget");
    assert.strictEqual(b.width, 0, "evicted canvases are shrunk to release their memory");
    assert.strictEqual(cache.get("a"), a, "a recently used entry survives eviction");
    assert(cache.bytes <= 3 * 100 * 100 * 4, "tracked bytes stay within budget");
    cache.clear();
    assert.strictEqual(cache.size, 0);
    assert.strictEqual(cache.bytes, 0);
    assert.strictEqual(a.width, 0, "clear releases every canvas");
    console.log("✓ Test 5 passed");

    console.log("\nAll crash resilience tests passed.");
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
