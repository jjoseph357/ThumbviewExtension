// Shared by the headless webview scripts (screenshots, accessibility audit, scale benchmark):
// builds the "data" payload the host would send, and opens the real page (the bundle's getHtml
// plus media/overview.js) in headless Chrome with VS Code theme variables and a stub webview API.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const { loadTs } = require(join(root, "src/test/helpers/load_ts.js"));
const { buildSpanningGrid, cellsNeeded } = loadTs("../spanning_layout.ts");
export const { fillLayoutHoles } = loadTs("../layout_core.ts");

export const settle = ms => new Promise(r => setTimeout(r, ms));
export const send = (page, msg) => page.evaluate(m => window.postMessage(m, "*"), msg);

/** A scratch directory removed by cleanup(). */
export function scratchDir(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A text file in the payload shape scanner.ts produces (lines capped at 2000 x 300 chars). */
export function textFile(id, relPath, uri, text, extra = {}) {
    const all = text.split(/\r?\n/);
    const lines = all.slice(0, 2000).map(line => {
        const t = line.substring(0, 300);
        return { text: t, indent: t.length - t.trimStart().length, length: t.trimEnd().length, category: "normal" };
    });
    return { id, path: relPath, uri, contentVersion: 1, lines, lineCount: all.length, hasError: false, errorCount: 0, errorLines: {}, ...extra };
}

/** Builds a spanning-mode "data" message like extension.ts updateLayoutFromCacheLocked. */
export function spanningDataMessage(files, order, { flowCells = {}, ignorePatterns = [], ignoredFilesMap = {} } = {}) {
    const display = Object.fromEntries(files.map(f => [f.id, cellsNeeded(f.lineCount, 60, 0.05)]));
    const flow = { ...display, ...flowCells };
    const layout = buildSpanningGrid(files, order, flow, null, null, 16 / 9, 60, 0.05, display);
    return {
        message: {
            command: "data",
            mode: "spanning_grid",
            naturalCells: display,
            slotFootprints: {},
            slotFlowCells: { root: layout.allocations },
            dragReorderMode: "swap",
            renderMediaThumbnails: true,
            fullscreenOnOpen: true,
            compressionPercentage: 5,
            autoIgnoreThreshold: 30,
            minCellWidth: 40,
            minCellHeight: 28,
            openKeybinding: "F4",
            ignorePatterns,
            ignorePatternCounts: Object.fromEntries(ignorePatterns.map(p => [p, (ignoredFilesMap[p] || []).length])),
            ignoredFilesMap,
            extraCols: 0,
            extraRows: 0,
            cardOrder: [],
            cardWrapRows: null,
            folderOrders: {},
            folderCardOrders: {},
            folderCardWrapRows: {},
            folderWrapRows: {},
            folderExtraCols: {},
            folderExtraRows: {},
            fileOrder: order,
            // Lines as plain strings, as extension.ts withDeltaLines sends them.
            files: layout.placements.map(p => ({ ...p.file, lines: p.file.lines.map(l => l.text), slot: [p.col, p.row], nCells: p.nCells, slots: p.slots })),
            layout: { cols: layout.cols, rows: layout.rows, wrapRows: layout.wrapRows, flowCols: layout.flowCols, flowRows: layout.flowRows }
        },
        allocations: layout.allocations
    };
}

// --- Demo workspace ----------------------------------------------------------------------------
// build/ was ignored by hand; generated/ (35 files) trips autoIgnoreThreshold; logs/ is gitignored.
const DEMO_IGNORED = ["build/", "generated/"];
const DEMO_GITIGNORED = ["logs/"];
const DEMO_SKIP = [".gitignore"];
// Illustrative git and diagnostics state, so tiles show their markers and badges.
const DEMO_GIT = {
    "src/server.ts": { status: "modified", lines: { 6: "modified", 7: "added", 8: "added", 9: "added" } },
    "web/app.js": { status: "modified", lines: { 3: "modified" } },
    "scripts/seed.ts": { status: "untracked", lines: {} }
};
const DEMO_ERRORS = { "src/middleware/auth.ts": { 11: "Property 'role' does not exist on type 'User'." } };

function walk(dir) {
    return readdirSync(dir).flatMap(name => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : [full];
    });
}

