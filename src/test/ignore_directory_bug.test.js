const fs = require("fs");
const path = require("path");
const assert = require("assert");

// Mock browser environment
const listeners = {};
const mockElements = {};
const mockElement = (id) => {
    if (!mockElements[id]) {
        let _innerHTML = "";
        const children = [];
        const el = {
            id,
            style: {},
            classList: { contains: () => false, add: () => {}, remove: () => {}, toggle: () => {} },
            appendChild: (child) => children.push(child),
            children,
            textContent: "",
            value: "",
            addEventListener: (event, fn) => {
                listeners[id + ":" + event] = fn;
            },
            contains: () => false,
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
            getContext: () => mockCtx,
            clientWidth: 800,
            clientHeight: 600
        };
        Object.defineProperty(el, "innerHTML", {
            get: () => _innerHTML,
            set: (val) => {
                _innerHTML = val;
                if (!val) {
                    children.length = 0;
                }
            }
        });
        mockElements[id] = el;
    }
    return mockElements[id];
};

const mockCtx = {
    save: () => {},
    restore: () => {},
    fillRect: () => {},
    strokeRect: () => {},
    fillText: () => {},
    measureText: (text) => ({ width: text.length * 6 }),
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fill: () => {},
    arc: () => {},
    closePath: () => {},
    rect: () => {},
    clip: () => {},
    drawImage: () => {},
    clearRect: () => {},
    setLineDash: () => {},
    setTransform: () => {},
    scale: () => {},
    lineWidth: 1,
    fillStyle: "#000",
    strokeStyle: "#000",
    font: "10px sans-serif",
    globalAlpha: 1
};

const windowListeners = {};
global.window = {
    innerWidth: 800,
    innerHeight: 600,
    outerWidth: 800,
    outerHeight: 600,
    devicePixelRatio: 1,
    addEventListener: (event, fn) => {
        windowListeners[event] = fn;
    },
    removeEventListener: () => {},
    focus: () => {}
};

global.MutationObserver = class {
    observe() {}
    disconnect() {}
};

const docListeners = {};
global.document = {
    body: {
        classList: { contains: () => false },
        style: {}
    },
    getElementById: (id) => mockElement(id),
    createElement: (tag) => {
        const children = [];
        const el = {
            tag,
            style: {},
            classList: { contains: () => false, add: () => {}, remove: () => {}, toggle: () => {} },
            appendChild: (child) => children.push(child),
            children,
            innerHTML: "",
            textContent: "",
            title: "",
            onclick: null
        };
        return el;
    },
    addEventListener: (event, fn) => {
        docListeners[event] = fn;
    },
    hasFocus: () => true
};

global.getComputedStyle = () => ({
    getPropertyValue: () => ""
});

const postedMessages = [];
global.acquireVsCodeApi = () => ({
    postMessage: (msg) => postedMessages.push(msg),
    getState: () => ({}),
    setState: () => {}
});

global.requestAnimationFrame = (fn) => fn();
global.cancelAnimationFrame = () => {};

// Load overview.js
const overviewPath = path.join(__dirname, "../../media/overview.js");
let code = fs.readFileSync(overviewPath, "utf8");
code += `
global.getOverviewState = () => ({
    data,
    currentIgnorePatterns
});
global.updateIgnoresPopover = updateIgnoresPopover;
global.updateFoldersPopover = updateFoldersPopover;
`;

eval(code);

const messageHandler = windowListeners["message"];
assert(messageHandler, "Window message listener should be registered");

// Set up mock DOM elements
mockElement("folders-popover");
mockElement("folders-list");
mockElement("ignores-list");
mockElement("ignores-count");
mockElement("shown-folders-count");

// Send data with realistic workspace: existing ignore patterns + files in directories
const initialData = {
    command: "data",
    files: [
        { id: "f1", path: "src/components/Button.tsx", uri: "file:///workspace/src/components/Button.tsx", lineCount: 20, nCells: 1 },
        { id: "f2", path: "src/components/Modal.tsx", uri: "file:///workspace/src/components/Modal.tsx", lineCount: 35, nCells: 1 },
        { id: "f3", path: "src/utils/helpers.ts", uri: "file:///workspace/src/utils/helpers.ts", lineCount: 30, nCells: 1 }
    ],
    layout: { cols: 10, rows: 5, cellW: 40, cellH: 30, slots: [] },
    ignorePatterns: ["out/", "node_modules/", "dist/", "build/", ".git/", "*.vsix"],
    ignorePatternCounts: { "out/": 10, "node_modules/": 500 },
    ignoredFilesMap: {}
};

