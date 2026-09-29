// Behavioral tests for Phase 4 accessibility: keyboard navigation of the canvas grid (spatial
// arrows, Home/End, Enter, Shift+F10, Alt+Arrow tile moves), screen-reader announcements, text
// status badges, and accessible names in the webview markup.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadOverview } = require("./helpers/overview_harness");

const dispatched = [];
global.MouseEvent = class {
    constructor(type, init) {
        this.type = type;
        Object.assign(this, init);
    }
};

const h = loadOverview(["tileStatusBadge"]);
const { onMessage, flushFrames, postedMessages, fireWindow, canvas } = h;
const { tileStatusBadge } = h.exports;
canvas.dispatchEvent = event => { dispatched.push(event); return true; };
const srStatus = global.document.getElementById("sr-status");

h.resizeTo(1600, 900);
flushFrames();
// 3 x 2 uniform grid: f0 f1 f2 / f3 f4 f5
const files = Array.from({ length: 6 }, (_, i) => ({
    id: `f${i}.ts`, path: `src/f${i}.ts`, uri: `file:///ws/src/f${i}.ts`, lineCount: 40 + i,
    contentVersion: 1, lines: [{ text: `const f${i} = ${i};` }], slot: [i % 3, Math.floor(i / 3)],
    gitStatus: i === 4 ? "modified" : undefined, errorCount: i === 4 ? 2 : 0
}));
onMessage({ data: { command: "data", mode: "uniform_grid", files, layout: { cols: 3, rows: 2 } } });
flushFrames();

const key = (k, extra = {}) => fireWindow("keydown", { key: k, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...extra });

console.log("=== Test Suite: Accessibility (Phase 4) ===");

console.log("\n--- Test 1: arrow keys move focus spatially and announce the tile ---");
key("ArrowRight");
assert(srStatus.textContent.startsWith("src/f0.ts"), `first arrow focuses the first tile (${srStatus.textContent})`);
key("ArrowRight");
assert(srStatus.textContent.startsWith("src/f1.ts"));
key("ArrowDown");
assert(srStatus.textContent.startsWith("src/f4.ts"), "down moves to the tile below, not the next in order");
assert(srStatus.textContent.includes("modified") && srStatus.textContent.includes("2 errors"), "status is announced in words");
key("ArrowLeft");
assert(srStatus.textContent.startsWith("src/f3.ts"));
key("End");
assert(srStatus.textContent.startsWith("src/f5.ts"));
key("Home");
assert(srStatus.textContent.startsWith("src/f0.ts"));
console.log("✓ Test 1 passed");

console.log("\n--- Test 2: Enter opens the focused file ---");
postedMessages.length = 0;
key("Enter");
const jump = postedMessages.find(m => m.command === "jump");
assert(jump && jump.uri === "file:///ws/src/f0.ts", "Enter posts the same jump message a click does");
postedMessages.length = 0;
key(" ");
assert(postedMessages.some(m => m.command === "jump" && m.uri === "file:///ws/src/f0.ts"), "Space activates the focused tile instead of starting a search");
console.log("✓ Test 2 passed");

console.log("\n--- Test 3: Shift+F10 and Alt+Arrow reuse the mouse paths ---");
key("F10", { shiftKey: true });
assert.strictEqual(dispatched.pop().type, "contextmenu", "Shift+F10 opens the tile's context menu");
dispatched.length = 0;
key("ArrowRight", { altKey: true });
assert.deepStrictEqual(dispatched.map(e => e.type), ["mousedown", "mousemove", "mousemove", "mouseup"], "Alt+Arrow replays a drag");
const cellW = files.length && getCellW();
function getCellW() {
    const cells = h.exports.getData().files.map(f => f._cell).filter(Boolean);
    return cells[1].x - cells[0].x;
}
assert(Math.abs((dispatched[3].clientX - dispatched[0].clientX) - cellW) < 1, "the drop is exactly one cell to the right");
console.log("✓ Test 3 passed");

console.log("\n--- Test 4: status is shown as text, not only color ---");
assert.strictEqual(tileStatusBadge({ errorCount: 2, gitStatus: "modified" }), "2, M");
assert.strictEqual(tileStatusBadge({ gitStatus: "untracked" }), "U");
assert.strictEqual(tileStatusBadge({}), "");
console.log("✓ Test 4 passed");

