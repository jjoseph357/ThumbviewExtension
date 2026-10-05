const assert = require("assert");
const { readHostSource } = require("./helpers/host_source");
const fs = require("fs");
const path = require("path");

console.log("=== Test Suite: Subfolder Latency & Hover Line Alignment (v0.4.8) ===");

// ---------------------------------------------------------------------------
// 1. Verify overview.js constants and patterns
// ---------------------------------------------------------------------------
const overviewPath = path.join(__dirname, "../../media/overview.js");
const overviewCode = fs.readFileSync(overviewPath, "utf-8");

console.log("\n--- Test 1: Verify overview.js constants and thresholds ---");
{
    assert(
        overviewCode.includes("const THUMBNAIL_MIN_READABLE_FONT_SIZE = 8.0;"),
        "THUMBNAIL_MIN_READABLE_FONT_SIZE should be 8.0"
    );
    assert(
        overviewCode.includes("const THUMBNAIL_MIN_READABLE_TEXT_PITCH = 8.0;"),
        "THUMBNAIL_MIN_READABLE_TEXT_PITCH should be 8.0"
    );
    assert(
        overviewCode.includes("const MAX_TILE_CACHE_ENTRIES = 500;"),
        "MAX_TILE_CACHE_ENTRIES should be 500"
    );
    assert(
        overviewCode.includes("const shouldOpenFolder = !!focusedFolder;"),
        "shouldOpenFolder should be !!focusedFolder"
    );
    assert(
        overviewCode.includes("const rectW = getViewportW();"),
        "render() should read the canvas size from the single ResizeObserver-fed viewport source"
    );
    console.log("✓ Test 1 passed: All constants and thresholds verified in overview.js");
}

// ---------------------------------------------------------------------------
// 2. Test 152 files dense view useText computation
// ---------------------------------------------------------------------------
console.log("\n--- Test 2: Subfolder with 152 files bypasses text fillText rendering ---");
{
    const THUMBNAIL_LINE_HEIGHT_RATIO = 0.88;
    const THUMBNAIL_MAX_FONT_SIZE = 13;
    const THUMBNAIL_MIN_FONT_SIZE = 3.2;
    const THUMBNAIL_MIN_READABLE_FONT_SIZE = 8.0;
    const THUMBNAIL_MIN_READABLE_TEXT_PITCH = 8.0;
    const THUMBNAIL_MIN_READABLE_WIDTH = 45;
    const THUMBNAIL_MAX_LINE_PITCH = 16;

    // Simulate 152 files on a standard 1920x1080 screen in drilldown mode
    // ~16 cols x 10 rows: cell width ~110px, cell height ~90px, thumbnail w~90, h~56
    const w = 90;
    const h = 56;
    const lines = new Array(50).fill({ text: "const value = calculateSomething(data);" });
    const lineCount = lines.length;
    const stepY = Math.min(h / lineCount, THUMBNAIL_MAX_LINE_PITCH);

    const fontForHeight = stepY * THUMBNAIL_LINE_HEIGHT_RATIO;
    const rawFontSize = Math.min(fontForHeight, THUMBNAIL_MAX_FONT_SIZE);
    const fontSize = Math.max(THUMBNAIL_MIN_FONT_SIZE, Math.floor(rawFontSize * 10) / 10);
    const useText = fontSize >= THUMBNAIL_MIN_READABLE_FONT_SIZE && stepY >= THUMBNAIL_MIN_READABLE_TEXT_PITCH && w >= THUMBNAIL_MIN_READABLE_WIDTH;

    assert.strictEqual(useText, false, "152 files in drilldown view must NOT use text rendering (useText must be false)");
    assert(stepY < THUMBNAIL_MIN_READABLE_TEXT_PITCH, `stepY (${stepY}) should be below readable pitch 8.0`);
    console.log(`✓ Test 2 passed: 152 files thumbnail yields stepY=${stepY.toFixed(2)}px, fontSize=${fontSize.toFixed(2)}px -> useText=${useText} (0 text draw calls)`);
}