messageHandler({ data: initialData });

// Render folders popover
global.updateFoldersPopover();
global.updateIgnoresPopover();

const foldersListEl = mockElements["folders-list"];
console.log("Initial Active Directories count:", foldersListEl.children.length);

function getRecursiveText(node) {
    if (!node) return "";
    let res = (node.textContent || "") + " " + (node.innerHTML || "");
    if (node.children) {
        for (const child of node.children) {
            res += " " + getRecursiveText(child);
        }
    }
    return res;
}

// Find the directory item for "src/components/"
let componentsItem = null;
for (const child of foldersListEl.children) {
    const text = getRecursiveText(child);
    if (text.includes("src") && text.includes("components")) {
        componentsItem = child;
        break;
    }
}

console.log("Found components item?", !!componentsItem);
assert(componentsItem, "Active Directories must list src/components/");

const ignoreBtn = componentsItem.children.find(c => c.tag === "button" || c.textContent === "Ignore" || (c.title && c.title.includes("Ignore folder")));
console.log("Found ignoreBtn?", !!ignoreBtn, "textContent:", ignoreBtn ? ignoreBtn.textContent : null);
assert(ignoreBtn, "Ignore button must exist for src/components/");

console.log("Clicking ignore button for src/components/...");
ignoreBtn.onclick({ stopPropagation: () => {} });

const ignoresListEl = mockElements["ignores-list"];
console.log("\nImmediately after clicking Ignore:");
console.log("Ignores list children count:", ignoresListEl.children.length);
console.log("First item in Ignored section:", getRecursiveText(ignoresListEl.children[0]));
console.log("Last item in Ignored section:", getRecursiveText(ignoresListEl.children[ignoresListEl.children.length - 1]));

// CRITERION 1: The newly ignored folder MUST immediately appear at the TOP (first item) of the Ignored section,
// so the user immediately sees it without having to scroll through a long list of existing patterns
const firstItemText = getRecursiveText(ignoresListEl.children[0]);
assert(
    firstItemText.includes("src/components"),
    `User must immediately see the ignored folder at the top of the Ignored section, but first item was: "${firstItemText.trim().slice(0, 60)}..."`
);

// CRITERION 2: Optimistic file count must reflect the folder's files (2 files), not 0 files
assert(
    firstItemText.includes("2 files"),
    `User must immediately see matching file count (2 files) in Ignored section, but got: "${firstItemText.trim().slice(0, 80)}"`
);

console.log("✓ Test passed: newly ignored directory immediately appears at the top of the Ignored section with file count");

// CRITERION 3: Host response with updated ignorePatterns keeps item at top and reconciles count
const updatedDataFromHost = {
    ...initialData,
    ignorePatterns: ["src/components/", ...initialData.ignorePatterns],
    ignorePatternCounts: { "src/components/": 2, ...initialData.ignorePatternCounts }
};
messageHandler({ data: updatedDataFromHost });

const postHostFirstItemText = getRecursiveText(ignoresListEl.children[0]);
assert(
    postHostFirstItemText.includes("src/components") && postHostFirstItemText.includes("2 files"),
    `After host sync, folder should remain at top with correct count. Got: "${postHostFirstItemText.slice(0, 80)}"`
);
console.log("✓ Test passed: host sync retains ignored directory at top of Ignored section");

// CRITERION 4: Clicking unignore removes it cleanly
const removeBtn = ignoresListEl.children[0].children.find(c => c.tag === "button" && (c.className === "remove-pattern-btn" || (c.title && c.title.includes("Remove"))));
assert(removeBtn, "First item should have a remove ignore button");
removeBtn.onclick({ stopPropagation: () => {} });

const afterUnignoreFirstItemText = getRecursiveText(ignoresListEl.children[0]);
assert(
    !afterUnignoreFirstItemText.includes("src/components"),
    `After unignoring, src/components/ should no longer be at top of list. Got: "${afterUnignoreFirstItemText.slice(0, 80)}"`
);
console.log("✓ Test passed: unignore removes directory from list");
