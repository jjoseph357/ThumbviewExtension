// Copies media/screenshots/ into a local clone of the public assets repository and pushes it.
// The source repository is private, so the Marketplace README loads its images from there
// (`npm run package` passes --baseImagesUrl pointing at that repository's main branch).
//   npm run publish-assets                       (clone at ../thumbview-assets)
//   npm run publish-assets -- /path/to/clone
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clone = resolve(process.argv[2] || join(root, "..", "thumbview-assets"));
if (!existsSync(join(clone, ".git"))) {
    console.error(`No git clone of the assets repository at ${clone}.`);
    process.exit(1);
}
const git = (...args) => execFileSync("git", ["-C", clone, ...args], { encoding: "utf8" });

cpSync(join(root, "media", "screenshots"), join(clone, "media", "screenshots"), { recursive: true });
git("add", "-A", "media/screenshots");
if (git("status", "--porcelain").trim() === "") {
    console.log("Assets repository already has these images.");
} else {
    const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    git("commit", "-m", `Update README images for Thumbview ${version}`);
    console.log("Committed new images.");
}
execFileSync("git", ["-C", clone, "push", "origin", "HEAD:main"], { stdio: "inherit" });
