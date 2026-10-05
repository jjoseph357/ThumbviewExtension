// Unit tests for disk_changes.ts: which watcher batches take a full rescan, which re-read single
// files, and which cost nothing; and the scan-generation tracker that corrects stale scan reads.
const assert = require("assert");
const { planDiskChanges, emptyPendingChanges, isListingRuleFile, ChangeGenerations } = require("../../out/disk_changes");

const shown = new Set(["/ws/src/a.ts", "/ws/.gitignore"]);
const listed = new Set(["src/a.ts", ".gitignore", "src/empty.ts", "docs/hidden.md"]);
const facts = {
    isShown: key => shown.has(key),
    isListed: rel => listed.has(rel),
    containsListed: rel => [...listed].some(p => p.startsWith(rel + "/")),
    isIgnored: rel => rel.startsWith("docs/")
};
const ev = rel => ({ key: `/ws/${rel}`, rel, uri: rel });
const batch = parts => {
    const b = emptyPendingChanges();
    for (const [kind, rel] of parts) {
        b[kind].set(`/ws/${rel}`, ev(rel));
    }
    return b;
};

console.log("--- Test 1: a save re-reads only that file ---");
let plan = planDiskChanges(batch([["changed", "src/a.ts"]]), facts);
assert.deepStrictEqual(plan, { toRead: ["src/a.ts"], toCheck: [], rescan: false });
console.log("✓ Test 1 passed");

console.log("--- Test 2: unlisted output and ignored files cost nothing ---");
plan = planDiskChanges(batch([["changed", "out/a.js"], ["deleted", "out/b.js"], ["changed", "docs/hidden.md"], ["created", "docs/new.md"]]), facts);
assert.deepStrictEqual(plan, { toRead: [], toCheck: [], rescan: false });
console.log("✓ Test 2 passed");

console.log("--- Test 3: deleting a shown or listed file rescans ---");
assert.strictEqual(planDiskChanges(batch([["deleted", "src/a.ts"]]), facts).rescan, true);
assert.strictEqual(planDiskChanges(batch([["deleted", "src/empty.ts"]]), facts).rescan, true);
assert.strictEqual(planDiskChanges(batch([["deleted", "src"]]), facts).rescan, true, "a deleted folder arrives as one event for the folder");
assert.strictEqual(planDiskChanges(batch([["deleted", "sr"]]), facts).rescan, false, "a prefix of a folder name is not that folder");
console.log("✓ Test 3 passed");

console.log("--- Test 4: a create is checked against git before any rescan; an atomic save is a re-read ---");
plan = planDiskChanges(batch([["created", "src/new.ts"], ["created", "src/a.ts"]]), facts);
assert.deepStrictEqual(plan, { toRead: ["src/a.ts"], toCheck: ["src/new.ts"], rescan: false });
console.log("✓ Test 4 passed");

console.log("--- Test 5: a listed but unshown file getting content rescans ---");
assert.strictEqual(planDiskChanges(batch([["changed", "src/empty.ts"]]), facts).rescan, true);
console.log("✓ Test 5 passed");

console.log("--- Test 6: listing rule files are structural ---");
assert.ok(isListingRuleFile(".gitignore"));
assert.ok(isListingRuleFile("pkg/.gitignore"));
assert.ok(isListingRuleFile(".git/info/exclude"));
assert.ok(!isListingRuleFile("src/gitignore.ts"));
const structural = emptyPendingChanges();
structural.structural = true;
assert.strictEqual(planDiskChanges(structural, facts).rescan, true);
console.log("✓ Test 6 passed");

console.log("--- Test 7: changes after a scan started are re-read after it installs ---");
const gens = new ChangeGenerations();
gens.record("/ws/x", "x");
const scanStart = gens.current();
gens.record("/ws/y", "y");
gens.record("/ws/x", "x2");
assert.deepStrictEqual(gens.changedSince(scanStart).sort(), ["x2", "y"]);
gens.forgetThrough(gens.current());
assert.deepStrictEqual(gens.changedSince(0), []);
console.log("✓ Test 7 passed");

console.log("\nAll disk change tests passed.");
