// Unit tests for the usage study's pure parts: path pseudonyms, the whitelist applied to the
// webview's episode summary, per-file visit history, editor-switch attribution, and the batching
// upload client (queue persistence, back-off, and leaving mid-upload).
const assert = require("assert");
const { hashPath, sanitizeEpisode, VisitHistory, attributeEditorSwitch, THUMBVIEW_ATTRIBUTION_MS, fileKey, isDeliberateSwitch, HostVisitTracker } = require("../../out/study/study_events");
const { StudyClient, MAX_QUEUED_EVENTS, BATCH_SIZE, isRowRejection } = require("../../out/study/study_client");
const { endParticipation, readParticipantFile, writeParticipantFile } = require("../../out/study/participant_file");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { isStudyConfigured, STUDY_CONFIG } = require("../../out/study/study_config");

(async () => {
    console.log("--- Test 1: path pseudonyms are stable per participant and reveal nothing ---");
    const a = hashPath("salt-1", "ws", "src/app.ts");
    assert.strictEqual(a, hashPath("salt-1", "ws", "src\\app.ts"), "path separators do not matter");
    assert.notStrictEqual(a, hashPath("salt-2", "ws", "src/app.ts"), "another participant gets another value");
    assert.notStrictEqual(a, hashPath("salt-1", "other-ws", "src/app.ts"), "the same path in another workspace differs");
    assert(!a.includes("app"), "the name does not appear");
    console.log("✓ Test 1 passed");

    console.log("--- Test 2: only whitelisted, bounded fields survive; never text ---");
    const props = sanitizeEpisode({
        outcome: "jump", method: "hack", sinceRevealMs: 1234.6, queryLength: 5, query: "secret",
        uri: "file:///ws/secret.ts", searchUsed: "yes", tilesHovered: -4, targetCol: 3, extra: { a: 1 }
    });
    assert.strictEqual(props.outcome, "jump");
    assert.strictEqual(props.method, "none", "unknown enum values fall back");
    assert.strictEqual(props.since_reveal_ms, 1235);
    assert.strictEqual(props.time_to_target_ms, 1235);
    assert.strictEqual(props.slot_col, 3);
    assert.strictEqual(props.search_used, false, "booleans must be real booleans");
    assert.strictEqual(props.tiles_hovered, 0, "negative counts are clamped");
    assert.strictEqual(props.first_action_ms, null, "missing numbers are null");
    assert.strictEqual(props.reaction_time_ms, null, "missing numbers are null");
    assert(!JSON.stringify(props).includes("secret"), "no query text or path is kept");
    assert(!("extra" in props) && !("query" in props) && !("uri" in props));
    console.log("✓ Test 2 passed");

    console.log("--- Test 3: visit history reports prior visits and time since the last one ---");
    const visits = new VisitHistory();
    assert.deepStrictEqual(visits.record("h", 1000), { priorVisits: 0, sinceLastVisitMs: null });
    assert.deepStrictEqual(visits.record("h", 4000), { priorVisits: 1, sinceLastVisitMs: 3000 });
    assert.deepStrictEqual(visits.peek("h", 5000), { priorVisits: 2, sinceLastVisitMs: 1000 });
    assert.deepStrictEqual(visits.peek("h", 5000), { priorVisits: 2, sinceLastVisitMs: 1000 }, "peeking records nothing");
    // Two windows share the stored record: each adds only its own new visits on save.
    const stored = {};
    const windowA = new VisitHistory(stored);
    const windowB = new VisitHistory(stored);
    windowA.record("f", 100);
    windowB.record("f", 200);
    const afterA = windowA.mergeInto(stored);
    const afterB = windowB.mergeInto(afterA);
    assert.deepStrictEqual(afterB.f, { count: 2, last: 200 }, "visits from two windows add up instead of overwriting each other");
    assert.strictEqual(windowB.hasPending, false);
    windowA.refreshBase(afterB);
    assert.strictEqual(windowA.peek("f", 300).priorVisits, 2, "a window sees the other window's visits after refreshing");
    console.log("✓ Test 3 passed");

    console.log("--- Test 4: an editor switch right after a Thumbview jump to that file is Thumbview's ---");
    const target = { key: fileKey("/ws/a.ts"), at: 10000 };
    assert.strictEqual(attributeEditorSwitch(fileKey("/ws/a.ts"), 10500, target), "thumbview");
    assert.strictEqual(attributeEditorSwitch(fileKey("/ws/b.ts"), 10500, target), "other");
    assert.strictEqual(attributeEditorSwitch(fileKey("/ws/a.ts"), 10000 + THUMBVIEW_ATTRIBUTION_MS + 1, target), "other");
    assert.strictEqual(attributeEditorSwitch(fileKey("/ws/a.ts"), 10500, null), "other");
    assert.strictEqual(fileKey("C:\\Ws\\A.ts", "win32"), fileKey("c:/ws/a.ts", "win32"), "Windows paths compare regardless of case and separators");
    assert.notStrictEqual(fileKey("/ws/A.ts", "linux"), fileKey("/ws/a.ts", "linux"));
    assert.strictEqual(isDeliberateSwitch({ previousStillVisible: true, tabOpened: false, tabClosedJustBefore: false, viaThumbview: false }), false, "focus moving between splits is not an open");
    assert.strictEqual(isDeliberateSwitch({ previousStillVisible: false, tabOpened: false, tabClosedJustBefore: true, viaThumbview: false }), false, "the tab VS Code shows after a close is not an open");
    assert.strictEqual(isDeliberateSwitch({ previousStillVisible: true, tabOpened: true, tabClosedJustBefore: false, viaThumbview: false }), true, "opening a file beside another is an open");
    assert.strictEqual(isDeliberateSwitch({ previousStillVisible: false, tabOpened: false, tabClosedJustBefore: false, viaThumbview: false }), true, "switching to an open tab is an open");
    console.log("✓ Test 4 passed");

    console.log("--- Test 5: the client batches, persists, backs off, and survives leaving mid-upload ---");
    let saved = [];
    const store = { load: () => [], save: rows => { saved = [...rows]; } };
    let now = 0;
    const calls = [];
    let respond = () => ({ ok: true, status: 201 });
    const client = new StudyClient({ url: "https://precision.usask.ca/study/api", key: "secret" }, store, async (url, init) => {
        calls.push({ url, init });
        return respond();
    }, () => now);
    const row = n => ({ event_id: `e${n}`, participant_id: "p", session_id: "s", event: "action", ts: String(n), ext_version: "1", schema_version: 1, props: { n } });
    client.enqueue(row(1));
    client.enqueue(row(2));
    assert.strictEqual(saved.length, 2, "the queue is persisted on enqueue");
    await client.flush();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, "https://precision.usask.ca/study/api/events");
    assert.strictEqual(calls[0].init.headers["X-Study-Key"], "secret");
    assert.strictEqual(JSON.parse(calls[0].init.body).length, 2);
    assert.strictEqual(client.pending, 0);
    assert.strictEqual(saved.length, 0);

    respond = () => ({ ok: false, status: 500 });
    client.enqueue(row(3));
    await client.flush();
    assert.strictEqual(client.pending, 1, "a failed upload keeps the events");
    await client.flush();
    assert.strictEqual(calls.length, 2, "and backs off instead of retrying at once");
    now += 31_000;
    respond = () => ({ ok: true, status: 201 });
    await client.flush();
    assert.strictEqual(client.pending, 0, "the retry after the back-off sends them");

    let release;
    respond = () => new Promise(resolve => { release = () => resolve({ ok: true, status: 201 }); });
    client.enqueue(row(4));
    const inFlight = client.flush();
    client.clear();
    client.enqueue(row(5));
    release();
    await inFlight;
    assert.strictEqual(client.pending, 1, "leaving mid-upload drops what was queued; later events are untouched");

    // A rejected batch is retried row by row: an already-stored row (409) and a bad row (400) are
    // dropped, the others are sent, and only the 400 is reported.
    const dropped = [];
    const sentIds = [];
    const picky = new StudyClient({ url: "u", anonKey: "k" }, { load: () => [], save: () => { } }, async (url, init) => {
        const rows = JSON.parse(init.body);
        if (rows.some(r => r.event_id === "dup")) return { ok: false, status: 409 };
        if (rows.some(r => r.event_id === "bad")) return { ok: false, status: 400, text: async () => '{"code":"23514","message":"check constraint"}' };
        sentIds.push(...rows.map(r => r.event_id));
        return { ok: true, status: 201 };
    }, () => 0, (count, status) => dropped.push(status));
    for (const id of ["a", "dup", "b", "bad", "c"]) picky.enqueue({ ...row(0), event_id: id });
    await picky.flush();
    assert.deepStrictEqual(sentIds, ["a", "b", "c"]);
    assert.strictEqual(picky.pending, 0, "nothing blocks the queue");
    assert.deepStrictEqual(dropped, [400], "a duplicate is not a loss");
    for (const status of [401, 403, 404, 408, 429, 500, 503, 0]) {
        assert.strictEqual(isRowRejection(status), false, `${status} is systemic, not the rows' fault`);
    }
    // A 400 is the rows' fault only for a PostgreSQL data or constraint error (SQLSTATE 22xxx/23xxx).
    assert.strictEqual(isRowRejection(400, '{"code":"23514"}'), true, "check constraint");
    assert.strictEqual(isRowRejection(400, '{"code":"22P02"}'), true, "invalid input");
    assert.strictEqual(isRowRejection(409, ""), true, "duplicate event_id");
    assert.strictEqual(isRowRejection(400, '{"code":"PGRST204","message":"Could not find the column"}'), false, "a schema mistake is systemic");
    assert.strictEqual(isRowRejection(400, '{"code":"42501"}'), false, "a permission error is systemic");
    assert.strictEqual(isRowRejection(400, "<html>Bad Request</html>"), false, "an unreadable body is systemic");
    assert.strictEqual(isRowRejection(400), false, "no body is systemic");

    // A configuration error (rotated key, wrong URL, policy mistake, a column missing from the
    // schema) keeps every row and backs off.
    for (const [status, body] of [[401, ""], [404, ""], [400, '{"code":"PGRST204","message":"Could not find the \'x\' column"}']]) {
        let requests = 0;
        const misconfigured = new StudyClient({ url: "u", anonKey: "k" }, { load: () => [], save: () => { } }, async () => {
            requests++;
            return { ok: false, status, text: async () => body };
        }, () => 0, () => assert.fail("nothing may be reported as dropped"));
        for (let i = 0; i < 50; i++) misconfigured.enqueue(row(i));
        await misconfigured.flush();
        assert.strictEqual(misconfigured.pending, 50, `HTTP ${status} keeps the queue`);
        assert.strictEqual(requests, 1, `HTTP ${status} does not fall back to one request per row`);
    }

    // Bisection: one bad row among 1,000 costs a few requests, not one per row.
    let bisectRequests = 0;
    const bisect = new StudyClient({ url: "u", anonKey: "k" }, { load: () => [], save: () => { } }, async (url, init) => {
        bisectRequests++;
        return JSON.parse(init.body).some(r => r.event_id === "e500") ? { ok: false, status: 400, text: async () => '{"code":"22P02"}' } : { ok: true, status: 201 };
    }, () => 0);
    for (let i = 0; i < 1000; i++) bisect.enqueue(row(i));
    await bisect.flush();
    assert.strictEqual(bisect.pending, 0);
    const cleanBatches = Math.ceil(1000 / BATCH_SIZE);
    assert(bisectRequests <= cleanBatches + 2 * Math.ceil(Math.log2(BATCH_SIZE)) + 4, `bisection took ${bisectRequests} requests`);

    // An upload that succeeds while retain() swaps the queue removes the stored batch from the new
    // queue, so it is not sent again.
    let releaseRace;
    const raceSent = [];
    const race = new StudyClient({ url: "u", anonKey: "k" }, { load: () => [], save: () => { } }, async (url, init) => {
        const ids = JSON.parse(init.body).map(r => r.event_id);
        raceSent.push(...ids);
        if (raceSent.length === ids.length) {
            return new Promise(resolve => { releaseRace = () => resolve({ ok: true, status: 201 }); });
        }
        return { ok: true, status: 201 };
    }, () => 0);
    race.enqueue(row(1));
    race.enqueue({ ...row(2), participant_id: "old" });
    const racing = race.flush();
    race.retain(r => r.participant_id === "p");
    race.enqueue(row(3));
    releaseRace();
    await racing;
    assert.strictEqual(race.pending, 1, "only the event queued during the upload remains");
    await race.flush();
    assert.deepStrictEqual(raceSent, ["e1", "e2", "e3"], "e1 is sent once");

    // retain keeps only the current participant's rows (an adopted queue may hold a former ID's).
    const mixed = new StudyClient({ url: "u", anonKey: "k" }, { load: () => [{ ...row(1), participant_id: "old" }, row(2)], save: () => { } }, async () => ({ ok: true, status: 201 }), () => 0);
    mixed.retain(r => r.participant_id === "p");
    assert.strictEqual(mixed.pending, 1);

    // sendNow goes out even while an upload is in flight, and counts a duplicate as delivered.
    let releaseUpload;
    const direct = [];
    const busy = new StudyClient({ url: "u", anonKey: "k" }, { load: () => [], save: () => { } }, async (url, init) => {
        const rows = JSON.parse(init.body);
        if (rows[0].event === "study_left") {
            direct.push(rows[0].event_id);
            return { ok: false, status: 409 };
        }
        return new Promise(resolve => { releaseUpload = () => resolve({ ok: true, status: 201 }); });
    }, () => 0);
    busy.enqueue(row(9));
    const uploading = busy.flush();
    assert.strictEqual(await busy.sendNow({ ...row(10), event: "study_left" }), true);
    assert.deepStrictEqual(direct, ["e10"]);
    releaseUpload();
    await uploading;

    const big = new StudyClient({ url: "u", anonKey: "k" }, { load: () => [], save: () => { } }, async () => ({ ok: false, status: 0 }), () => 0);
    for (let i = 0; i < MAX_QUEUED_EVENTS + 10; i++) {
        big.enqueue(row(i));
    }
    assert.strictEqual(big.pending, MAX_QUEUED_EVENTS, "the offline queue is bounded");
    console.log("✓ Test 5 passed");

    console.log("--- Test 5b: leaving or uninstalling ends participation in the shared per-computer file ---");
    const participant = { id: "pid-1", salt: "s", enrolledAt: 1, consentVersion: 1 };
    assert.deepStrictEqual(endParticipation({ participant }, "uninstall"), { formerParticipantId: "pid-1", endedBy: "uninstall" });
    assert.strictEqual(endParticipation({ formerParticipantId: "pid-0" }, "leave"), null, "nobody enrolled: nothing to change");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tv-study-"));
    const file = path.join(dir, "nested", "study.json");
    assert.deepStrictEqual(readParticipantFile(file), {}, "a missing file means not enrolled");
    writeParticipantFile({ participant }, file);
    assert.deepStrictEqual(readParticipantFile(file).participant, participant);
    if (process.platform !== "win32") {
        assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, "only the user can read the salt");
    }
    fs.rmSync(dir, { recursive: true, force: true });
    console.log("✓ Test 5b passed");

    console.log("--- Test 5c: a tab closed mid-visit is reported as dismissed by the host ---");
    const tracker = new HostVisitTracker();
    assert.strictEqual(tracker.closedTab(5000), null, "no visit announced: nothing to report");
    tracker.started(1000);
    const closed = sanitizeEpisode(tracker.closedTab(4000));
    assert.strictEqual(closed.outcome, "dismissed");
    assert.strictEqual(closed.tab_closed, true);
    assert.strictEqual(closed.time_to_target_ms, 3000, "the host's visible time");
    assert.strictEqual(closed.since_reveal_ms, 3000, "the host's visible time");
    assert.strictEqual(closed.tiles_hovered, null, "the page's counts are unknown, not zero");
    assert.strictEqual(tracker.closedTab(9000), null, "reported once");
    tracker.started(1000);
    tracker.handedOff();
    assert.strictEqual(tracker.closedTab(4000), null, "a visit the webview reported is not reported again");
    assert.strictEqual(sanitizeEpisode({ outcome: "jump" }).tab_closed, false, "webview episodes are not tab closes");
    console.log("✓ Test 5c passed");

    console.log("--- Test 6: the study is dormant until configured ---");
    assert.strictEqual(isStudyConfigured({ ...STUDY_CONFIG, ingestUrl: "", consentUrl: "c" }), false);
    assert.strictEqual(isStudyConfigured({ ...STUDY_CONFIG, ingestUrl: "u", consentUrl: "c" }), true);
    assert.strictEqual(isStudyConfigured({ ...STUDY_CONFIG, supabaseUrl: "", supabaseAnonKey: "k", consentUrl: "c" }), false);
    assert.strictEqual(isStudyConfigured({ ...STUDY_CONFIG, supabaseUrl: "u", supabaseAnonKey: "k", consentUrl: "c" }), true);
    console.log("✓ Test 6 passed");

    console.log("\nAll study tests passed.");
})().catch(err => {
    console.error(err);
    process.exit(1);
});
