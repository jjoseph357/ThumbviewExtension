// Bundles the extension host (src/extension.ts and everything it imports) into dist/extension.js,
// the file package.json "main" loads. tsc still compiles src/ to out/ for type checking and the
// unit tests; only the bundle ships.
//   node scripts/build.mjs               one development build (with source maps)
//   node scripts/build.mjs --production  minified, no source maps (vscode:prepublish)
//   node scripts/build.mjs --watch       rebuild on change, and run `tsc -watch` alongside
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";
import { syncWebviewCore } from "./sync-webview-core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const options = {
    absWorkingDir: root,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    logLevel: "info",
    plugins: [{
        // src/layout_core.ts is in the bundle's graph, so editing it during `--watch` rebuilds and
        // regenerates the webview copy; host and webview never run different layout code.
        name: "sync-webview-core",
        setup(build) {
            build.onStart(() => {
                if (!production) {
                    syncWebviewCore();
                }
            });
        }
    }]
};

// A stale source map from an earlier development build must not ship with a production build.
rmSync(join(root, "dist"), { recursive: true, force: true });

if (watch) {
    const context = await esbuild.context(options);
    // Build once before tsc starts: the F5 task waits for tsc's "Watching for file changes" line,
    // so dist/ always exists by the time the Extension Development Host launches.
    // A syntax error must not end the watch: report it and keep watching, as tsc -watch does.
    await context.rebuild().catch(() => {});
    await context.watch();
    const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    const child = spawn(process.execPath, [tsc, "-watch", "-p", "./"], { cwd: root, stdio: "inherit" });
    child.on("exit", code => process.exit(code ?? 0));
} else {
    await esbuild.build(options);
}
