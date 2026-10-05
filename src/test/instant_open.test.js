// Behavioral tests for first-open snappiness: render coalescing, reveal-after-stable-size,
// reopen transition gating, and raster/mosaic cache reuse. Uses the shared mock-DOM harness.
const assert = require("assert");
const { loadOverview } = require("./helpers/overview_harness");

const h = loadOverview(["fileTokenCache", "postSwitchAway", "isFrameFrozen"]);
const { rafQueue, flushFrames, counts, mockCtx, resizeTo, docListeners, onMessage } = h;
const { render, applyDataMessage, getData, fileTokenCache } = h.exports;
const fireWindow = (event) => h.fireWindow(event, { key: "F4" });

function makeDataMessage() {
    // 10 folders x 40 files: the 400-file grid is too dense for tiles at the reference
    // canvas size, so the root renders as folder cards with mini-mosaics.
    const files = [];
    const cols = 27;
    for (let f = 0; f < 10; f++) {
        for (let i = 0; i < 40; i++) {
            const idx = files.length;
            const p = `folder${f}/file${i}.ts`;
            files.push({
                id: p, path: p, uri: `file:///ws/${p}`, lineCount: 3,
                lines: [
                    { text: "const a = 1;", category: "normal", indent: 0, length: 12 },
                    { text: "function b() {}", category: "keyword", indent: 0, length: 15 },
                    { text: "export { a, b };", category: "keyword", indent: 0, length: 16 }
                ],
                slot: [idx % cols, Math.floor(idx / cols)]
            });
        }
    }
    // Folder mosaics need card mode, which this grid reaches at the pre-0.5.2 60 x 40 minimum tile size.
    return { command: "data", files, layout: { cols, rows: Math.ceil(files.length / cols) }, mode: "uniform_grid", minCellWidth: 60, minCellHeight: 40 };
}

console.log("=== Test Suite: Instant Open (render coalescing, stable reveal, mosaic cache) ===");

console.log("\n--- Test 1: Page starts hidden before any data arrives ---");
assert.strictEqual(document.body.style.opacity, "0", "body must start hidden so no frame at a transitional size is shown");
console.log("✓ Test 1 passed");

console.log("\n--- Test 2: A burst of host messages renders once per frame ---");
resizeTo(1000, 700);
flushFrames();
const before = counts.clearRect;
onMessage({ data: makeDataMessage() });
onMessage({ data: { command: "openState", openFiles: [], activeFileUri: null, viewLocations: {} } });
onMessage({ data: { command: "activeFile", uri: "file:///ws/folder0/file0.ts" } });
assert.strictEqual(counts.clearRect, before, "no synchronous renders while handling messages");
rafQueue.shift()();
assert.strictEqual(counts.clearRect - before, 1, "data + openState + activeFile must coalesce into exactly one render");
console.log("✓ Test 2 passed");

console.log("\n--- Test 3: Reveal waits until the rendered size holds for two frames ---");
assert.strictEqual(document.body.style.opacity, "0", "still hidden immediately after the first data render");
// Zen mode finishes expanding the editor area between the render and the stability check.
resizeTo(1600, 900);
flushFrames(2);
assert.strictEqual(document.body.style.opacity, "0", "must stay hidden when the size changed after rendering");
flushFrames();
assert.strictEqual(document.body.style.opacity, "1", "must reveal once a render at the final size holds");
console.log("✓ Test 3 passed");

console.log("\n--- Test 4: Re-rendering at the same size reuses folder mosaics and tile rasters ---");
render();
const canvasesAfterWarmRender = counts.offscreenCanvas;
render();
render();
assert.strictEqual(counts.offscreenCanvas, canvasesAfterWarmRender, "repeat renders must not rebuild any offscreen canvas");
console.log("✓ Test 4 passed");

console.log("\n--- Test 5: Payloads rebuild only the mosaics whose content changed ---");
applyDataMessage(makeDataMessage());
flushFrames();
assert.strictEqual(counts.offscreenCanvas, canvasesAfterWarmRender, "an identical payload must reuse every raster");
const changed = makeDataMessage();
changed.files[0].contentVersion = 2; // folder0/file0.ts edited
applyDataMessage(changed);
flushFrames();
assert(counts.offscreenCanvas > canvasesAfterWarmRender, "a changed file must rebuild its folder's mosaic");
console.log("✓ Test 5 passed");

console.log("\n--- Test 6: applyDataMessage is reachable from module scope (deferred-during-drag flush) ---");
assert.strictEqual(typeof applyDataMessage, "function");
console.log("✓ Test 6 passed");

