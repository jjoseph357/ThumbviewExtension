// The opt-in usage study (STUDY.md): enrollment and consent, the invitation and surveys, and the
// events extension.ts reports (Thumbview shown, one summary per visit, editor switches, named
// actions). Returns a StudyApi whose methods do nothing unless this computer's user joined, the
// study is configured, and VS Code usage telemetry is on.
import * as vscode from "vscode";
import { randomBytes, randomUUID } from "crypto";
import { endParticipation, readParticipantFile, writeParticipantFile, type Participant } from "./participant_file";
import { STUDY_CONFIG, STUDY_SCHEMA_VERSION, isStudyConfigured } from "./study_config";
import { StudyClient, type StudyRow } from "./study_client";
import { attributeEditorSwitch, fileKey, hashPath, isDeliberateSwitch, revealLatencyMs, sanitizeEpisode, SlotMemory, VisitHistory, type StudyEvent, type StudyEventName, type VisitRecord } from "./study_events";

const QUEUE_KEY_PREFIX = "thumbview.study.queue.";
const VISITS_KEY = "thumbview.study.visits";
const SLOTS_KEY = "thumbview.study.slots";
const OPEN_COUNT_KEY = "thumbview.study.openCount";
const INVITE_SHOWN_KEY = "thumbview.study.inviteShown";
const POST_SURVEY_DONE_KEY = "thumbview.study.postSurveyDone";

const FLUSH_INTERVAL_MS = 60_000;
const FLUSH_AT_PENDING = 50;
/** Another window's queue not saved for this long belongs to a closed window; this window sends it. */
const ORPHAN_QUEUE_MS = 5 * 60_000;
/** Tab events this close to an editor change describe that change (VS Code does not order them). */
const TAB_SIGNAL_WINDOW_MS = 500;
/** Visit history is saved this long after a visit, so other windows' prior_visits stay current. */
const VISITS_SAVE_DELAY_MS = 5000;

export type ShownTrigger = "f4" | "command" | "tab";

/** The conditions a visit ran under, from the host: they can change mid-session. */
export interface EpisodeConditions {
    layoutMode: string;
    /** Whether Thumbview was in its fullscreen (Zen) mode during the visit. */
    fullscreen: boolean;
}

export interface StudyApi {
    /**
     * Thumbview became visible. `trigger`: how; `coldStart`: the panel was created (not revealed);
     * `fileCount`: files on the map, or null when the scan has not finished. Returns whether the
     * study is active (the caller then tells the webview a visit started).
     */
    recordShown(trigger: ShownTrigger, coldStart: boolean, fileCount: number | null): boolean;
    /** Thumbview was hidden; the study invitation waits for this so it never shows over Zen mode. */
    recordHidden(): void;
    /**
     * The webview's summary of one visit ("studyEpisode" message). `openRequestedAt`: when F4 or the
     * Open command asked for this visit (host clock), or null for a tab click.
     */
    recordEpisode(raw: { [key: string]: unknown }, openRequestedAt?: number | null, conditions?: EpisodeConditions): void;
    /** A jump or tab switch from Thumbview is about to open this file. */
    noteThumbviewTarget(uri: string): void;
    /** That open failed: a later manual open of the same file must not be credited to Thumbview. */
    clearThumbviewTarget(): void;
    /** A named Thumbview action: layout customization (drag, ignore, reflow, mode) or a context-menu file command. */
    recordAction(action: string): void;
    /** Whether the webview should collect episode summaries. */
    isActive(): boolean;
    /** Flushes what can be sent within a short time (deactivate). */
    shutdown(): Promise<void>;
}