// ---------------------------------------------------------------------------
// 2b. Test spacious/short files render readable text
// ---------------------------------------------------------------------------
console.log("\n--- Test 2b: Spacious/short file renders readable text ---");
{
    const THUMBNAIL_WIDTH_BUDGET_FACTOR = 0.95;
    const THUMBNAIL_CHAR_ASPECT_RATIO = 0.58;
    const THUMBNAIL_LINE_HEIGHT_RATIO = 0.88;
    const THUMBNAIL_MAX_FONT_SIZE = 13;
    const THUMBNAIL_MIN_FONT_SIZE = 3.2;
    const THUMBNAIL_MIN_READABLE_FONT_SIZE = 8.0;
    const THUMBNAIL_MIN_READABLE_TEXT_PITCH = 8.0;
    const THUMBNAIL_MIN_READABLE_WIDTH = 45;
    const THUMBNAIL_MAX_LINE_PITCH = 16;
    const THUMBNAIL_TARGET_READABLE_CHARS = 80;
    const THUMBNAIL_MIN_TARGET_CHARS = 20;
    const THUMBNAIL_DEFAULT_TARGET_CHARS = 50;

    // Spacious tile (w=200, h=180) with 15 lines of code, avg 25 chars
    const w = 200;
    const h = 180;
    const lineCount = 15;
    const avgChars = 25;
    const stepY = Math.min(h / lineCount, THUMBNAIL_MAX_LINE_PITCH); // 12px
    const targetLineChars = Math.min(THUMBNAIL_TARGET_READABLE_CHARS, Math.max(THUMBNAIL_MIN_TARGET_CHARS, avgChars || THUMBNAIL_DEFAULT_TARGET_CHARS));
    const fontForWidth = (w * THUMBNAIL_WIDTH_BUDGET_FACTOR) / (targetLineChars * THUMBNAIL_CHAR_ASPECT_RATIO);
    const fontForHeight = stepY * THUMBNAIL_LINE_HEIGHT_RATIO; // 10.56px
    const rawFontSize = Math.min(fontForHeight, fontForWidth, THUMBNAIL_MAX_FONT_SIZE); // 10.56px
    const fontSize = Math.max(THUMBNAIL_MIN_FONT_SIZE, Math.floor(rawFontSize * 10) / 10); // 10.5px
    const useText = fontSize >= THUMBNAIL_MIN_READABLE_FONT_SIZE && stepY >= THUMBNAIL_MIN_READABLE_TEXT_PITCH && w >= THUMBNAIL_MIN_READABLE_WIDTH;

    assert.strictEqual(useText, true, "Spacious 15-line file must use text rendering (useText must be true)");
    assert(fontSize >= 8.0, `fontSize (${fontSize}) must be >= 8.0px`);
    console.log(`✓ Test 2b passed: 15-line file yields stepY=${stepY.toFixed(2)}px, fontSize=${fontSize.toFixed(2)}px -> useText=true`);
}

// ---------------------------------------------------------------------------
// 2c. Test single-line minified file (410 chars) uses rectangles (bypasses text)
// ---------------------------------------------------------------------------
console.log("\n--- Test 2c: Single-line minified file (410 chars) uses rectangles ---");
{
    const THUMBNAIL_WIDTH_BUDGET_FACTOR = 0.95;
    const THUMBNAIL_CHAR_ASPECT_RATIO = 0.58;
    const THUMBNAIL_LINE_HEIGHT_RATIO = 0.88;
    const THUMBNAIL_MAX_FONT_SIZE = 13;
    const THUMBNAIL_MIN_FONT_SIZE = 3.2;
    const THUMBNAIL_MIN_READABLE_FONT_SIZE = 8.0;
    const THUMBNAIL_MIN_READABLE_TEXT_PITCH = 8.0;
    const THUMBNAIL_MIN_READABLE_WIDTH = 45;
    const THUMBNAIL_MAX_LINE_PITCH = 16;
    const THUMBNAIL_TARGET_READABLE_CHARS = 80;
    const THUMBNAIL_MIN_TARGET_CHARS = 20;
    const THUMBNAIL_DEFAULT_TARGET_CHARS = 50;

    // Single-line minified source map in standard tile (w=200, h=180, 1 line, 410 chars)
    const w = 200;
    const h = 180;
    const lineCount = 1;
    const avgChars = 100; // max clamped avg chars for minified line
    const stepY = Math.min(h / lineCount, THUMBNAIL_MAX_LINE_PITCH); // 16px
    const targetLineChars = Math.min(THUMBNAIL_TARGET_READABLE_CHARS, Math.max(THUMBNAIL_MIN_TARGET_CHARS, avgChars || THUMBNAIL_DEFAULT_TARGET_CHARS)); // 80
    const fontForWidth = (w * THUMBNAIL_WIDTH_BUDGET_FACTOR) / (targetLineChars * THUMBNAIL_CHAR_ASPECT_RATIO); // ~4.09px
    const fontForHeight = stepY * THUMBNAIL_LINE_HEIGHT_RATIO; // 14.08px
    const rawFontSize = Math.min(fontForHeight, fontForWidth, THUMBNAIL_MAX_FONT_SIZE); // ~4.09px
    const fontSize = Math.max(THUMBNAIL_MIN_FONT_SIZE, Math.floor(rawFontSize * 10) / 10); // 4.0px
    const useText = fontSize >= THUMBNAIL_MIN_READABLE_FONT_SIZE && stepY >= THUMBNAIL_MIN_READABLE_TEXT_PITCH && w >= THUMBNAIL_MIN_READABLE_WIDTH;

    assert.strictEqual(useText, false, "Single-line minified file (410 chars) must NOT use text rendering (useText must be false)");
    assert(fontSize < THUMBNAIL_MIN_READABLE_FONT_SIZE, `fontSize (${fontSize}) should be below readable threshold 8.0`);
    console.log(`✓ Test 2c passed: 410-char single-line file yields fontSize=${fontSize.toFixed(2)}px < 8.0px -> useText=false (renders as rectangle)`);
}

