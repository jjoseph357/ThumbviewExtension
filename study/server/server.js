// Telemetry ingestion service for Thumbview usage study running on precision.usask.ca.
// Receives batched events via HTTP POST and inserts them into PostgreSQL relational tables.
const http = require("http");
const { Pool } = require("pg");

const PORT = parseInt(process.env.PORT || "3000", 10);
const STUDY_SECRET = process.env.STUDY_SECRET || "";
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    host: process.env.PGHOST || "localhost",
    port: parseInt(process.env.PGPORT || "5432", 10),
    database: process.env.PGDATABASE || "thumbview_study",
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "",
    max: 20
});

function sendJson(res, statusCode, data) {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, X-Study-Key",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
    });
    res.end(body);
}

function verifyAuth(req) {
    if (!STUDY_SECRET) {
        return true;
    }
    const authHeader = req.headers["authorization"] || "";
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const apiKey = req.headers["apikey"] || req.headers["x-study-key"] || "";
    return bearer === STUDY_SECRET || apiKey === STUDY_SECRET;
}

async function handleEvents(events) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        for (const item of events) {
            const { event_id, participant_id, session_id, event, ts, ext_version, schema_version, props = {} } = item;

            // 1. Ensure participant record exists
            await client.query(
                `insert into participants (participant_id, enrolled_at, consent_version, platform, vscode_version, ext_version)
                 values ($1, $2, $3, $4, $5, $6)
                 on conflict (participant_id) do update set
                    consent_version = coalesce(excluded.consent_version, participants.consent_version),
                    platform = coalesce(excluded.platform, participants.platform),
                    vscode_version = coalesce(excluded.vscode_version, participants.vscode_version),
                    ext_version = coalesce(excluded.ext_version, participants.ext_version),
                    updated_at = now()`,
                [
                    participant_id,
                    ts,
                    props.consent_version || 1,
                    props.platform || null,
                    props.vscode_version || null,
                    ext_version || null
                ]
            );

            // 2. Insert into raw_events for complete audit trail
            await client.query(
                `insert into raw_events (event_id, participant_id, session_id, event, ts, ext_version, schema_version, props)
                 values ($1, $2, $3, $4, $5, $6, $7, $8)
                 on conflict (event_id) do nothing`,
                [event_id, participant_id, session_id, event, ts, ext_version, schema_version, JSON.stringify(props)]
            );

            // 3. Route to dedicated relational tables
            if (event === "study_left") {
                await client.query(
                    `update participants set left_at = $2, updated_at = now() where participant_id = $1`,
                    [participant_id, ts]
                );
            } else if (event === "session_start") {
                await client.query(
                    `insert into sessions (session_id, participant_id, started_at, workspace_hash, workspace_folders, layout_mode, fullscreen_on_open, days_since_enrolled, platform, vscode_version, ext_version)
                     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                     on conflict (session_id) do nothing`,
                    [
                        session_id, participant_id, ts,
                        props.workspace_hash || null,
                        props.workspace_folders ?? null,
                        props.layout_mode || null,
                        props.fullscreen_on_open ?? null,
                        props.days_since_enrolled ?? null,
                        props.platform || null,
                        props.vscode_version || null,
                        ext_version || null
                    ]
                );
            } else if (event === "thumbview_episode") {
                await client.query(
                    `insert into episodes (
                        event_id, participant_id, session_id, ts, ext_version,
                        outcome, interaction_method, time_to_target_ms, focused_duration_ms, reaction_time_ms,
                        start_source, reveal_latency_ms, target_file_hash, slot_col, slot_row, grid_cols, grid_rows,
                        target_position_changed, target_prior_visits, target_since_last_visit_ms,
                        search_used, query_length, search_edits, search_toggles, search_match_count, target_matched_search,
                        tiles_hovered, magnifier_uses, folder_drill_ins, folder_back_outs, keyboard_moves,
                        view_kind, folder_cards_view, focused_folder_depth, layout_mode, fullscreen, file_count, tab_closed
                     ) values (
                        $1, $2, $3, $4, $5,
                        $6, $7, $8, $9, $10,
                        $11, $12, $13, $14, $15, $16, $17,
                        $18, $19, $20,
                        $21, $22, $23, $24, $25, $26,
                        $27, $28, $29, $30, $31,
                        $32, $33, $34, $35, $36, $37, $38
                     ) on conflict (event_id) do nothing`,
                    [
                        event_id, participant_id, session_id, ts, ext_version,
                        props.outcome || "dismissed",
                        props.interaction_method || props.method || "none",
                        props.time_to_target_ms ?? props.since_reveal_ms ?? null,
                        props.focused_duration_ms ?? props.focused_ms ?? null,
                        props.reaction_time_ms ?? props.first_action_ms ?? null,
                        props.start_source || "interaction",
                        props.reveal_latency_ms ?? null,
                        props.target_file_hash || null,
                        props.slot_col ?? props.target_col ?? null,
                        props.slot_row ?? props.target_row ?? null,
                        props.grid_cols ?? null,
                        props.grid_rows ?? null,
                        props.target_position_changed ?? props.target_moved_since_last_visit ?? null,
                        props.target_prior_visits ?? null,
                        props.target_since_last_visit_ms ?? null,
                        props.search_used === true,
                        props.query_length ?? null,
                        props.search_edits ?? null,
                        props.search_toggles ?? null,
                        props.search_match_count ?? null,
                        props.target_matched_search ?? null,
                        props.tiles_hovered ?? null,
                        props.magnifier_uses ?? null,
                        props.folder_drill_ins ?? null,
                        props.folder_back_outs ?? null,
                        props.keyboard_moves ?? null,
                        props.view_kind || null,
                        props.folder_cards_view ?? null,
                        props.focused_folder_depth ?? null,
                        props.layout_mode || null,
                        props.fullscreen ?? null,
                        props.file_count ?? null,
                        props.tab_closed === true
                    ]
                );
            } else if (event === "editor_switch") {
                await client.query(
                    `insert into editor_switches (
                        event_id, participant_id, session_id, ts, ext_version,
                        navigation_source, is_deliberate, file_hash, prior_visits,
                        since_last_visit_ms, since_last_switch_ms, thumbview_visible,
                        new_tab, after_tab_close, previous_still_visible
                     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                     on conflict (event_id) do nothing`,
                    [
                        event_id, participant_id, session_id, ts, ext_version,
                        props.navigation_source || props.via || "other",
                        props.is_deliberate ?? props.deliberate ?? true,
                        props.file_hash || "",
                        props.prior_visits ?? 0,
                        props.since_last_visit_ms ?? null,
                        props.since_last_switch_ms ?? null,
                        props.thumbview_visible === true,
                        props.new_tab ?? null,
                        props.after_tab_close ?? null,
                        props.previous_still_visible ?? null
                    ]
                );
            } else if (event === "thumbview_shown") {
                await client.query(
                    `insert into opens (event_id, participant_id, session_id, ts, ext_version, trigger, cold_start, file_count)
                     values ($1, $2, $3, $4, $5, $6, $7, $8)
                     on conflict (event_id) do nothing`,
                    [event_id, participant_id, session_id, ts, ext_version, props.trigger || null, props.cold_start ?? null, props.file_count ?? null]
                );
            } else if (event === "action") {
                await client.query(
                    `insert into actions (event_id, participant_id, session_id, ts, ext_version, action_name)
                     values ($1, $2, $3, $4, $5, $6)
                     on conflict (event_id) do nothing`,
                    [event_id, participant_id, session_id, ts, ext_version, props.action_name || props.action || ""]
                );
            } else if (event === "survey_opened") {
                await client.query(
                    `insert into surveys (event_id, participant_id, session_id, ts, ext_version, survey_type)
                     values ($1, $2, $3, $4, $5, $6)
                     on conflict (event_id) do nothing`,
                    [event_id, participant_id, session_id, ts, ext_version, props.survey_type || props.which || "pre"]
                );
            }
        }

        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, X-Study-Key",
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
        });
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname.replace(/\/+$/, "");

    if (req.method === "GET" && (pathname === "/health" || pathname.endsWith("/health"))) {
        sendJson(res, 200, { status: "ok", time: new Date().toISOString() });
        return;
    }

    if (req.method === "POST" && (pathname === "/events" || pathname.endsWith("/events"))) {
        if (!verifyAuth(req)) {
            sendJson(res, 401, { error: "Unauthorized" });
            return;
        }

        let body = "";
        let bytes = 0;
        req.on("data", chunk => {
            bytes += chunk.length;
            if (bytes > MAX_BODY_BYTES) {
                req.destroy();
                sendJson(res, 413, { error: "Payload too large", rowRejection: true });
                return;
            }
            body += chunk;
        });

        req.on("end", async () => {
            let data;
            try {
                data = JSON.parse(body);
            } catch (err) {
                sendJson(res, 400, { error: "Invalid JSON", rowRejection: true });
                return;
            }

            const events = Array.isArray(data) ? data : [data];
            if (events.length === 0) {
                sendJson(res, 200, { ok: true, count: 0 });
                return;
            }

            try {
                await handleEvents(events);
                sendJson(res, 200, { ok: true, count: events.length });
            } catch (err) {
                console.error("Ingest error:", err);
                const code = err.code;
                const isPgRowConstraint = typeof code === "string" && /^2[23][0-9A-Z]{3}$/.test(code);
                if (isPgRowConstraint) {
                    sendJson(res, 400, { error: err.message, code, rowRejection: true });
                } else {
                    sendJson(res, 500, { error: "Database error", message: err.message });
                }
            }
        });
        return;
    }

    sendJson(res, 404, { error: "Not Found" });
});

server.listen(PORT, () => {
    console.log(`Thumbview Telemetry Ingest Server running on port ${PORT}`);
});