export function createStudy(
    context: vscode.ExtensionContext,
    options: { isThumbviewVisible: () => boolean; log: vscode.LogOutputChannel }
): StudyApi {
    const configured = isStudyConfigured();
    const extVersion = String(context.extension.packageJSON.version ?? "");
    const sessionId = randomUUID();

    // Re-read on every flush and on window focus, so leaving in one window stops the others.
    let participantFile = readParticipantFile();
    const refreshParticipant = () => {
        participantFile = readParticipantFile();
    };
    const getParticipant = () => participantFile.participant;

    // Usage data needs telemetry level "all"; "error" and "crash" mean the user declined usage data.
    const telemetry = vscode.env.createTelemetryLogger({ sendEventData: () => { }, sendErrorData: () => { } });
    context.subscriptions.push(telemetry);
    // The uninstall script cannot read the telemetry level, so the last state seen here is kept in
    // the participant file for it (participant_file.ts mayNotifyUninstall).
    const recordTelemetryState = () => {
        try {
            const contents = readParticipantFile();
            if (contents.participant && contents.usageTelemetryEnabled !== telemetry.isUsageEnabled) {
                writeParticipantFile({ ...contents, usageTelemetryEnabled: telemetry.isUsageEnabled });
            }
            refreshParticipant();
        } catch {
        }
    };
    const isActive = () => {
        const participant = getParticipant();
        return configured && !!participant && participant.consentVersion === STUDY_CONFIG.consentVersion && telemetry.isUsageEnabled;
    };

    // Each window saves its own queue; a closed window's queue is adopted by the next window that
    // starts. Every row has an event_id, so a batch that two windows both send is stored once.
    const queueKey = `${QUEUE_KEY_PREFIX}${sessionId}`;
    const adoptOrphanQueues = (): StudyRow[] => {
        const adopted: StudyRow[] = [];
        for (const key of context.globalState.keys()) {
            if (!key.startsWith(QUEUE_KEY_PREFIX) || key === queueKey) {
                continue;
            }
            const stored = context.globalState.get<{ updatedAt: number; rows: StudyRow[] }>(key);
            if (!stored || Date.now() - stored.updatedAt > ORPHAN_QUEUE_MS) {
                adopted.push(...(stored?.rows ?? []));
                void context.globalState.update(key, undefined);
            }
        }
        return adopted;
    };
    const client = new StudyClient(
        { url: (STUDY_CONFIG as any).ingestUrl || (STUDY_CONFIG as any).supabaseUrl, key: (STUDY_CONFIG as any).ingestKey || (STUDY_CONFIG as any).supabaseAnonKey },
        {
            load: () => adoptOrphanQueues(),
            save: rows => context.globalState.update(queueKey, rows.length > 0 ? { updatedAt: Date.now(), rows } : undefined)
        },
        (url, init) => fetch(url, init),
        Date.now,
        (count, status) => options.log.warn(`Study: the database rejected ${count} event(s) (HTTP ${status}); they were dropped.`)
    );

    const visits = new VisitHistory(context.globalState.get<{ [hash: string]: VisitRecord }>(VISITS_KEY) ?? {});
    const storedVisits = () => context.globalState.get<{ [hash: string]: VisitRecord }>(VISITS_KEY) ?? {};

    const workspaceKey = () => (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.toString()).sort().join("|");
    const fileHash = (participant: Participant, uri: vscode.Uri) =>
        hashPath(participant.salt, workspaceKey(), vscode.workspace.asRelativePath(uri, true));

    // `at`: when it happened, for events emitted later than that (editor_switch waits for tab signals).
    const emit = (event: StudyEventName, props: StudyEvent["props"], at?: number) => {
        const participant = getParticipant();
        if (!participant || !isActive()) {
            return;
        }
        client.enqueue({
            event_id: randomUUID(),
            participant_id: participant.id,
            session_id: sessionId,
            event,
            ts: new Date(at ?? Date.now()).toISOString(),
            ext_version: extVersion,
            schema_version: STUDY_SCHEMA_VERSION,
            props
        });
        if (client.pending >= FLUSH_AT_PENDING) {
            void flush();
        }
    };

    const saveVisits = async () => {
        if (visits.hasPending) {
            await context.globalState.update(VISITS_KEY, visits.mergeInto(storedVisits()));
        }
    };
    let visitsSaveTimer: NodeJS.Timeout | undefined;
    const scheduleVisitsSave = () => {
        if (!visitsSaveTimer) {
            visitsSaveTimer = setTimeout(() => {
                visitsSaveTimer = undefined;
                void saveVisits();
            }, VISITS_SAVE_DELAY_MS);
        }
    };
    context.subscriptions.push({ dispose: () => visitsSaveTimer && clearTimeout(visitsSaveTimer) });

    const flush = async () => {
        refreshParticipant();
        const participant = getParticipant();
        if (!participant) {
            // Left, possibly in another window: nothing queued here may be sent.
            if (client.pending > 0) {
                client.clear();
            }
            return;
        }
        // Only the current participant's rows: an adopted queue may hold a former ID's events.
        client.retain(row => row.participant_id === participant.id);
        await saveVisits();
        if (isActive()) {
            await client.flush().catch(err => options.log.debug(`Study upload failed: ${err}`));
        }
    };
    const flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(flushTimer) });

    const updateContextKeys = () => {
        void vscode.commands.executeCommand("setContext", "thumbview.studyAvailable", configured);
        void vscode.commands.executeCommand("setContext", "thumbview.studyEnrolled", configured && !!getParticipant());
    };
    context.subscriptions.push(vscode.window.onDidChangeWindowState(state => {
        if (state.focused) {
            refreshParticipant();
            updateContextKeys();
        }
    }));

    const surveyUrl = (template: string, participant: Participant) => template.replace("{pid}", encodeURIComponent(participant.id));
    const openSurvey = async (which: "pre" | "post") => {
        const participant = getParticipant();
        const template = which === "pre" ? STUDY_CONFIG.preSurveyUrl : STUDY_CONFIG.postSurveyUrl;
        if (!participant || !template) {
            return;
        }
        emit("survey_opened", { survey_type: which, which });
        await vscode.env.openExternal(vscode.Uri.parse(surveyUrl(template, participant)));
    };

    const emitSessionStart = () => {
        const participant = getParticipant();
        if (!participant) {
            return;
        }
        const config = vscode.workspace.getConfiguration("thumbview");
        emit("session_start", {
            workspace_hash: hashPath(participant.salt, "workspace", workspaceKey()),
            workspace_folders: vscode.workspace.workspaceFolders?.length ?? 0,
            layout_mode: config.get<string>("layoutMode") ?? "spanning_grid",
            fullscreen_on_open: config.get<boolean>("fullscreenOnOpen") ?? true,
            days_since_enrolled: Math.floor((Date.now() - participant.enrolledAt) / 86_400_000),
            platform: process.platform,
            vscode_version: vscode.version
        });
    };

    const join = async (): Promise<boolean> => {
        if (!configured) {
            return false;
        }
        refreshParticipant();
        if (getParticipant()?.consentVersion === STUDY_CONFIG.consentVersion) {
            vscode.window.showInformationMessage("You are already taking part in the Thumbview study.");
            return true;
        }
        const detail = [
            "Thumbview's developers are studying how people find code with a spatial map, for an academic paper.",
            "",
            "If you join, Thumbview records how you use it: when you open it, how long it takes to open a file, whether you search or click, and how often you open files in other ways. Files are identified only by a scrambled code that cannot be turned back into a name. File contents, file and folder names, and search text are never sent.",
            "",
            "Your data is pseudonymous, not anonymous: it carries a random participant ID for this computer, and the database host sees your IP address when data is sent. The surveys receive the same participant ID so answers can be linked to usage.",
            "",
            "Joining is voluntary. You can leave at any time with \"Thumbview: Leave the Research Study\"; nothing more is sent from then on, including anything not yet uploaded. Please read the consent form before you agree."
        ].join("\n");
        for (;;) {
            const choice = await vscode.window.showInformationMessage(
                "Join the Thumbview research study?",
                { modal: true, detail },
                "Read Consent Form",
                "I Agree and Join"
            );
            if (choice === "Read Consent Form") {
                await vscode.env.openExternal(vscode.Uri.parse(STUDY_CONFIG.consentUrl));
                continue;
            }
            if (choice !== "I Agree and Join") {
                return false;
            }
            break;
        }
        if (!telemetry.isUsageEnabled) {
            const enableChoice = await vscode.window.showInformationMessage(
                "The Thumbview study requires VS Code usage telemetry to be enabled (setting telemetry.telemetryLevel to \"all\"). Would you like to enable it now?",
                {
                    modal: true,
                    detail: "VS Code usage telemetry is currently off or limited. To send study telemetry, the telemetry level must be set to \"all\"."
                },
                "Enable Telemetry and Join",
                "Open Settings",
                "Cancel"
            );
            if (enableChoice === "Enable Telemetry and Join") {
                try {
                    await vscode.workspace.getConfiguration("telemetry").update("telemetryLevel", "all", vscode.ConfigurationTarget.Global);
                } catch (err) {
                    vscode.window.showErrorMessage(`Failed to enable telemetry: ${err instanceof Error ? err.message : String(err)}`);
                    return false;
                }
            } else if (enableChoice === "Open Settings") {
                await vscode.commands.executeCommand("workbench.action.openSettings", "telemetry.telemetryLevel");
                return false;
            } else {
                return false;
            }
        }
        const previous = getParticipant();
        // Re-consent to a newer form keeps the identity; a new enrollment (including after leaving,
        // when the old ID's data may have been deleted on request) always gets a new one.
        const participant: Participant = {
            id: previous?.id ?? randomUUID(),
            salt: previous?.salt ?? randomBytes(32).toString("hex"),
            enrolledAt: previous?.enrolledAt ?? Date.now(),
            consentVersion: STUDY_CONFIG.consentVersion
        };
        if (!previous) {
            // A new participant (also after leaving or uninstalling) starts with no visit history.
            visits.reset();
            await context.globalState.update(VISITS_KEY, undefined);
            await context.globalState.update(SLOTS_KEY, undefined);
        }
        writeParticipantFile({ participant, usageTelemetryEnabled: true });
        refreshParticipant();
        updateContextKeys();
        emit("study_enrolled", { consent_version: participant.consentVersion, platform: process.platform, vscode_version: vscode.version });
        emitSessionStart();
        await openSurvey("pre");
        vscode.window.showInformationMessage(`Thank you for joining. Your participant ID is ${participant.id} (see "Thumbview: Research Study Info").`);
        return true;
    };

    const leave = async () => {
        refreshParticipant();
        const participant = getParticipant();
        if (!participant) {
            return;
        }
        // Participation ends first, so another window's next flush (which re-reads the file) sends
        // nothing during the up to 3 seconds study_left may take.
        const wasActive = isActive();
        writeParticipantFile(endParticipation(participantFile, "leave") ?? { formerParticipantId: participant.id, endedBy: "leave" });
        refreshParticipant();
        // Unsent usage is discarded, not uploaded, in every window's queue (closed windows' queues
        // too, which a later window would otherwise adopt); only the fact of leaving is sent, directly,
        // so neither an upload in flight nor the back-off can lose it.
        client.clear();
        for (const key of context.globalState.keys()) {
            if (key.startsWith(QUEUE_KEY_PREFIX)) {
                await context.globalState.update(key, undefined);
            }
        }
        if (wasActive) {
            await client.sendNow({
                event_id: randomUUID(),
                participant_id: participant.id,
                session_id: sessionId,
                event: "study_left",
                ts: new Date().toISOString(),
                ext_version: extVersion,
                schema_version: STUDY_SCHEMA_VERSION,
                props: { reason: "leave" }
            });
        }
        visits.reset();
        await context.globalState.update(VISITS_KEY, undefined);
        await context.globalState.update(SLOTS_KEY, undefined);
        updateContextKeys();
        vscode.window.showInformationMessage(
            `You have left the Thumbview study; nothing more will be sent. To have your data deleted, send your participant ID (${participant.id}) by opening an issue at https://github.com/jjoseph357/thumbview-issues`
        );
    };

    const info = async () => {
        refreshParticipant();
        const participant = getParticipant();
        const status = !participant
            ? "You are not taking part."
            : isActive()
                ? "You are taking part. Data is being sent."
                : "You are enrolled, but nothing is sent right now (VS Code usage telemetry is off, or the consent form changed and needs your agreement again).";
        const id = participant?.id ?? participantFile.formerParticipantId;
        const enableTelemetryButtons = (participant && !telemetry.isUsageEnabled) ? ["Enable Telemetry"] : [];
        const buttons = [
            participant ? "Leave Study" : "Join Study",
            ...enableTelemetryButtons,
            ...(id ? ["Copy Participant ID"] : []),
            "Open Consent Form",
            "Contact & Issues"
        ];
        const detail = [
            status,
            id ? `\n\nParticipant ID: ${id}` : "",
            participant ? `\nEvents waiting to be sent from this window: ${client.pending}` : "",
            "\n\nFeedback & Bug Reports: https://github.com/jjoseph357/thumbview-issues"
        ].join("");
        const choice = await vscode.window.showInformationMessage(
            "Thumbview research study",
            { modal: true, detail },
            ...buttons
        );
        if (choice === "Leave Study") {
            await leave();
        } else if (choice === "Join Study") {
            await join();
        } else if (choice === "Enable Telemetry") {
            try {
                await vscode.workspace.getConfiguration("telemetry").update("telemetryLevel", "all", vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage("VS Code usage telemetry enabled.");
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to enable telemetry: ${err instanceof Error ? err.message : String(err)}`);
            }
        } else if (choice === "Copy Participant ID" && id) {
            await vscode.env.clipboard.writeText(id);
        } else if (choice === "Open Consent Form") {
            await vscode.env.openExternal(vscode.Uri.parse(STUDY_CONFIG.consentUrl));
        } else if (choice === "Contact & Issues") {
            await vscode.env.openExternal(vscode.Uri.parse("https://github.com/jjoseph357/thumbview-issues/blob/main/README.md"));
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand("thumbview.study.join", join),
        vscode.commands.registerCommand("thumbview.study.leave", leave),
        vscode.commands.registerCommand("thumbview.study.info", info)
    );
    recordTelemetryState();
    updateContextKeys();
    emitSessionStart();

    // The follow-up survey, once, after postSurveyAfterDays.
    const maybeOfferPostSurvey = async () => {
        const participant = getParticipant();
        if (!participant || !isActive() || !STUDY_CONFIG.postSurveyUrl || context.globalState.get<boolean>(POST_SURVEY_DONE_KEY)) {
            return;
        }
        if (Date.now() - participant.enrolledAt < STUDY_CONFIG.postSurveyAfterDays * 86_400_000) {
            return;
        }
        const choice = await vscode.window.showInformationMessage(
            "Thumbview study: would you answer a short follow-up survey about your experience?",
            "Open Survey",
            "Later",
            "No Thanks"
        );
        if (choice === "Open Survey") {
            await openSurvey("post");
        }
        if (choice === "Open Survey" || choice === "No Thanks") {
            await context.globalState.update(POST_SURVEY_DONE_KEY, true);
        }
    };
    void maybeOfferPostSurvey();

    // Offered on first open to people who have not joined yet.
    // In fullscreen (Zen mode), non-modal notifications are silenced by zenMode.silentNotifications,
    // so the invitation uses a modal dialog so it reliably appears when Thumbview is first opened.
    let inviteTimer: NodeJS.Timeout | undefined;
    const checkInviteOnOpen = async () => {
        if (!configured || getParticipant() || context.globalState.get<boolean>(INVITE_SHOWN_KEY)) {
            return;
        }
        const opens = (context.globalState.get<number>(OPEN_COUNT_KEY) ?? 0) + 1;
        await context.globalState.update(OPEN_COUNT_KEY, opens);
        if (opens >= STUDY_CONFIG.inviteAfterOpens) {
            if (inviteTimer) {
                clearTimeout(inviteTimer);
            }
            inviteTimer = setTimeout(() => {
                inviteTimer = undefined;
                void invite();
            }, 600);
        }
    };
    context.subscriptions.push({ dispose: () => inviteTimer && clearTimeout(inviteTimer) });

    const invite = async () => {
        if (!configured || getParticipant() || context.globalState.get<boolean>(INVITE_SHOWN_KEY)) {
            return;
        }
        await context.globalState.update(INVITE_SHOWN_KEY, true);
        const choice = await vscode.window.showInformationMessage(
            "Would you help research on finding code spatially? Join the opt-in Thumbview study; no code, file names, or search text is ever collected.",
            {
                modal: true,
                detail: "Participate in an academic study on finding code spatially. Telemetry is pseudonymous, strictly opt-in, and never collects code, file names, file paths, or search queries."
            },
            "Learn More",
            "No Thanks"
        );
        if (choice === "Learn More") {
            await join();
        }
    };

    // Every workspace file shown in an editor, so opens through Thumbview can be compared with every
    // other way of opening a file (Quick Open, Explorer, search, Go to Definition; VS Code does not
    // say which). Tab events arrive in no fixed order around the editor change, so the event is
    // emitted TAB_SIGNAL_WINDOW_MS later with the tab signals seen on either side.
    let lastThumbviewTarget: { key: string; at: number } | null = null;
    let lastSwitchAt: number | null = null;
    let lastEditorKey: string | undefined;
    let lastTabClosedAt = -Infinity;
    const tabOpenedAt = new Map<string, number>();
    // Delayed editor_switch emits; run at shutdown so a window closed within the delay keeps them.
    const pendingSwitches = new Map<NodeJS.Timeout, () => void>();
    context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(e => {
        const now = Date.now();
        if (e.closed.length > 0) {
            lastTabClosedAt = now;
        }
        for (const tab of e.opened) {
            const input = tab.input as { uri?: vscode.Uri } | undefined;
            if (input?.uri) {
                tabOpenedAt.set(fileKey(input.uri.fsPath), now);
            }
        }
        for (const [key, at] of tabOpenedAt) {
            if (now - at > 10_000) {
                tabOpenedAt.delete(key);
            }
        }
    }));
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        const participant = getParticipant();
        if (!editor || !participant || !isActive()) {
            return;
        }
        const uri = editor.document.uri;
        if (uri.scheme !== "file" || !vscode.workspace.getWorkspaceFolder(uri)) {
            return;
        }
        const now = Date.now();
        const key = fileKey(uri.fsPath);
        const via = attributeEditorSwitch(key, now, lastThumbviewTarget);
        if (via === "thumbview") {
            lastThumbviewTarget = null;
        } else if (key === lastEditorKey) {
            // Back to the same file (e.g. closing Thumbview without choosing): not a new open.
            return;
        }
        const previousKey = lastEditorKey;
        lastEditorKey = key;
        const previousStillVisible = !!previousKey && vscode.window.visibleTextEditors.some(e => fileKey(e.document.uri.fsPath) === previousKey && e !== editor);
        const sinceLastSwitchMs = lastSwitchAt === null ? null : now - lastSwitchAt;
        lastSwitchAt = now;
        const thumbviewVisible = options.isThumbviewVisible();
        const emitSwitch = () => {
            pendingSwitches.delete(timer);
            const tabOpened = Math.abs((tabOpenedAt.get(key) ?? -Infinity) - now) <= TAB_SIGNAL_WINDOW_MS;
            const tabClosedJustBefore = now - lastTabClosedAt >= 0 && now - lastTabClosedAt <= TAB_SIGNAL_WINDOW_MS;
            refreshParticipant();
            visits.refreshBase(storedVisits());
            const hash = fileHash(participant, uri);
            const { priorVisits, sinceLastVisitMs } = visits.record(hash, now);
            const isDeliberate = isDeliberateSwitch({ previousStillVisible, tabOpened, tabClosedJustBefore, viaThumbview: via === "thumbview" });
            emit("editor_switch", {
                navigation_source: via,
                via,
                is_deliberate: isDeliberate,
                deliberate: isDeliberate,
                new_tab: tabOpened,
                after_tab_close: tabClosedJustBefore,
                previous_still_visible: previousStillVisible,
                file_hash: hash,
                prior_visits: priorVisits,
                since_last_visit_ms: sinceLastVisitMs,
                since_last_switch_ms: sinceLastSwitchMs,
                thumbview_visible: thumbviewVisible
            }, now);
            scheduleVisitsSave();
        };
        const timer = setTimeout(emitSwitch, TAB_SIGNAL_WINDOW_MS);
        pendingSwitches.set(timer, emitSwitch);
    }));
    context.subscriptions.push(telemetry.onDidChangeEnableStates(() => {
        recordTelemetryState();
        updateContextKeys();
    }));

    return {
        recordShown(trigger, coldStart, fileCount) {
            void checkInviteOnOpen();
            emit("thumbview_shown", { trigger, cold_start: coldStart, file_count: fileCount });
            return isActive();
        },
        recordHidden() {
        },
        recordEpisode(raw, openRequestedAt = null, conditions) {
            const participant = getParticipant();
            if (!participant || !isActive()) {
                return;
            }
            const props = sanitizeEpisode(raw);
            props.reveal_latency_ms = props.start_source === "reveal" ? revealLatencyMs(raw.revealedAtEpochMs, openRequestedAt) : null;
            props.layout_mode = conditions && (conditions.layoutMode === "spanning_grid" || conditions.layoutMode === "uniform_grid") ? conditions.layoutMode : null;
            props.fullscreen = conditions ? conditions.fullscreen : null;
            if (typeof raw.uri === "string" && props.outcome !== "dismissed") {
                try {
                    const hash = fileHash(participant, vscode.Uri.parse(raw.uri));
                    visits.refreshBase(storedVisits());
                    const { priorVisits, sinceLastVisitMs } = visits.peek(hash, Date.now());
                    props.target_file_hash = hash;
                    props.target_prior_visits = priorVisits;
                    props.target_since_last_visit_ms = sinceLastVisitMs;
                    // Root-grid slot compared with this file's last Thumbview visit (stored on this machine only).
                    const slotCol = typeof props.slot_col === "number" ? props.slot_col : props.target_col;
                    const slotRow = typeof props.slot_row === "number" ? props.slot_row : props.target_row;
                    if (typeof slotCol === "number" && typeof slotRow === "number") {
                        const slots = new SlotMemory(context.globalState.get<{ [hash: string]: string }>(SLOTS_KEY) ?? {});
                        const moved = slots.moved(hash, slotCol, slotRow);
                        props.target_position_changed = moved;
                        props.target_moved_since_last_visit = moved;
                        void context.globalState.update(SLOTS_KEY, slots.toJSON());
                    } else {
                        props.target_position_changed = null;
                        props.target_moved_since_last_visit = null;
                    }
                } catch {
                }
            }
            emit("thumbview_episode", props);
        },
        clearThumbviewTarget() {
            lastThumbviewTarget = null;
        },
        noteThumbviewTarget(uri) {
            try {
                lastThumbviewTarget = { key: fileKey(vscode.Uri.parse(uri).fsPath), at: Date.now() };
            } catch {
                lastThumbviewTarget = null;
            }
        },
        recordAction(action) {
            emit("action", { action_name: action.slice(0, 40), action: action.slice(0, 40) });
        },
        isActive,
        async shutdown() {
            for (const [timer, emitSwitch] of pendingSwitches) {
                clearTimeout(timer);
                emitSwitch();
            }
            await Promise.race([flush(), new Promise(resolve => setTimeout(resolve, 2000))]);
        }
    };
}
