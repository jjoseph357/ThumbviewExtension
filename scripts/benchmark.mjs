// Measures the webview at workspace scale in headless Chrome, using the real page and a
// host-shaped payload of synthetic files spread over folders (auto-ignore off: the worst case).
// For 1,000 / 5,000 / 10,000 files it reports:
//   payload      size of the "data" message the host posts (text over FIRST_PAYLOAD_LINE_BUDGET is
//                streamed afterwards in "fileLines" chunks, as extension.ts withDeltaLines does)
//   first frame  from posting that message to the page revealing a frame at a stable size
//   all text     from posting it to the last streamed chunk being applied
//   frame        render() time with warm caches (the cost of a repaint, e.g. on hover)
//   search       time to update the search index for one keystroke and repaint
//   drill-in     time to open one folder and paint it (tiles over the frame budget as placeholders),
//                and in parentheses until every tile is fully drawn
// Headless Chrome rasterizes on the CPU, so absolute numbers vary by machine; compare runs on
// the same machine. `--json` prints machine-readable results.
//   npm run benchmark [-- --sizes=1000,5000] [-- --json] [-- --budget]
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { launchChrome, openThumbviewPage, root, scratchDir, settle, spanningDataMessage, textFile, writeThumbviewPage } from "./lib/webview_page.mjs";

const { loadTs } = createRequire(import.meta.url)(join(root, "src/test/helpers/load_ts.js"));
const { inlineWithinBudget, chunkBySize, lineTextSize } = loadTs("../payload_stream.ts");

/** Splits a full payload the way the host does: inline text within budget, the rest as fileLines chunks. */
function streamedMessages(message) {
    const inline = inlineWithinBudget(message.files.map(lineTextSize));
    const streamed = [];
    const files = message.files.map((f, i) => {
        if (inline[i]) return f;
        streamed.push({ id: f.id, contentVersion: f.contentVersion, lines: f.lines, fullLines: f.fullLines });
        return { ...f, lines: [], fullLines: undefined, linesPending: true };
    });
    return { first: { ...message, files }, chunks: chunkBySize(streamed, lineTextSize).map(c => ({ command: "fileLines", files: c })) };
}

const sizesArg = process.argv.find(a => a.startsWith("--sizes="));
const SIZES = sizesArg ? sizesArg.substring(8).split(",").map(Number) : [1000, 5000, 10000];
const FILES_PER_FOLDER = 50;

// Deterministic pseudo-code so every run measures the same content.
function syntheticSource(i) {
    let seed = i * 7919 + 1;
    const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const lines = [`// module ${i}`, `import { helper${i % 97} } from "../shared/helper${i % 97}";`, ""];
    const count = 20 + rand(260);
    for (let l = 0; l < count; l++) {
        const depth = rand(4);
        lines.push(`${"    ".repeat(depth)}${["const", "let", "return", "if (", "export function"][rand(5)]} value${rand(1000)} = compute(${rand(100)}, "text ${rand(50)}");`);
    }
    return lines.join("\n");
}