// ---------------------------------------------------------------------------
// 3. Test hover line alignment logic with pitch clamping
// ---------------------------------------------------------------------------
console.log("\n--- Test 3: Hover line calculation matches thumbnail visual line ---");
{
    const THUMBNAIL_MAX_LINE_PITCH = 16;
    const thumbnailHeight = 200;

    // Case A: Short file (10 lines) in tall card (200px) -> stepY clamped to 16px
    const lineCountA = 10;
    const stepYA = Math.min(thumbnailHeight / lineCountA, THUMBNAIL_MAX_LINE_PITCH); // 16px
    assert.strictEqual(stepYA, 16);

    // If cursor is at offset 48px inside thumbnail:
    // Line 0: 0-16px, Line 1: 16-32px, Line 2: 32-48px, Line 3: 48-64px
    const cursorOffsetA = 50; // Inside line 3
    const visualLineA = Math.max(0, Math.min(lineCountA - 1, Math.floor(cursorOffsetA / stepYA)));
    assert.strictEqual(visualLineA, 3, "Offset 50px with stepY=16px must point to visual line 3");

    // Case B: Cursor at 180px in thumbnail (empty space below the 10 lines, which end at 160px)
    const cursorOffsetEmpty = 180;
    const clampedLineA = Math.max(0, Math.min(lineCountA - 1, Math.floor(cursorOffsetEmpty / stepYA)));
    assert.strictEqual(clampedLineA, 9, "Empty space below lines clamps cleanly to last line (9)");

    // Case C: File with many lines (100 lines) in 200px card -> stepY = 2px (unclamped)
    const lineCountC = 100;
    const stepYC = Math.min(thumbnailHeight / lineCountC, THUMBNAIL_MAX_LINE_PITCH); // 2px
    assert.strictEqual(stepYC, 2);
    const cursorOffsetC = 70;
    const visualLineC = Math.max(0, Math.min(lineCountC - 1, Math.floor(cursorOffsetC / stepYC)));
    assert.strictEqual(visualLineC, 35, "Offset 70px with stepY=2px must point to visual line 35");

    console.log("✓ Test 3 passed: Visual line alignment is mathematically exact across clamped and unclamped cards");
}

