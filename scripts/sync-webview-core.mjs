// Copies src/layout_core.ts into the generated block of media/overview.js. The webview is
// loaded as a plain script (no bundler), so this is how it shares the host's layout code
// instead of keeping hand-synced twins. `--check` exits non-zero when the block is stale.
// scripts/build.mjs also calls syncWebviewCore on every build, so `npm run watch` keeps it current.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corePath = join(root, "src", "layout_core.ts");
const webviewPath = join(root, "media", "overview.js");

export const BEGIN = "// ---- BEGIN GENERATED from src/layout_core.ts by `npm run sync-core`. Do not edit here. ----";
export const END = "// ---- END GENERATED from src/layout_core.ts ----";

export function generatedBlock() {
    const js = ts.transpileModule(readFileSync(corePath, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, removeComments: false }
    }).outputText;
    const body = js
        .replace(/^export (const|function|class) /gm, "$1 ")
        .replace(/^export \{\s*\};?\s*$/gm, "")
        .trim();
    return `${BEGIN}\n${body}\n${END}`;
}

function spliced(source, block) {
    const start = source.indexOf(BEGIN);
    const end = source.indexOf(END);
    if (start === -1 || end === -1 || end < start) {
        throw new Error(`media/overview.js is missing the generated layout_core markers`);
    }
    return source.slice(0, start) + block + source.slice(end + END.length);
}

/** Rewrites the generated block when stale. Returns false (without writing) in check mode if stale. */
export function syncWebviewCore({ check = false } = {}) {
    const current = readFileSync(webviewPath, "utf8");
    const next = spliced(current, generatedBlock());
    if (next === current) {
        return true;
    }
    if (check) {
        return false;
    }
    writeFileSync(webviewPath, next);
    console.log("Updated media/overview.js from src/layout_core.ts");
    return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    if (!syncWebviewCore({ check: process.argv.includes("--check") })) {
        console.error("media/overview.js is out of date with src/layout_core.ts. Run `npm run sync-core`.");
        process.exit(1);
    }
}
