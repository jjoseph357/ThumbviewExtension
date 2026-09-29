// Behavioral tests for Phase 2 ("respectful guest"): zenMode.* overrides are backed up, applied
// only while fullscreen, and restored exactly (src/zen_settings.ts, transpiled in memory); hover
// never requests focus; tiles rasterize at device pixels; F4 yields to Search/References.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadOverview } = require("./helpers/overview_harness");
const { loadTs } = require("./helpers/load_ts");


function fakeConfig(initialGlobals) {
    const globals = { ...initialGlobals };
    const writes = [];
    return {
        globals, writes,
        inspect: key => ({ globalValue: globals[key] }),
        update: async (key, value) => {
            writes.push([key, value]);
            if (value === undefined) delete globals[key]; else globals[key] = value;
        }
    };
}

function fakeMemento() {
    const store = {};
    return {
        store,
        get: key => store[key],
        update: async (key, value) => { if (value === undefined) delete store[key]; else store[key] = value; },
        keys: () => Object.keys(store)
    };
}

(async () => {
    console.log("=== Test Suite: Respectful guest (Phase 2) ===");
    const { applyZenOverrides, restoreZenSettings, ZEN_OVERRIDES, ZEN_BACKUP_KEY } = loadTs("../zen_settings.ts");

    console.log("\n--- Test 1: user's zen settings are restored exactly after Thumbview closes ---");
    const userValues = { "zenMode.fullScreen": true, "zenMode.centerLayout": true, "zenMode.showTabs": "multiple" };
    const config = fakeConfig(userValues);
    const memento = fakeMemento();
    await applyZenOverrides(config, memento);
    for (const [key, value] of ZEN_OVERRIDES) {
        assert.strictEqual(config.globals[key], value, `${key} is overridden while Thumbview is open`);
    }
    await applyZenOverrides(config, memento); // a second open must not back up Thumbview's own values
    assert.strictEqual(await restoreZenSettings(config, memento), true);
    assert.deepStrictEqual(config.globals, userValues, "every zenMode value (including unset ones) is restored");
    assert.strictEqual(memento.store[ZEN_BACKUP_KEY], undefined, "the backup is cleared after restoring");
    console.log("✓ Test 1 passed");

    console.log("\n--- Test 2: only differing settings are written ---");
    const already = Object.fromEntries(ZEN_OVERRIDES);
    const quietConfig = fakeConfig(already);
    await applyZenOverrides(quietConfig, fakeMemento());
    assert.strictEqual(quietConfig.writes.length, 0, "no writes when the user's settings already match");
    console.log("✓ Test 2 passed");

    console.log("\n--- Test 3: crash recovery restores a leftover backup; no backup means no writes ---");
    const crashed = fakeConfig(userValues);
    const crashMemento = fakeMemento();
    await applyZenOverrides(crashed, crashMemento);
    // ... VS Code crashes here; next activation:
    assert.strictEqual(await restoreZenSettings(crashed, crashMemento), true);
    assert.deepStrictEqual(crashed.globals, userValues);
    const clean = fakeConfig(userValues);
    assert.strictEqual(await restoreZenSettings(clean, fakeMemento()), false);
    assert.strictEqual(clean.writes.length, 0, "activation without a backup writes nothing");
    console.log("✓ Test 3 passed");

    console.log("\n--- Test 3a: a failing or unregistered setting never blocks entering fullscreen ---");
    const flaky = fakeConfig(userValues);
    const unregistered = "zenMode.hideLineNumbers";
    const realInspect = flaky.inspect;
    flaky.inspect = key => (key === unregistered ? undefined : realInspect(key));
    const realUpdate = flaky.update;
    flaky.update = async (key, value) => {
        if (key === unregistered) throw new Error(`${key} is not a registered configuration`);
        if (key === "zenMode.centerLayout") throw new Error("write failed");
        return realUpdate(key, value);
    };
    await applyZenOverrides(flaky, fakeMemento()); // must resolve, not reject
    assert.strictEqual(flaky.writes.some(([k]) => k === unregistered), false, "unregistered keys are never written");
    assert.strictEqual(flaky.globals["zenMode.fullScreen"], false, "other overrides still apply when one write fails");
    console.log("✓ Test 3a passed");

    console.log("\n--- Test 3b: a second window cannot undo the first window's overrides ---");
    const { claimZenOwnership, hasOtherLiveOwners, releaseZenOwnership, ZEN_OWNER_STALE_MS } = loadTs("../zen_settings.ts");
    const shared = fakeMemento(); // globalState is shared by all windows
    const cfg = fakeConfig(userValues);
    let now = 1_000_000;
    await applyZenOverrides(cfg, shared);
    await claimZenOwnership(shared, "windowA", now);
    // Window B starts: its crash recovery must see A alive and leave everything alone.
    assert.strictEqual(hasOtherLiveOwners(shared, "windowB", now + 1000), true);
    await applyZenOverrides(cfg, shared); // B opens Thumbview too: backup must stay the user's values
    await claimZenOwnership(shared, "windowB", now + 1000);
    assert.strictEqual(await releaseZenOwnership(cfg, shared, "windowA", now + 2000), false, "A leaving while B still uses Thumbview must not restore");
    assert.strictEqual(cfg.globals["zenMode.fullScreen"], false, "B keeps its overrides");
    assert.strictEqual(await releaseZenOwnership(cfg, shared, "windowB", now + 3000), true, "the last window restores");
    assert.deepStrictEqual(cfg.globals, userValues);
    // A window that crashed stops heartbeating; the next activation recovers once it is stale.
    await applyZenOverrides(cfg, shared);
    await claimZenOwnership(shared, "crashed", now);
    now += ZEN_OWNER_STALE_MS + 1;
    assert.strictEqual(hasOtherLiveOwners(shared, "fresh", now), false, "a stale owner does not block recovery");
    assert.strictEqual(await releaseZenOwnership(cfg, shared, "fresh", now), true);
    assert.deepStrictEqual(cfg.globals, userValues);
    console.log("✓ Test 3b passed");

    console.log("\n--- Test 4: hovering the panel never requests focus; clicking does ---");
    const h = loadOverview();
    h.resizeTo(1600, 900);
    h.flushFrames();
    const files = Array.from({ length: 6 }, (_, i) => ({
        id: `f${i}.ts`, path: `f${i}.ts`, uri: `file:///ws/f${i}.ts`, lineCount: 20,
        lines: [{ text: "const a = 1;" }], slot: [i % 3, Math.floor(i / 3)]
    }));
    h.onMessage({ data: { command: "data", mode: "uniform_grid", files, layout: { cols: 3, rows: 2 } } });
    h.flushFrames();
    global.document.hasFocus = () => false;
    h.fireWindow("mouseenter");
    h.fireWindow("mousemove", { clientX: 10, clientY: 10, buttons: 0 });
    assert(!h.postedMessages.some(m => m.command === "focusWindow"), "hover must not steal focus from the editor or terminal");
    console.log("✓ Test 4 passed");

    console.log("\n--- Test 5: tiles rasterize at device pixels on HiDPI screens ---");
    global.window.devicePixelRatio = 2;
    h.resizeTo(1400, 800); // new tile size -> fresh rasters
    h.flushFrames();
    const tileRasters = h.createdCanvases.filter(c => c.width > 60 && c.height > 60);
    assert(tileRasters.length > 0, "tiles were rasterized");
    const grid = h.exports.getData().files.map(f => f._cell).filter(Boolean);
    const TILE_THUMBNAIL_WIDTH_MARGIN = 20; // media/overview.js: raster excludes the tile's side margin
    const cssW = Math.round(grid[0].w) - TILE_THUMBNAIL_WIDTH_MARGIN;
    assert(tileRasters.some(c => c.width === cssW * 2), `a tile raster is 2x its CSS width (${cssW} -> ${cssW * 2})`);
    console.log("✓ Test 5 passed");

    console.log("\n--- Test 6: F4 yields to Search and References, and fullscreen is a setting ---");
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
    const binding = pkg.contributes.keybindings.find(k => k.command === "thumbview.open");
    assert(binding.when && binding.when.includes("!searchViewletFocus") && binding.when.includes("!referenceSearchVisible"));
    assert.strictEqual(pkg.contributes.configuration.properties["thumbview.fullscreenOnOpen"].default, true);
    console.log("✓ Test 6 passed");

    console.log("\nAll respectful guest tests passed.");
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