// Same order as scanner.ts: root files first, then by directory, then by path.
function scannerOrder(paths) {
    const dirOf = p => (p.includes("/") ? p.substring(0, p.lastIndexOf("/")) : "");
    return [...paths].sort((a, b) => {
        const [da, db] = [dirOf(a), dirOf(b)];
        if (da !== db) {
            if (da === "") return -1;
            if (db === "") return 1;
            return da.localeCompare(db, undefined, { numeric: true, sensitivity: "base" });
        }
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
    });
}

/**
 * Generates a fresh demo workspace inside `workDir` (scripts/generate-demo-workspace.py, so local edits to demo-workspace/ never
 * leak into outputs) and returns its files and host-shaped messages.
 */
export function demoWorkspace(workDir) {
    const demo = join(workDir, "demo");
    execFileSync("python3", [join(root, "scripts", "generate-demo-workspace.py"), demo], { stdio: "ignore" });

    const allPaths = walk(demo).map(f => relative(demo, f).replace(/\\/g, "/"));
    const shown = scannerOrder(allPaths.filter(p =>
        !DEMO_IGNORED.some(pat => p.startsWith(pat)) && !DEMO_GITIGNORED.some(pat => p.startsWith(pat)) && !DEMO_SKIP.includes(p)));

    const repoFile = rel => {
        const full = join(demo, rel);
        const uri = pathToFileURL(full).href;
        const ext = extname(rel).slice(1).toLowerCase();
        if (["png", "jpg", "jpeg", "gif", "webp", "svg", "pdf"].includes(ext)) {
            const isPdf = ext === "pdf";
            return { id: full, path: rel, uri, contentVersion: 1, lines: [], lineCount: 1, isImage: !isPdf, isPdf, mediaUri: uri };
        }
        const errors = DEMO_ERRORS[rel];
        return textFile(full, rel, uri, readFileSync(full, "utf8"), {
            gitStatus: DEMO_GIT[rel]?.status,
            gitChanges: DEMO_GIT[rel]?.lines,
            hasError: !!errors,
            errorCount: errors ? Object.keys(errors).length : 0,
            errorLines: errors || {}
        });
    };
    const ignoredFilesMap = Object.fromEntries(DEMO_IGNORED.map(pat => [pat, allPaths.filter(p => p.startsWith(pat))]));
    const dataFor = (files, order, flowCells = {}) => spanningDataMessage(files, order, { flowCells, ignorePatterns: DEMO_IGNORED, ignoredFilesMap });

    const files = shown.map(repoFile);
    const byPath = Object.fromEntries(files.map(f => [f.path, f]));
    const order = files.map(f => f.id);
    const openState = {
        command: "openState",
        activeFileUri: byPath["src/server.ts"].uri,
        openFiles: ["src/server.ts", "src/middleware/auth.ts", "README.md"].map(p => byPath[p].uri),
        viewLocations: { [byPath["src/server.ts"].uri]: { startLine: 0, endLine: 24, scrollLine: 0 } }
    };
    return { demo, files, byPath, order, repoFile, dataFor, initial: dataFor(files, order), openState };
}

