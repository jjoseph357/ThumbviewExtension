// pdf.js never runs on the first-open path: the page has no PDF <script> tags, and overview.js loads
// pdf.js and then its worker (nonce'd module scripts) only after the first reveal, once streamed text
// has arrived, in an idle slot. Node has no Worker, so this covers the fallback that runs the worker
// on the page's thread; the blob: worker path needs a browser (checked in headless Chrome). Hovering a PDF may start it before the stream ends, never before the
// reveal. Run with "urgent" (spawned below) for the hover path, since the harness's globals are per process.
const assert = require("assert");
const path = require("path");
const { execFileSync } = require("child_process");
const { loadOverview } = require("./helpers/overview_harness");
const { requireBundle } = require("./helpers/vscode_stub");

const urgentMode = process.argv[2] === "urgent";

if (!urgentMode) {
    console.log("--- Test 1: the page loads no PDF script ---");
    const fileUri = p => ({ fsPath: p, toString: () => p });
    const { getHtml } = requireBundle(path.join(__dirname, "../../out/webview_html.js"), {
        Uri: { joinPath: (base, ...parts) => fileUri(path.join(base.fsPath, ...parts)) }
    });
    const html = getHtml({ cspSource: "vscode-resource:", asWebviewUri: uri => uri }, { extensionUri: fileUri("/ext") }, "F4");
    const scriptSrcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map(m => m[1]);
    assert.deepStrictEqual(scriptSrcs.map(s => path.basename(s)), ["overview.js"], `only overview.js is a page script (got ${scriptSrcs.join(", ")})`);
    assert(html.includes("window.PDF_JS_URI ="), "the loader still gets pdf.js's location");
    assert(/script-src 'nonce-[^']+';/.test(html), "the CSP still allows only nonce'd scripts");
    console.log("✓ Test 1 passed");
}

const h = loadOverview(["requestPdfJs", "completeReveal"]);
const { onMessage, flushFrames } = h;
const appended = [];
global.document.head = { appendChild: el => appended.push(el) };
const idle = [];
global.requestIdleCallback = fn => { idle.push(fn); return idle.length; };
const runIdle = () => idle.splice(0, idle.length).forEach(fn => fn());
// No blob: workers in Node: starting the worker fails and the loader takes its fallback.
global.fetch = () => Promise.reject(new Error("no worker in this test"));
console.warn = () => { };
Object.assign(global.window, { PDF_JS_URI: "media/pdfjs/pdf.min.js", PDF_WORKER_URI: "media/pdfjs/pdf.worker.min.js", PDF_JS_NONCE: "n0nce" });

const files = [
    { id: "doc.pdf", path: "doc.pdf", uri: "file:///ws/doc.pdf", isPdf: true, mediaUri: "file:///ws/doc.pdf", lineCount: 0, contentVersion: 1, lines: [], slot: [0, 0] },
    { id: "a.ts", path: "a.ts", uri: "file:///ws/a.ts", lineCount: 1, contentVersion: 1, lines: [], linesPending: true, slot: [1, 0] }
];

h.exports.requestPdfJs(urgentMode);
runIdle();
assert.strictEqual(appended.length, 0, "nothing loads before the first reveal, even for a hovered PDF");

h.resizeTo(1600, 900);
onMessage({ data: { command: "data", mode: "uniform_grid", files, layout: { cols: 2, rows: 1 } } });
flushFrames();
h.exports.completeReveal();
flushFrames();
runIdle();

if (!urgentMode) {
    console.log("--- Test 2: pdf.js waits for the text stream, then loads in an idle slot ---");
    assert.strictEqual(appended.length, 0, "the PDF tile was drawn, but text is still streaming");
    onMessage({ data: { command: "fileLines", files: [{ id: "a.ts", contentVersion: 1, lines: ["const a = 1;"] }] } });
    assert.strictEqual(appended.length, 0, "loading waits for an idle slot");
} else {
    console.log("--- Test 3: hovering a PDF loads pdf.js before the stream ends ---");
    h.exports.requestPdfJs(true);
}
runIdle();
assert.strictEqual(appended.length, 1, "one script at a time");
assert.strictEqual(appended[0].src, "media/pdfjs/pdf.min.js", "pdf.js first");
assert.strictEqual(appended[0].type, "module", "pdf.js 6 is an ES module");
assert.strictEqual(appended[0].nonce, "n0nce", "the CSP allows only nonce'd scripts");
const opened = [];
global.pdfjsLib = {
    GlobalWorkerOptions: {},
    getDocument: opts => {
        opened.push(opts);
        return { promise: new Promise(() => { }) };
    }
};
appended[0].onload();

const tick = () => new Promise(resolve => setImmediate(resolve));
return tick().then(tick).then(() => {
    assert.strictEqual(appended.length, 2, "no blob: worker here, so the worker module loads on the page's thread");
    assert.strictEqual(appended[1].src, "media/pdfjs/pdf.worker.min.js");
    assert.strictEqual(appended[1].type, "module");
    assert.strictEqual(appended[1].nonce, "n0nce");
    assert.strictEqual(global.pdfjsLib.GlobalWorkerOptions.workerSrc, "media/pdfjs/pdf.worker.min.js");
    appended[1].onload();
    return tick().then(() => {
        flushFrames();
        return new Promise(resolve => setImmediate(resolve));
    }).then(() => {
        assert.strictEqual(opened.length, 0, "page 1 renders in an idle slot, not inside the frame");
        assert(idle.length > 0, "and that slot is requested");
        runIdle();
        return new Promise(resolve => setImmediate(resolve));
    }).then(() => {
        assert.strictEqual(opened.length, 1, "the drawn PDF's first page is requested");
        assert.strictEqual(opened[0].url, "file:///ws/doc.pdf");
        console.log(`✓ Test ${urgentMode ? 3 : 2} passed`);
        if (!urgentMode) {
            execFileSync(process.execPath, [__filename, "urgent"], { stdio: "inherit" });
            console.log("\nAll deferred PDF tests passed.");
        }
    });
}).catch(err => {
    console.error(err);
    process.exit(1);
});