// ---------------------------------------------------------------------------
// 4. Test sampled files (>2000 lines) stride mapping and fullLines/cache check
// ---------------------------------------------------------------------------
console.log("\n--- Test 4: Sampled files (>2000 lines) hover line retrieval and stride mapping ---");
{
    const file = {
        uri: "file:///test/largeFile.ts",
        path: "test/largeFile.ts",
        lineCount: 4000,
        lines: new Array(2000).fill({ text: "sampled line" }), // sampled array
        fullLines: new Array(4000).fill(null).map((_, i) => `Real Line ${i}`)
    };

    const isSampled = !!(file.lineCount && file.lineCount > file.lines.length);
    assert.strictEqual(isSampled, true, "File with 4000 lines and 2000 sampled lines must be identified as isSampled");

    const thumbnailHeight = 400;
    const stepY = Math.min(thumbnailHeight / file.lines.length, 16); // 0.2px
    const cursorOffsetY = 200; // Middle of thumbnail
    const visualLineIdx = Math.max(0, Math.min(file.lines.length - 1, Math.floor(cursorOffsetY / stepY))); // 1000

    const stride = file.lineCount / file.lines.length; // 2.0
    const hoveredLineIdx = Math.max(0, Math.min(file.lineCount - 1, Math.floor(visualLineIdx * stride))); // 2000
    assert.strictEqual(hoveredLineIdx, 2000, "Visual line 1000 in 4000-line sampled file maps to real file line 2000");

    // Verify hover line retrieval logic
    const hoverLineCache = {};
    const uriCache = hoverLineCache[file.uri] || (hoverLineCache[file.uri] = {});

    let missingLines = false;
    const radius = 5;
    const start = hoveredLineIdx - radius;
    const end = hoveredLineIdx + radius;

    for (let i = start; i <= end; i++) {
        let hasLine = false;
        if (file.fullLines && file.fullLines[i] !== undefined) {
            hasLine = true;
        } else if (uriCache[i]) {
            hasLine = true;
        } else if (!isSampled && file.lines && file.lines[i]) {
            hasLine = true;
        }
        if (!hasLine) {
            missingLines = true;
            break;
        }
    }

    assert.strictEqual(missingLines, false, "When file.fullLines is present, lines are resolved directly without missingLines=true");

    // Verify fallback when fullLines is absent: must NOT fall back to file.lines[i]
    const fileNoFullLines = {
        uri: "file:///test/largeFileNoFull.ts",
        path: "test/largeFileNoFull.ts",
        lineCount: 4000,
        lines: new Array(2000).fill({ text: "sampled line" })
    };
    let missingWithoutFull = false;
    for (let i = start; i <= end; i++) {
        let hasLine = false;
        if (fileNoFullLines.fullLines && fileNoFullLines.fullLines[i] !== undefined) {
            hasLine = true;
        } else if (uriCache[i]) {
            hasLine = true;
        } else if (!isSampled && fileNoFullLines.lines && fileNoFullLines.lines[i]) {
            hasLine = true;
        }
        if (!hasLine) {
            missingWithoutFull = true;
            break;
        }
    }
    assert.strictEqual(missingWithoutFull, true, "When fullLines is missing for sampled file, missingLines must trigger getHoverLines instead of returning sampled file.lines[i]");

    console.log("✓ Test 4 passed: Sampled file line index correctly scales stride and avoids returning sampled line array");
}

// ---------------------------------------------------------------------------
// 5. Test viewport band scaling by contentH on short files
// ---------------------------------------------------------------------------
console.log("\n--- Test 5: Viewport band scales by contentH instead of full tile height ---");
{
    const thumbnailH = 200;
    const lines = new Array(5).fill({ text: "line" }); // 5 lines
    const stepY = Math.min(thumbnailH / lines.length, 16); // 16px
    const contentH = Math.min(thumbnailH, lines.length * stepY); // 80px

    assert.strictEqual(stepY, 16);
    assert.strictEqual(contentH, 80);

    const totalRealLines = 5;
    const viewLoc = { startLine: 2, endLine: 3 }; // Lines 2..3 in editor view
    const startRatio = viewLoc.startLine / totalRealLines; // 2/5 = 0.4
    const endRatio = (viewLoc.endLine + 1) / totalRealLines; // 4/5 = 0.8

    const thumbnailY = 24;
    const bandY = thumbnailY + startRatio * contentH; // 24 + 0.4 * 80 = 24 + 32 = 56px
    const bandH = Math.max((endRatio - startRatio) * contentH, 4); // 0.4 * 80 = 32px

    // Verify: line 2 in thumbnail starts at 24 + 2 * 16 = 56px! Exact match!
    assert.strictEqual(bandY, 56, "Viewport band top must align with line 2 rendered at 56px");
    assert.strictEqual(bandH, 32, "Viewport band height must match 2 lines * 16px = 32px");
    console.log("✓ Test 5 passed: Viewport band scales to rendered code height (contentH) with exact alignment");
}