console.log("\n--- Test 4b: the one-time fullscreen banner ---");
const notice = global.document.getElementById("fullscreen-notice");
notice.hidden = true;
global.document.getElementById("fullscreen-notice-text").textContent = "Thumbview opens fullscreen so code stays readable.";
onMessage({ data: { command: "fullscreenNotice", keybinding: "F6" } });
assert.strictEqual(notice.hidden, false, "the banner is shown");
assert.strictEqual(global.document.getElementById("fullscreen-notice-key").textContent, "F6", "it names the user's own keybinding");
assert(srStatus.textContent.startsWith("Thumbview opens fullscreen"), "and is announced");
postedMessages.length = 0;
global.document.getElementById("fullscreen-notice-tab").onclick();
assert.strictEqual(notice.hidden, true);
assert(postedMessages.some(m => m.command === "setFullscreenOnOpen" && m.enabled === false), "'Open as a tab instead' turns fullscreen off");
assert.strictEqual(global.document.getElementById("fullscreen-toggle").checked, false, "and the settings toggle follows");
onMessage({ data: { command: "fullscreenNotice", keybinding: "F4" } });
global.document.getElementById("fullscreen-notice-keep").onclick();
assert(postedMessages.some(m => m.command === "dismissFullscreenNotice"), "'Got it' records the dismissal");
notice.hidden = true;
onMessage({ data: { command: "fullscreenNotice", keybinding: "F4" } });
onMessage({ data: { command: "panelHidden" } });
assert.strictEqual(notice.hidden, true, "closing Thumbview hides the banner; it does not come back with the retained page");
global.document.getElementById("fullscreen-toggle").checked = true;
onMessage({ data: { command: "fullscreenNotice", keybinding: "F4" } });
onMessage({ data: { command: "fullscreenSetting", enabled: false } });
assert.strictEqual(global.document.getElementById("fullscreen-toggle").checked, false, "a settings.json change updates the toggle");
assert.strictEqual(notice.hidden, true, "and removes a banner that no longer applies");
console.log("✓ Test 4b passed");

console.log("\n--- Test 4c: Space presses a focused button instead of typing into search ---");
const searchBox = global.document.getElementById("search-input");
const before = searchBox.value;
global.document.activeElement = { tagName: "BUTTON" };
key(" ");
global.document.activeElement = undefined;
assert.strictEqual(searchBox.value, before, "Space on a button must not type into search");
console.log("✓ Test 4c passed");

console.log("\n--- Test 5: search results are announced after typing pauses ---");
key("f");
key("3");
setTimeout(() => {
    try {
        assert.strictEqual(srStatus.textContent.replace(/ $/, ""), "1 file match");

        console.log("✓ Test 5 passed");

        console.log("\n--- Test 6: every toolbar control has an accessible name; dialogs are labelled ---");
        const ext = fs.readFileSync(path.join(__dirname, "../extension.ts"), "utf8");
        const html = ext.substring(ext.indexOf("<body"), ext.indexOf("</body>"));
        const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || [];
        assert(buttons.length > 5);
        for (const b of buttons) {
            const open = b.substring(0, b.indexOf(">") + 1);
            const text = b.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "").replace(/\$\{[^}]*\}/g, "").trim();
            assert(/aria-label="[^"]+"/.test(open) || text.length > 0, `button needs an accessible name: ${open}`);
        }
        assert(/id="actions-modal"[^>]*role="dialog"[^>]*aria-labelledby=/.test(html), "settings modal is a labelled dialog");
        assert(/id="folders-popover"[^>]*role="dialog"[^>]*aria-labelledby=/.test(html), "folders popover is a labelled dialog");
        assert(/id="map"[^>]*tabindex="0"[^>]*aria-label=/.test(html), "the canvas grid is focusable and named");
        assert(/id="sr-status"[^>]*aria-live="polite"/.test(html), "a polite live region exists");
        console.log("✓ Test 6 passed");

        console.log("\nAll accessibility tests passed.");
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}, 700);
