// Unit tests for payload_stream.ts: which files' text goes inside the first "data" payload and how
// the rest is chunked for streaming.
const assert = require("assert");
const { inlineWithinBudget, chunkBySize, lineTextSize } = require("../../out/payload_stream");

console.log("--- Test 1: text size counts lines, full lines, and separators ---");
assert.strictEqual(lineTextSize({ lines: ["ab", "c"] }), 5);
assert.strictEqual(lineTextSize({ lines: ["ab"], fullLines: ["abc"] }), 7);
console.log("✓ Test 1 passed");

console.log("--- Test 2: inline in layout order until the budget is spent, first file always inline ---");
assert.deepStrictEqual(inlineWithinBudget([4, 4, 4], 9), [true, true, false]);
assert.deepStrictEqual(inlineWithinBudget([50, 1], 10), [true, false], "an oversized first file still goes inline, and nothing after it");
assert.deepStrictEqual(inlineWithinBudget([4, 20, 1], 10), [true, false, false], "layout order is kept: a small file after a streamed one is streamed too");
console.log("✓ Test 2 passed");

console.log("--- Test 3: chunks stay near the budget and keep order ---");
assert.deepStrictEqual(chunkBySize([3, 3, 3, 9, 1], x => x, 6), [[3, 3], [3], [9], [1]]);
assert.deepStrictEqual(chunkBySize([], x => x, 6), []);
console.log("✓ Test 3 passed");

console.log("\nAll payload stream tests passed.");