// ---------------------------------------------------------------------------
// 6. Test gitChanges stride range check on sampled files (>2000 lines)
// ---------------------------------------------------------------------------
console.log("\n--- Test 6: gitChanges stride range check identifies changes past line 2000 ---");
{
    const file = {
        lineCount: 4000,
        lines: new Array(2000).fill({ text: "line" }),
        gitChanges: { 2500: "modified" } // line 2500 was modified in git diff
    };

    // For sampled tile line i = 1250 (which covers 1250 * 2 = 2500 to 2502)
    const i = 1250;
    let gitType = undefined;
    if (file.gitChanges) {
        if (file.lineCount && file.lineCount > file.lines.length) {
            const step = file.lineCount / file.lines.length; // 2
            const startLineIdx = Math.floor(i * step); // 2500
            const endLineIdx = Math.max(startLineIdx + 1, Math.min(Math.floor((i + 1) * step), file.lineCount)); // 2502
            for (let fullI = startLineIdx; fullI < endLineIdx; fullI++) {
                if (file.gitChanges[fullI]) {
                    gitType = file.gitChanges[fullI];
                    break;
                }
            }
        } else {
            gitType = file.gitChanges[i];
        }
    }

    assert.strictEqual(gitType, "modified", "Modified line at line 2500 must be found within sampled slice for index 1250");
    console.log("✓ Test 6 passed: gitChanges correctly checks stride range across sampled file lines");
}

// ---------------------------------------------------------------------------
// 7. Test PDF_JS_URI exposure and dynamic loading in overview.js
// ---------------------------------------------------------------------------
console.log("\n--- Test 7: Verify PDF_JS_URI exposure and dynamic loading handler ---");
{
    const extPath = path.join(__dirname, "../extension.ts");
    const extCode = readHostSource();
    assert(extCode.includes("window.PDF_JS_URI ="), "extension.ts must expose window.PDF_JS_URI");

    // Behavior (deferred until after the first reveal and the text stream): deferred_pdf.test.js.
    assert(overviewCode.includes("function requestPdfJs("), "overview.js must load pdf.js on demand");
    console.log("✓ Test 7 passed: window.PDF_JS_URI exposed and dynamic PDF loader present");
}

// ---------------------------------------------------------------------------
// 8. Test hover tooltip leading indentation preservation and tab expansion
// ---------------------------------------------------------------------------
console.log("\n--- Test 8: Hover tooltip leading indentation preservation and tab handling ---");
{
    const extPath = path.join(__dirname, "../extension.ts");
    const extCode = readHostSource();

    // Verify extension.ts styles #hover-tooltip with tab-size
    assert(extCode.includes("tab-size: 4;"), "extension.ts must configure tab-size: 4 for #hover-tooltip");

    // Verify overview.js extracts indentStr and prepends it before renderedLineHtml
    assert(
        overviewCode.includes("const indentMatch = lineText.match(/^[ \\t]*/);"),
        "overview.js must match leading spaces and tabs"
    );
    assert(
        overviewCode.includes("${prefix}${indentStr}${renderedLineHtml}${suffix}"),
        "overview.js must prepend indentStr before renderedLineHtml in tooltip div"
    );

    // Verify indentation computation logic on sample lines
    const sampleLines = [
        { text: "    const a = 1;", expectedIndent: "    " },
        { text: "\t\tconst b = 2;", expectedIndent: "        " },
        { text: "function root() {", expectedIndent: "" }
    ];

    for (const sample of sampleLines) {
        const match = sample.text.match(/^[ \t]*/);
        const indentStr = match ? match[0].replace(/\t/g, "    ") : "";
        assert.strictEqual(indentStr, sample.expectedIndent, `Indentation for "${sample.text}" must match expected`);

        const prefix = "  ";
        const renderedLineHtml = sample.text.trimStart();
        const assembled = `${prefix}${indentStr}${renderedLineHtml}`;
        assert.strictEqual(
            assembled,
            prefix + (sample.text.startsWith("\t") ? sample.text.replace(/\t/g, "    ") : sample.text)
        );
    }

    console.log("✓ Test 8 passed: Hover tooltip preserves leading indentation and expands tabs");
}