console.log("\n--- Test 7: A viewport resize repaints full-size before the next frame ---");
flushFrames();
const map = document.getElementById("map");
assert(map.width > 0, "canvas has a backing store after rendering");
let stretchDraws = 0;
const origDrawImage = mockCtx.drawImage;
mockCtx.drawImage = (...args) => { if (args.length === 5) stretchDraws++; };
resizeTo(1800, 1000);
assert.strictEqual(map.width, 1800, "backing store must match the new viewport inside the ResizeObserver callback");
assert.strictEqual(stretchDraws, 1, "the previous frame must be stretched to the new size before paint");
assert(rafQueue.length > 0, "a sharp render must still be scheduled for the next frame");
mockCtx.drawImage = origDrawImage;
flushFrames();
console.log("✓ Test 7 passed");

console.log("\n--- Test 8: Search index follows edits below line 1 ---");
function singleFilePayload(secondLine, contentVersion) {
    const msg = makeDataMessage();
    msg.files[0].contentVersion = contentVersion;
    msg.files[0].lines = [{ text: "const a = 1;" }, { text: secondLine }, { text: "export { a };" }];
    return msg;
}
applyDataMessage(singleFilePayload("let oldName = 2;", 1));
flushFrames();
assert(getData().files[0]._combinedText.includes("oldname"));
applyDataMessage(singleFilePayload("let newName = 2;", 2));
flushFrames();
assert(getData().files[0]._combinedText.includes("newname"), "edited text must be searchable");
assert(!getData().files[0]._combinedText.includes("oldname"), "replaced text must no longer match");
console.log("✓ Test 8 passed");

console.log("\n--- Test 9: Search index cache drops files that leave the payload ---");
const smaller = makeDataMessage();
smaller.files = smaller.files.slice(0, 5);
applyDataMessage(smaller);
flushFrames();
assert.strictEqual(fileTokenCache.size, 5, "cache must be bounded by the files in the latest payload");
console.log("✓ Test 9 passed");

console.log("\n--- Test 10: Resizing back to a previous size reuses cached rasters ---");
resizeTo(1200, 750);
flushFrames();
resizeTo(1500, 850);
flushFrames();
const canvasesBeforeReturn = counts.offscreenCanvas;
resizeTo(1200, 750);
flushFrames();
assert.strictEqual(counts.offscreenCanvas, canvasesBeforeReturn, "a resize must not discard size-keyed rasters");
console.log("✓ Test 10 passed");

console.log("\n--- Test 11: Reopen stays hidden until the transition ends and a stable frame exists ---");
assert.strictEqual(document.body.style.opacity, "1");
onMessage({ data: { command: "hideForTransition" } });
assert.strictEqual(document.body.style.opacity, "0", "exit must hide the page");
// Zen exit resizes the still-visible panel: a stable render must NOT reveal mid-transition.
resizeTo(1000, 700);
flushFrames();
assert.strictEqual(document.body.style.opacity, "0", "no reveal while the host transition is in flight");
// Panel is backgrounded, then reopened at full size.
document.hidden = true;
document.visibilityState = "hidden";
docListeners["visibilitychange"]();
document.hidden = false;
document.visibilityState = "visible";
resizeTo(1600, 900);
onMessage({ data: { command: "showAfterTransition" } });
assert.strictEqual(document.body.style.opacity, "0", "showAfterTransition alone must not reveal before a frame exists");
docListeners["visibilitychange"]();
flushFrames();
assert.strictEqual(document.body.style.opacity, "1", "reveals once a render at the reopened size holds");
console.log("✓ Test 11 passed");

console.log("\n--- Test 11b: Reopen at the size last shown reveals immediately (no black flash) ---");
assert.strictEqual(document.body.style.opacity, "1");
onMessage({ data: { command: "hideForTransition", transitionId: 10 } }); // close
const clearsBeforeClose = counts.clearRect;
resizeTo(1000, 700); // Zen exit shrinks the still-visible panel
flushFrames();
assert.strictEqual(counts.clearRect, clearsBeforeClose, "drawing is frozen during a close so the last shown frame survives");
// Retained webviews may be hidden without document.visibilityState changing, so rely only on
// the host's panelHidden signal here.
onMessage({ data: { command: "panelHidden" } });
onMessage({ data: { command: "hideForTransition", transitionId: 11 } }); // reopen starts
resizeTo(1600, 900); // Zen re-entered: back to the size last shown
assert.strictEqual(document.body.style.opacity, "1", "must reveal at once, before the host's settled signal");
onMessage({ data: { command: "showAfterTransition", transitionId: 11 } });
flushFrames();
console.log("✓ Test 11b passed");