// --- The real webview page ---------------------------------------------------------------------
// VS Code's Dark Modern theme variables for the colors the page reads.
const THEME = {
    "font-family": "system-ui, 'Ubuntu', 'Droid Sans', sans-serif", "font-size": "13px",
    "editor-font-family": "'Droid Sans Mono', 'DejaVu Sans Mono', monospace",
    "editor-background": "#1f1f1f", "editor-foreground": "#cccccc", "foreground": "#cccccc",
    "descriptionForeground": "#9d9d9d", "focusBorder": "#0078d4", "contrastBorder": "transparent", "contrastActiveBorder": "transparent",
    "widget-border": "#313131", "widget-shadow": "#0000005c", "editorWidget-background": "#202020", "editorWidget-border": "#454545",
    "editorWidget-headerBackground": "#202020", "editorHoverWidget-background": "#202020", "editorHoverWidget-foreground": "#cccccc",
    "editorHoverWidget-border": "#454545", "editorComment-foreground": "#6a9955",
    "button-background": "#0078d4", "button-foreground": "#ffffff", "button-hoverBackground": "#026ec1",
    "button-secondaryBackground": "#313131", "button-secondaryForeground": "#cccccc", "button-secondaryHoverBackground": "#3c3c3c", "button-secondaryBorder": "#ffffff12",
    "input-background": "#313131", "input-foreground": "#cccccc", "input-border": "#3c3c3c", "input-placeholderForeground": "#989898",
    "inputValidation-errorBorder": "#be1100", "errorForeground": "#f85149", "list-errorForeground": "#f88070",
    "badge-background": "#616161", "badge-foreground": "#f8f8f8", "toolbar-hoverBackground": "#5a5d5e50",
    "menu-background": "#1f1f1f", "menu-foreground": "#cccccc", "menu-selectionBackground": "#0078d4", "menu-selectionForeground": "#ffffff",
    "menu-border": "#454545", "menu-separatorBackground": "#454545", "list-hoverBackground": "#2a2d2e", "list-hoverForeground": "#cccccc",
    "list-activeSelectionBackground": "#04395e", "list-activeSelectionForeground": "#ffffff",
    "gitDecoration-modifiedResourceForeground": "#e2c08d", "gitDecoration-untrackedResourceForeground": "#73c991",
    "scrollbarSlider-background": "#79797966", "scrollbarSlider-hoverBackground": "#646464b3", "scrollbarSlider-activeBackground": "#bfbfbf66",
    "sideBarSectionHeader-foreground": "#cccccc", "settings-headerForeground": "#ffffff", "statusBarItem-errorBackground": "#c72e0f",
    "keybindingLabel-background": "#8080802b", "keybindingLabel-foreground": "#cccccc", "keybindingLabel-border": "#33333399", "keybindingLabel-bottomBorder": "#44444499"
};

/** Builds the bundle and writes the page getHtml produces into `workDir`; returns its path. */
export function writeThumbviewPage(workDir) {
    execFileSync(process.execPath, [join(root, "scripts", "build.mjs")], { stdio: "ignore" });
    const { requireBundle } = require(join(root, "src/test/helpers/vscode_stub.js"));
    const fileUri = p => ({ fsPath: p, toString: () => pathToFileURL(p).href });
    const { getHtml } = requireBundle(join(root, "dist", "extension.js"), {
        Uri: { joinPath: (base, ...parts) => fileUri(join(base.fsPath, ...parts)) }
    });
    const pagePath = join(workDir, "thumbview.html");
    writeFileSync(pagePath, getHtml({ cspSource: "file:", asWebviewUri: uri => uri }, { extensionUri: fileUri(root) }, "F4"));
    return pagePath;
}

export async function launchChrome() {
    const executablePath = process.env.CHROME_PATH
        || ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].find(existsSync);
    if (!executablePath) {
        throw new Error("Chrome not found; set CHROME_PATH.");
    }
    return puppeteer.launch({
        executablePath,
        headless: true,
        args: ["--allow-file-access-from-files", "--font-render-hinting=none", "--hide-scrollbars"]
    });
}

/**
 * Opens the page and sends `messages` as the host would after "ready". Resolves once the reveal
 * gate has shown the page (unless `waitForReveal` is false). `window.__posted` collects everything the webview posts to the host.
 */
export async function openThumbviewPage(browser, pagePath, { width, height, scale = 1, messages = [], settleMs = 1200, waitForReveal = true }) {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: scale });
    await page.evaluateOnNewDocument(theme => {
        window.__posted = [];
        window.acquireVsCodeApi = () => ({ postMessage: m => window.__posted.push(m), getState: () => undefined, setState: () => {} });
        document.addEventListener("DOMContentLoaded", () => {
            document.body.classList.add("vscode-dark");
            for (const [name, value] of Object.entries(theme)) {
                document.documentElement.style.setProperty(`--vscode-${name}`, value);
            }
        });
    }, THEME);
    await page.goto(pathToFileURL(pagePath).href, { waitUntil: "load" });
    for (const msg of messages) {
        await send(page, msg);
    }
    if (waitForReveal) {
        await page.waitForFunction(() => document.body.style.opacity === "1", { timeout: 30000 });
        await settle(settleMs);
    }
    return page;
}
