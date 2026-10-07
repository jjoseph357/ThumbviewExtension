// Behavior tests for the study's host module (out/study/study.js) against a small vscode stub, with
// HOME pointed at a temporary folder so the per-computer participant file is the test's own: leaving
// ends participation before study_left is sent, the usage-telemetry state the uninstall script
// relies on is recorded, and uninstalling sends study_left only under the same conditions as any event.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tv-study-host-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const disposable = () => ({ dispose() { } });
const commands = {};
const telemetry = { isUsageEnabled: true, listeners: [], onDidChangeEnableStates(fn) { this.listeners.push(fn); return disposable(); }, dispose() { } };
let showInformationMessageHook = undefined;
const vscodeStub = {
    env: { createTelemetryLogger: () => telemetry, openExternal: async () => true, clipboard: { writeText: async () => { } } },
    window: {
        onDidChangeWindowState: disposable,
        onDidChangeActiveTextEditor: disposable,
        tabGroups: { onDidChangeTabs: disposable },
        visibleTextEditors: [],
        showInformationMessage: async (message, options, ...items) => {
            if (showInformationMessageHook) return showInformationMessageHook(message, options, ...items);
            if (items.includes("I Agree and Join")) return "I Agree and Join";
            if (items.includes("Enable Telemetry and Join")) return "Enable Telemetry and Join";
            return undefined;
        },
        showErrorMessage: async () => { }
    },
    commands: { registerCommand: (id, fn) => { commands[id] = fn; return disposable(); }, executeCommand: async () => { } },
    workspace: {
        workspaceFolders: [],
        getConfiguration: () => ({
            get: () => undefined,
            update: async (k, v) => {
                if (k === "telemetryLevel" && v === "all") {
                    telemetry.isUsageEnabled = true;
                    telemetry.listeners.forEach(fn => fn());
                }
            }
        }),
        asRelativePath: p => String(p),
        getWorkspaceFolder: () => undefined
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    Uri: { parse: s => ({ toString: () => s, fsPath: s }) },
    version: "1.99.0"
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    return request === "vscode" ? vscodeStub : originalLoad.call(this, request, ...rest);
};

const { STUDY_CONFIG } = require("../../out/study/study_config");
Object.assign(STUDY_CONFIG, { ingestUrl: "https://study.example", ingestKey: "key", supabaseUrl: "https://study.example", supabaseAnonKey: "anon", consentUrl: "https://consent.example" });
const { createStudy, generateFallbackParticipantId, fetchNextParticipantId } = require("../../out/study/study");
const { readParticipantFile, writeParticipantFile, mayNotifyUninstall, PARTICIPANT_FILE } = require("../../out/study/participant_file");

function makeContext() {
    const state = new Map();
    return {
        subscriptions: [],
        extension: { packageJSON: { version: "0.5.0" } },
        globalState: {
            get: key => state.get(key),
            update: async (key, value) => { value === undefined ? state.delete(key) : state.set(key, value); },
            keys: () => [...state.keys()]
        }
    };
}
const log = { warn() { }, debug() { }, info() { } };

(async () => {
    console.log("--- Test 1: leaving ends participation before study_left goes out ---");
    {
        assert(PARTICIPANT_FILE.startsWith(home), "the test uses its own participant file");
        let participantDuringSend;
        const sent = [];
        global.fetch = async (url, init) => {
            participantDuringSend = readParticipantFile().participant;
            sent.push(...JSON.parse(init.body).map(r => r.event));
            return { ok: true, status: 201 };
        };
        const context = makeContext();
        createStudy(context, { isThumbviewVisible: () => false, log });
        assert.strictEqual(await commands["thumbview.study.join"](), true);
        const joined = readParticipantFile();
        assert(joined.participant, "joined");
        assert.strictEqual(joined.usageTelemetryEnabled, true, "joining records that usage telemetry is on");

        await commands["thumbview.study.leave"]();
        assert.deepStrictEqual(sent, ["study_left"], "only the fact of leaving is sent");
        assert.strictEqual(participantDuringSend, undefined, "another window re-reading the file during the send sees nobody enrolled");
        assert.strictEqual(readParticipantFile().formerParticipantId, joined.participant.id);
        context.subscriptions.forEach(s => s.dispose && s.dispose());
    }
    console.log("✓ Test 1 passed");

    console.log("--- Test 2: the last usage-telemetry state is kept for the uninstall script ---");
    {
        const participant = { id: "pid-2", salt: "s", enrolledAt: 1, consentVersion: STUDY_CONFIG.consentVersion };
        writeParticipantFile({ participant });
        telemetry.listeners = [];
        telemetry.isUsageEnabled = false;
        const context = makeContext();
        createStudy(context, { isThumbviewVisible: () => false, log });
        assert.strictEqual(readParticipantFile().usageTelemetryEnabled, false, "recorded at activation");
        telemetry.isUsageEnabled = true;
        telemetry.listeners.forEach(fn => fn());
        assert.strictEqual(readParticipantFile().usageTelemetryEnabled, true, "recorded when the level changes");
        assert.deepStrictEqual(readParticipantFile().participant, participant, "the participant is untouched");
        context.subscriptions.forEach(s => s.dispose && s.dispose());
    }
    console.log("✓ Test 2 passed");

    console.log("--- Test 3: uninstalling sends study_left only with telemetry on and current consent ---");
    {
        const participant = { id: "pid-3", salt: "s", enrolledAt: 1, consentVersion: 1 };
        assert.strictEqual(mayNotifyUninstall({ participant, usageTelemetryEnabled: true }, 1), true);
        assert.strictEqual(mayNotifyUninstall({ participant, usageTelemetryEnabled: false }, 1), false, "telemetry was off");
        assert.strictEqual(mayNotifyUninstall({ participant }, 1), false, "unknown telemetry state counts as off");
        assert.strictEqual(mayNotifyUninstall({ participant, usageTelemetryEnabled: true }, 2), false, "consent to an older form");
        assert.strictEqual(mayNotifyUninstall({ formerParticipantId: "x", usageTelemetryEnabled: true }, 1), false, "nobody enrolled");
    }
    console.log("✓ Test 3 passed");

    console.log("--- Test 4: joining when telemetry is disabled prompts to enable telemetry ---");
    {
        writeParticipantFile({});
        telemetry.isUsageEnabled = false;
        let enablePromptShown = false;
        showInformationMessageHook = async (msg, opts, ...items) => {
            if (msg.includes("Join the Thumbview research study?")) return "I Agree and Join";
            if (msg.includes("requires VS Code usage telemetry to be enabled")) {
                enablePromptShown = true;
                return "Enable Telemetry and Join";
            }
            return undefined;
        };
        const context = makeContext();
        createStudy(context, { isThumbviewVisible: () => false, log });
        const enrolled = await commands["thumbview.study.join"]();
        assert.strictEqual(enrolled, true);
        assert.strictEqual(enablePromptShown, true, "prompted to enable telemetry");
        assert.strictEqual(telemetry.isUsageEnabled, true, "telemetry was enabled");
        assert(readParticipantFile().participant, "participant recorded");
        assert.strictEqual(readParticipantFile().usageTelemetryEnabled, true, "usage telemetry recorded as true");
        showInformationMessageHook = undefined;
        context.subscriptions.forEach(s => s.dispose && s.dispose());
    }
    console.log("✓ Test 4 passed");

    console.log("--- Test 5: opening Thumbview triggers the invite modal on the first open ---");
    {
        writeParticipantFile({});
        let inviteModalShown = false;
        showInformationMessageHook = async (msg, opts, ...items) => {
            if (msg.includes("Would you help research on finding code spatially?") && opts && opts.modal === true) {
                inviteModalShown = true;
                return "No Thanks";
            }
            return undefined;
        };
        const context = makeContext();
        const studyApi = createStudy(context, { isThumbviewVisible: () => true, log });
        studyApi.recordShown("f4", true, 10);
        await new Promise(resolve => setTimeout(resolve, 750));
        assert.strictEqual(inviteModalShown, true, "invite modal was shown on first open");
        assert.strictEqual(context.globalState.get("thumbview.study.inviteShown"), true, "invite recorded as shown");
        showInformationMessageHook = undefined;
        context.subscriptions.forEach(s => s.dispose && s.dispose());
    }
    console.log("✓ Test 5 passed");

    console.log("--- Test 6: participant IDs use P- format and no longer use auto- prefix ---");
    {
        const id1 = generateFallbackParticipantId();
        const id2 = generateFallbackParticipantId();
        assert(id1.startsWith("P-"), "starts with P- prefix");
        assert(id2.startsWith("P-"), "starts with P- prefix");
        assert(!id1.startsWith("auto-"), "no longer uses auto- prefix");
        assert(!id2.startsWith("auto-"), "no longer uses auto- prefix");
        assert(/^P-[0-9]+$/.test(id1), "matches P-xxx format");
        assert(/^P-[0-9]+$/.test(id2), "matches P-xxx format");

        const fetchedId = await fetchNextParticipantId();
        assert(fetchedId.startsWith("P-"), "fallback starts with P-");
        assert(!fetchedId.startsWith("auto-"), "fallback does not use auto-");
    }
    console.log("✓ Test 6 passed");

    fs.rmSync(home, { recursive: true, force: true });
    console.log("\nAll study host tests passed.");
    process.exit(0);
})().catch(err => {
    console.error(err);
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
});