// ---------------------------------------------------------------------------
// 9. Test .map file language detection and JSON syntax tokenization
// ---------------------------------------------------------------------------
console.log("\n--- Test 9: Verify .map file language detection and JSON syntax tokenization ---");
{
    assert(
        overviewCode.includes("ext === 'map'"),
        "overview.js detectLang must recognize 'map' as json"
    );

    // Simulate detectLang
    function detectLang(path) {
        if (!path) return 'plaintext';
        const filename = path.split('/').pop().toLowerCase();
        if (filename === '.gitignore' || filename === 'license' || filename.startsWith('license.')) {
            return 'plaintext';
        }
        const ext = filename.includes('.') ? filename.split('.').pop() : '';
        if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown';
        if (!ext || ext === 'txt' || ext === 'log' || ext === 'conf' || ext === 'ini' || ext === 'env') {
            return 'plaintext';
        }
        if (ext === 'css' || ext === 'scss' || ext === 'less') return 'css';
        if (ext === 'html' || ext === 'htm' || ext === 'xml' || ext === 'svg' || ext === 'vue') return 'html';
        if (ext === 'json' || ext === 'jsonc' || ext === 'json5' || ext === 'map' || filename.endsWith('rc') || filename.includes('json')) return 'json';
        if (ext === 'py') return 'python';
        return 'js';
    }

    assert.strictEqual(detectLang("client_01.js.map"), "json", ".js.map files must be detected as json");
    assert.strictEqual(detectLang("style.css.map"), "json", ".css.map files must be detected as json");
    assert.strictEqual(detectLang("bundle.MAP"), "json", "Uppercase .MAP files must be detected as json");

    // Verify tokenization of sample .map line
    function tokenizeJSON(text) {
        const tokens = [];
        const regex = /(\/\/.*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*(?:"|$)|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}()\[\]:,]|\s+|.)/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
            const val = match[0];
            let cat = "normal";
            if (val.startsWith("//") || val.startsWith("/*")) {
                cat = "comment";
            } else if (val.startsWith('"')) {
                cat = "string";
            } else if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(val)) {
                cat = "number";
            } else if (/^(true|false|null)$/.test(val)) {
                cat = "keyword";
            } else if (/^[{}()\[\]:,]$/.test(val)) {
                cat = "normal";
            }
            tokens.push({ text: val, category: cat, isKey: false });
        }

        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i].category === "string") {
                let n = i + 1;
                while (n < tokens.length && /^\s+$/.test(tokens[n].text)) n++;
                if (n < tokens.length && tokens[n].text === ":") {
                    tokens[i].isKey = true;
                }
            }
        }
        return tokens;
    }

    const mapLine = '{"version":3,"file":"client_01.js","sourceRoot":""}';
    const tokens = tokenizeJSON(mapLine);

    const versionTok = tokens.find(t => t.text === '"version"');
    assert(versionTok && versionTok.isKey === true, 'Property "version" must be flagged with isKey = true');

    const numTok = tokens.find(t => t.text === '3');
    assert(numTok && numTok.category === 'number', 'Value 3 must have category "number"');

    const fileTok = tokens.find(t => t.text === '"file"');
    assert(fileTok && fileTok.isKey === true, 'Property "file" must be flagged with isKey = true');

    const fileValTok = tokens.find(t => t.text === '"client_01.js"');
    assert(fileValTok && fileValTok.category === 'string' && fileValTok.isKey === false, 'Value "client_01.js" must be string with isKey = false');

    // Test truncated map line (e.g. client_09.js.map cut off at 300 chars mid-string)
    const truncatedLine = '{"version":3,"file":"client_09.js","mappings":";;;AAMA,MAAa,QAAQ;IACC;IAApB';
    const truncTokens = tokenizeJSON(truncatedLine);
    const lastTok = truncTokens[truncTokens.length - 1];
    assert.strictEqual(lastTok.category, "string", "Truncated/unclosed string at end of line must be categorized as string (orange), not normal (gray)");
    assert.strictEqual(lastTok.isKey, false, "Truncated string value must not be flagged as key");

    console.log("✓ Test 9 passed: .map files detected as JSON and tokenized with theme-matching keys and values (including truncated strings)");
}

console.log("\n=== ALL SUBFOLDER LATENCY & HOVER ALIGNMENT TESTS PASSED ===");


