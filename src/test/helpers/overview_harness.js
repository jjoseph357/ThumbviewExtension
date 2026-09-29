// Loads media/overview.js into a mock DOM for behavioral tests. requestAnimationFrame is a
// manually flushed queue so frame boundaries are observable, ResizeObserver is driven by
// resizeTo(), and posted host messages are recorded. Globals are process-wide, so load once
// per test file.
const fs = require("fs");
const path = require("path");

function loadOverview(extraExports = []) {
    // Fake clock: each flushed frame advances performance.now() by 16ms.
    const clock = { now: 0 };
    Object.defineProperty(global, "performance", { value: { now: () => clock.now }, configurable: true, writable: true });
    const rafQueue = [];
    global.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
    global.cancelAnimationFrame = () => {};
    function flushFrames(n = 20) {
        for (let i = 0; i < n && rafQueue.length > 0; i++) {
            clock.now += 16;
            const batch = rafQueue.splice(0, rafQueue.length);
            batch.forEach(fn => fn());
        }
    }

    const counts = { clearRect: 0, offscreenCanvas: 0 };
    const createdCanvases = [];
    const mockCtx = new Proxy({
        clearRect: () => { counts.clearRect++; },
        measureText: (text) => ({ width: String(text).length * 6 }),
        createLinearGradient: () => ({ addColorStop: () => {} }),
        getLineDash: () => [],
    }, {
        get: (target, prop) => (prop in target ? target[prop] : (typeof prop === "string" && /^[a-z]/.test(prop) ? () => {} : undefined)),
        set: (target, prop, value) => { target[prop] = value; return true; }
    });

    const viewport = { w: 1000, h: 700 };
    const mockElements = {};
    function mockElement(id) {
        if (!mockElements[id]) {
            mockElements[id] = {
                id,
                style: {},
                dataset: {},
                classList: { contains: () => false, add: () => {}, remove: () => {}, toggle: () => {} },
                appendChild: () => {},
                addEventListener: () => {},
                focus: () => {},
                blur: () => {},
                setAttribute: () => {},
                contains: () => false,
                querySelectorAll: () => [],
                getBoundingClientRect: () => ({ left: 0, top: 0, width: viewport.w, height: viewport.h }),
                getContext: () => mockCtx,
                get clientWidth() { return viewport.w; },
                get clientHeight() { return viewport.h; },
                innerHTML: "",
                textContent: "",
                value: ""
            };
        }
        return mockElements[id];
    }

    const windowListeners = {};
    global.window = {
        innerWidth: 1600,
        innerHeight: 900,
        devicePixelRatio: 1,
        addEventListener: (event, fn) => { (windowListeners[event] = windowListeners[event] || []).push(fn); },
        removeEventListener: () => {},
        focus: () => {}
    };
    global.MutationObserver = class { observe() {} disconnect() {} };
    let resizeObserverCallback = null;
    global.ResizeObserver = class {
        constructor(cb) { resizeObserverCallback = cb; }
        observe() {}
        disconnect() {}
    };
    const docListeners = {};
    global.document = {
        hidden: false,
        visibilityState: "visible",
        body: { classList: { contains: () => false, add: () => {}, remove: () => {} }, style: {} },
        getElementById: (id) => mockElement(id),
        querySelectorAll: () => [],
        createElement: (tag) => {
            const el = {
                tag, style: {}, dataset: {},
                classList: { contains: () => false, add: () => {}, remove: () => {}, toggle: () => {} },
                appendChild: () => {}, addEventListener: () => {},
                getContext: () => mockCtx, width: 0, height: 0
            };
            if (tag === "canvas") {
                counts.offscreenCanvas++;
                createdCanvases.push(el);
            }
            return el;
        },
        addEventListener: (event, fn) => { docListeners[event] = fn; },
        hasFocus: () => true
    };
    global.getComputedStyle = () => ({ getPropertyValue: () => "" });
    const postedMessages = [];
    global.acquireVsCodeApi = () => ({ postMessage: (msg) => postedMessages.push(msg), getState: () => ({}), setState: () => {} });

    const names = ["render", "applyDataMessage", "scheduleRender", ...extraExports];
    const code = fs.readFileSync(path.join(__dirname, "../../../media/overview.js"), "utf8") + `
module.exports = { ${names.join(", ")}, getData: () => data };
`;
    const mod = {};
    new Function("module", "exports", code)(mod, mod);

    function resizeTo(w, h) {
        viewport.w = w;
        viewport.h = h;
        resizeObserverCallback([{ contentRect: { width: w, height: h } }]);
    }
    const onMessage = (ev) => (windowListeners["message"] || []).forEach(fn => fn(ev));
    const fireWindow = (event, detail = {}) => (windowListeners[event] || []).forEach(fn => fn(detail));

    return {
        exports: mod.exports, rafQueue, flushFrames, clock, counts, createdCanvases, mockCtx, viewport, resizeTo,
        windowListeners, docListeners, postedMessages, onMessage, fireWindow,
        canvas: mockElement("map")
    };
}

module.exports = { loadOverview };