console.log("\n--- Test 11c: After a jump (page not hidden), reopening at the same size is instant ---");
assert.strictEqual(document.body.style.opacity, "1");
flushFrames();
// Jump: the host shows the target editor over Thumbview without hiding the page, then exits Zen.
onMessage({ data: { command: "panelHidden" } });
const clearsWhileBackgrounded = counts.clearRect;
resizeTo(1000, 700); // Zen exit resizes the backgrounded panel
flushFrames();
assert.strictEqual(counts.clearRect, clearsWhileBackgrounded, "a backgrounded panel must not redraw at transitional sizes");
onMessage({ data: { command: "hideForTransition", transitionId: 15, fromHidden: true } }); // reopen
resizeTo(1600, 900);
assert.strictEqual(document.body.style.opacity, "1", "reopen after a jump must reveal the kept frame at once");
onMessage({ data: { command: "showAfterTransition", transitionId: 15 } });
flushFrames();
assert(counts.clearRect > clearsWhileBackgrounded, "drawing resumes once the panel is shown");
console.log("✓ Test 11c passed");

console.log("\n--- Test 12: Spammed toggles: stale show and keypresses cannot reveal mid-transition ---");
assert.strictEqual(document.body.style.opacity, "1");
onMessage({ data: { command: "hideForTransition", transitionId: 20 } }); // close
onMessage({ data: { command: "hideForTransition", transitionId: 21 } }); // reopen starts
fireWindow("keydown"); // F4 spam reaches the focused webview
flushFrames();
assert.strictEqual(document.body.style.opacity, "0", "keydown during a transition must not reveal");
onMessage({ data: { command: "showAfterTransition", transitionId: 20 } }); // delayed show from the close
flushFrames();
assert.strictEqual(document.body.style.opacity, "0", "a stale show from an earlier transition must be ignored");
onMessage({ data: { command: "hideForTransition", transitionId: 19 } }); // out-of-order older hide
onMessage({ data: { command: "showAfterTransition", transitionId: 21 } });
flushFrames();
assert.strictEqual(document.body.style.opacity, "1", "the current transition's show reveals once a frame holds");
fireWindow("keydown");
assert.strictEqual(document.body.style.opacity, "1", "input outside a transition keeps the page visible");
console.log("✓ Test 12 passed");

console.log("\n--- Test 13: A transition ending below the minimum size still reveals (too-small hint) ---");
onMessage({ data: { command: "hideForTransition", transitionId: 22 } });
resizeTo(150, 120);
onMessage({ data: { command: "showAfterTransition", transitionId: 22 } });
flushFrames();
assert.strictEqual(document.body.style.opacity, "1", "must not stay blank when the panel is too small");
resizeTo(1600, 900);
flushFrames();
console.log("✓ Test 13 passed");

console.log("\n--- Test 14: Opening a file stops drawing until Thumbview is hidden or back in use ---");
const { postSwitchAway, isFrameFrozen } = h.exports;
h.postedMessages.length = 0;
assert.strictEqual(isFrameFrozen(), false);
postSwitchAway({ command: "jump", uri: "file:///ws/a.ts", line: 0 });
assert(h.postedMessages.some(m => m.command === "jump"), "the jump is still posted");
assert.strictEqual(isFrameFrozen(), true, "no full-grid repaints while VS Code rebuilds its layout");
fireWindow("keydown");
assert.strictEqual(isFrameFrozen(), false, "input means Thumbview is still in front, so it draws again");
postSwitchAway({ command: "jump", uri: "file:///ws/a.ts", line: 0 });
onMessage({ data: { command: "panelHidden" } });
assert.strictEqual(isFrameFrozen(), true, "the hidden-panel freeze takes over");
onMessage({ data: { command: "hideForTransition", transitionId: 30, fromHidden: true } });
onMessage({ data: { command: "showAfterTransition", transitionId: 30 } });
flushFrames();
assert.strictEqual(isFrameFrozen(), false, "reopening draws again");
postSwitchAway({ command: "jump", uri: "file:///ws/missing.ts", line: 0 });
setTimeout(() => {
    try {
        assert.strictEqual(isFrameFrozen(), false, "a failed open (Thumbview never hidden) unfreezes on its own");
        console.log("✓ Test 14 passed");
        console.log("\nAll instant-open tests passed.");
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}, 2100);
