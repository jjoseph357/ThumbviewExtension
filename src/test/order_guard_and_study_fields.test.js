// Host-side checks behind spatial stability and safety: layout orders from the webview are sanitized
// before they are stored, a drag never shortens an order (which could shrink the grid and move every
// tile), file-changing commands compare real paths so a symlink cannot reach outside the workspace,
// and the study's reveal latency and "target moved" fields.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { sanitizeOrderIds, sanitizeRowCount, isSafeWebviewMessage, FILE_CHANGING_COMMANDS } = require("../../out/message_guard");
const { moveItemToEmptySlot } = require("../../out/reorder_helpers");
const { revealLatencyMs, SlotMemory, MAX_REVEAL_LATENCY_MS } = require("../../out/study/study_events");

console.log("--- Test 1: orders from the webview are made safe to persist ---");
assert.deepStrictEqual(sanitizeOrderIds(["a", 3, null, "b", "a", ""]), ["a", "", "", "b", "", ""], "non-strings and repeats become gaps in place");
assert.strictEqual(sanitizeOrderIds("a,b"), null);
assert.strictEqual(sanitizeOrderIds(new Array(200001).fill("")), null, "bounded length");
assert.deepStrictEqual(sanitizeOrderIds(["x".repeat(5000)]), [""], "absurd ids are dropped");
assert.strictEqual(sanitizeRowCount(12), 12);
for (const bad of [0, -1, 1.5, "3", NaN, 1e9, undefined]) assert.strictEqual(sanitizeRowCount(bad), undefined, `${bad} is not a row count`);
console.log("✓ Test 1 passed");

console.log("--- Test 2: moving the last tile never shortens the order ---");
const order = ["a", "b", "c", "d"];
const moved = moveItemToEmptySlot(order, "d", 1 /* onto a gap */, 8);
assert.strictEqual(moved.length, order.length, `the vacated last slot stays a gap (${JSON.stringify(moved)})`);
const padded = moveItemToEmptySlot(order, "a", 6, 8);
assert.deepStrictEqual(padded, ["", "b", "c", "d", "", "", "a"], "moving past the end pads only up to the target");
console.log("✓ Test 2 passed");

console.log("--- Test 3: file-changing commands compare real paths ---");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tv-guard-")));
const ws = path.join(tmp, "ws");
const outside = path.join(tmp, "outside");
fs.mkdirSync(ws);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, "secret.txt"), "x");
fs.symlinkSync(outside, path.join(ws, "link"), "dir");
const lexicalInside = uri => decodeURIComponent(new URL(uri).pathname).startsWith(ws + "/");
// Mirrors extension.ts realPathOf: a missing path resolves through its nearest existing parent.
const resolveReal = p => { try { return fs.realpathSync(p); } catch { return path.join(resolveReal(path.dirname(p)), path.basename(p)); } };
const realInside = p => { const r = resolveReal(p); return r === ws || r.startsWith(ws + path.sep); };
const real = {
    uri: uri => realInside(decodeURIComponent(new URL(uri).pathname)),
    relative: rel => realInside(path.join(ws, rel))
};
const viaLink = `file://${ws}/link/secret.txt`;
assert.strictEqual(isSafeWebviewMessage({ command: "deleteFile", uri: viaLink }, lexicalInside), true, "the lexical check alone passes the link");
assert.strictEqual(isSafeWebviewMessage({ command: "deleteFile", uri: viaLink }, lexicalInside, real), false, "delete through a link to outside is refused");
assert.strictEqual(isSafeWebviewMessage({ command: "renameFile", uri: viaLink, path: "link/secret.txt" }, lexicalInside, real), false);
assert.strictEqual(isSafeWebviewMessage({ command: "newFile", targetFolder: "link" }, lexicalInside, real), false, "relative targets are checked too");
assert.strictEqual(isSafeWebviewMessage({ command: "openPreview", uri: viaLink }, lexicalInside, real), true, "opening a file under the link still works");
fs.writeFileSync(path.join(ws, "own.txt"), "x");
assert.strictEqual(isSafeWebviewMessage({ command: "deleteFile", uri: `file://${ws}/own.txt` }, lexicalInside, real), true);
assert.strictEqual(isSafeWebviewMessage({ command: "newFile", targetFolder: "new-dir" }, lexicalInside, real), true, "a folder that does not exist yet resolves through its parent");
for (const c of ["deleteFile", "renameFile", "pasteItem", "moveFileToFolder", "deleteFolder", "copyFile", "copyFolder"]) assert(FILE_CHANGING_COMMANDS.has(c), c);
fs.rmSync(tmp, { recursive: true, force: true });
console.log("✓ Test 3 passed");

console.log("--- Test 4: study fields: reveal latency and whether the target moved ---");
assert.strictEqual(revealLatencyMs(1350.4, 1000), 350);
assert.strictEqual(revealLatencyMs(900, 1000), null, "a reveal before the request is another visit's");
assert.strictEqual(revealLatencyMs(1000 + MAX_REVEAL_LATENCY_MS + 1, 1000), null, "implausibly long");
assert.strictEqual(revealLatencyMs(1200, null), null, "no request (a tab click)");
assert.strictEqual(revealLatencyMs("1200", 1000), null);
const slots = new SlotMemory();
assert.strictEqual(slots.moved("h1", 2, 3), null, "first visit: unknown");
assert.strictEqual(slots.moved("h1", 2, 3), false, "same slot");
assert.strictEqual(slots.moved("h1", 4, 3), true, "moved");
assert.strictEqual(new SlotMemory(slots.toJSON()).moved("h1", 4, 3), false, "survives storage");
console.log("✓ Test 4 passed");

console.log("\nAll order, guard, and study field tests passed.");
