// Renders the real webview (getHtml + media/overview.js) in headless Chrome against a freshly
// generated demo workspace and writes the README screenshots and GIF to media/screenshots/.
// Nothing here runs VS Code: the host side is replaced by a payload built the same way the
// host builds it (sorted files, buildSpanningGrid, fillLayoutHoles), sent with postMessage.
//   npm run screenshots            (needs Chrome or Chromium, python3, and ffmpeg)
//   CHROME_PATH=/path/to/chrome npm run screenshots
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { demoWorkspace, fillLayoutHoles, launchChrome, openThumbviewPage, root, scratchDir, send, settle, writeThumbviewPage } from "./lib/webview_page.mjs";

const outDir = join(root, "media", "screenshots");
mkdirSync(outDir, { recursive: true });
const { dir: work, cleanup } = scratchDir("thumbview-shots-");
const { demo, files, byPath, order, repoFile, dataFor, initial, openState } = demoWorkspace(work);
const messages = [initial.message, openState];
const pagePath = writeThumbviewPage(work);
const browser = await launchChrome();

// Center of the given line on a file's tile, in CSS pixels.
function linePoint(page, relPath, fraction) {
    return page.evaluate((p, f) => {
        const file = data.files.find(x => x.path === p);
        const rect = document.getElementById("map").getBoundingClientRect();
        return { x: rect.left + file._cell.x + file._cell.w * 0.35, y: rect.top + file._cell.y + file._cell.h * f };
    }, relPath, fraction);
}

async function typeInSearch(page, text, onChar) {
    for (const ch of text) {
        await page.keyboard.type(ch);
        await settle(120);
        if (onChar) await onChar();
    }
}

// --- Stills (1600x900 at 2x) ---------------------------------------------------------------
{
    const page = await openThumbviewPage(browser, pagePath, { width: 1600, height: 900, scale: 2, messages });
    await page.screenshot({ path: join(outDir, "overview.png") });

    await typeInSearch(page, "order");
    await settle(400);
    await page.screenshot({ path: join(outDir, "search.png") });
    await page.click("#clear-search");
    await settle(300);

    const at = await linePoint(page, "src/routes/orders.ts", 0.3);
    await page.mouse.move(at.x, at.y);
    await page.keyboard.down("ControlLeft");
    await settle(400);
    await page.screenshot({ path: join(outDir, "magnifier.png") });
    await page.keyboard.up("ControlLeft");
    await settle(200);

    await page.click("#folders-btn");
    await settle(400);
    await page.screenshot({ path: join(outDir, "folders.png") });
    await page.close();
}

// --- GIF (1280x720) ------------------------------------------------------------------------
{
    const framesDir = join(work, "frames");
    mkdirSync(framesDir);
    const frames = [];
    const page = await openThumbviewPage(browser, pagePath, { width: 1280, height: 720, messages });
    async function frame(seconds) {
        const file = join(framesDir, `f${String(frames.length).padStart(4, "0")}.png`);
        await page.screenshot({ path: file });
        frames.push({ file, seconds });
    }

    await frame(1.6);
    await typeInSearch(page, "order", () => frame(0.15));
    await settle(300);
    await frame(1.6);
    await page.click("#clear-search");
    await settle(300);
    await frame(0.6);

    const from = await linePoint(page, "src/server.ts", 0.08);
    await page.mouse.move(from.x, from.y);
    await page.keyboard.down("ControlLeft");
    for (let i = 0; i <= 12; i++) {
        const p = await linePoint(page, "src/server.ts", 0.08 + i * 0.05);
        await page.mouse.move(p.x, p.y);
        await settle(60);
        await frame(0.12);
    }
    await frame(1.0);
    await page.keyboard.up("ControlLeft");
    await page.mouse.move(2, 2);
    await settle(200);
    await frame(0.6);

    // Spatial stability: ignoring a file leaves its slot empty; the next new file fills it.
    const hidden = byPath["web/app.js"];
    const afterIgnore = dataFor(files.filter(f => f !== hidden), order, initial.allocations);
    await send(page, afterIgnore.message);
    await settle(400);
    await frame(1.8);

    const addedPath = join(demo, "web", "cart.js");
    writeFileSync(addedPath, readFileSync(join(demo, "web", "app.js"), "utf8").split("\n").slice(0, 30).join("\n").replace(/app/g, "cart"));
    const added = repoFile("web/cart.js");
    const withNew = [...files.filter(f => f !== hidden), added];
    const filled = fillLayoutHoles(order, withNew.map(f => f.id)).order;
    await send(page, dataFor(withNew, filled, afterIgnore.allocations).message);
    await settle(400);
    await frame(2.2);
    await page.close();

    const list = frames.map(f => `file '${f.file}'\nduration ${f.seconds}`).join("\n") + `\nfile '${frames[frames.length - 1].file}'\n`;
    const listPath = join(work, "frames.txt");
    writeFileSync(listPath, list);
    const palette = join(work, "palette.png");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath,
        "-vf", "fps=10,scale=960:-1:flags=lanczos,palettegen=stats_mode=diff", palette]);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath, "-i", palette,
        "-lavfi", "fps=10,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
        "-loop", "0", join(outDir, "thumbview.gif")]);
}

await browser.close();
cleanup();
console.log(`Wrote ${readdirSync(outDir).join(", ")} to media/screenshots/`);