function workspace(n) {
    const files = [];
    for (let i = 0; i < n; i++) {
        const folder = `pkg${String(Math.floor(i / FILES_PER_FOLDER)).padStart(3, "0")}`;
        const rel = `${folder}/module${String(i).padStart(5, "0")}.ts`;
        const id = `/bench/${rel}`;
        files.push(textFile(id, rel, pathToFileURL(id).href, syntheticSource(i)));
    }
    return files;
}

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const { dir, cleanup } = scratchDir("thumbview-bench-");
const pagePath = writeThumbviewPage(dir);
const browser = await launchChrome();
const results = [];
try {
    for (const n of SIZES) {
        console.error(`benchmarking ${n} files...`);
        const files = workspace(n);
        const { message: fullMessage } = spanningDataMessage(files, files.map(f => f.id));
        const { first: message, chunks } = streamedMessages(fullMessage);
        const payloadMB = Buffer.byteLength(JSON.stringify(message)) / 1024 / 1024;

        // Open the page without data, stage the payload inside it, then time postMessage (the
        // structured clone the webview receives), processing, and the reveal of a stable frame.
        // The first-open safety timer caps this at 2.5 s, which the "gated" column flags.
        const page = await openThumbviewPage(browser, pagePath, { width: 1600, height: 900, waitForReveal: false });
        // Staged through a file: sending ~150 MB through the DevTools protocol crashes the tab.
        const payloadPath = join(dir, `payload-${n}.json`);
        writeFileSync(payloadPath, JSON.stringify({ message, chunks }));
        await page.evaluate(async url => { window.__staged = await (await fetch(url)).json(); }, pathToFileURL(payloadPath).href);
        rmSync(payloadPath);
        await page.evaluate(() => {
            // Registered after the page's own listener, so it runs once the last chunk is applied.
            window.addEventListener("message", e => { if (e.data && e.data.__benchDone) window.__textDone = performance.now(); });
            window.__t0 = performance.now();
            window.postMessage(window.__staged.message, "*");
            // The host sends each chunk once the previous one is delivered.
            (async () => {
                for (const chunk of window.__staged.chunks) {
                    await new Promise(r => setTimeout(r, 0));
                    window.postMessage(chunk, "*");
                }
                window.postMessage({ __benchDone: true }, "*");
            })();
        });
        await page.waitForFunction(() => document.body.style.opacity === "1", { timeout: 120000, polling: "raf" });
        const firstFrame = await page.evaluate(() => performance.now() - window.__t0);
        await page.waitForFunction(() => window.__textDone !== undefined, { timeout: 120000 });
        const allText = await page.evaluate(() => window.__textDone - window.__t0);
        await settle(500);

        const frame = await page.evaluate(() => {
            const times = [];
            for (let i = 0; i < 15; i++) {
                const t = performance.now();
                render();
                times.push(performance.now() - t);
            }
            return times;
        });

        const search = [];
        for (const ch of "value42") {
            search.push(await page.evaluate(c => {
                const input = document.getElementById("search-input");
                const t = performance.now();
                input.value += c;
                rebuildSearchState(input.value);
                render();
                return performance.now() - t;
            }, ch));
        }

        // First paint: the synchronous render after the click (tiles over the frame budget are drawn
        // as placeholders). Complete: every tile rasterized, over the following frames.
        const drill = await page.evaluate(() => new Promise(resolve => {
            const t = performance.now();
            setFocusedFolderWithHistory("pkg001/");
            const firstPaint = performance.now() - t;
            const check = () => (rasterDeferred ? requestAnimationFrame(check) : resolve({ firstPaint, complete: performance.now() - t }));
            requestAnimationFrame(check);
        }));

        results.push({
            files: n,
            payloadMB: +payloadMB.toFixed(1),
            firstFrameMs: Math.round(firstFrame),
            allTextMs: Math.round(allText),
            streamedChunks: chunks.length,
            frameMs: +median(frame).toFixed(1),
            searchKeystrokeMs: +median(search).toFixed(1),
            drillInMs: +drill.firstPaint.toFixed(1),
            drillInCompleteMs: Math.round(drill.complete)
        });
        await page.close();
    }
} finally {
    await browser.close();
    cleanup();
}

// --budget: fail when the smallest size is far past today's numbers (DESIGN.md "Scale benchmark").
// Generous on purpose: CI runners are slower and noisier than a development machine.
const BUDGET_1K = { firstFrameMs: 1500, frameMs: 16, searchKeystrokeMs: 120, drillInMs: 400 };
const overBudget = [];
if (process.argv.includes("--budget")) {
    const r = results.find(x => x.files === 1000);
    if (!r) {
        overBudget.push("--budget needs the 1000-file size");
    } else {
        for (const [key, limit] of Object.entries(BUDGET_1K)) {
            if (r[key] > limit) overBudget.push(`${key} ${r[key]} > ${limit}`);
        }
    }
}

if (process.argv.includes("--json")) {
    console.log(JSON.stringify(results, null, 2));
} else {
    console.log("| Files | Payload | First frame | All text (chunks) | Frame (warm) | Search keystroke | Drill into folder (complete) |");
    console.log("|---:|---:|---:|---:|---:|---:|---:|");
    for (const r of results) {
        console.log(`| ${r.files.toLocaleString("en-US")} | ${r.payloadMB} MB | ${r.firstFrameMs} ms | ${r.allTextMs} ms (${r.streamedChunks}) | ${r.frameMs} ms | ${r.searchKeystrokeMs} ms | ${r.drillInMs} ms (${r.drillInCompleteMs} ms) |`);
    }
}

if (overBudget.length > 0) {
    console.error(`Over budget at 1,000 files: ${overBudget.join(", ")}`);
    process.exit(1);
}
