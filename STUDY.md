# Thumbview usage study

Thumbview has an opt-in field study built in, for research on how people find code with a stable spatial map. This document explains how to switch it on, what it records, and how to analyze the data. The code lives in `src/study/`. The database schema and analysis views are in `study/`.

## Research questions and where the data answers them

| Question | Analysis view (`study/analysis.sql`) |
|---|---|
| How often do participants open Thumbview? | `analysis.daily_opens` |
| How fast do they reach the file they want, and does that improve? | `analysis.time_to_target_weekly` (split by outcome, `jump` or `switch_tab`, and by start source, `reveal` or `shown`) |
| Over time, do they rely less on search and more on spatial memory? | `analysis.search_vs_spatial_weekly`, `analysis.time_by_prior_visits`, `analysis.time_to_target_by_stability` (targets that stayed in place against ones that moved) |
| How long does Thumbview take to appear? | `analysis.reveal_latency_weekly` (median and 90th percentile from F4 to the page) |
| How much navigation goes through Thumbview rather than other ways of opening files? | `analysis.navigation_share_weekly` (a share and frequency; see Limitations on speed comparisons) |
| Do they eventually stop using Thumbview? | `analysis.retention` |
| How much do they rearrange the map or hide files? | `analysis.actions_weekly` |

Each view is per participant and study day or week (day 0 is the day they joined). Export a view to CSV and analyze it in R or Python, for example with mixed-effects models that have participant as a random effect.

## Turning the study on

The study stays dormant until it is configured. Its commands are hidden, and nothing is sent.

1. **Ethics approval.** Research with human participants usually needs approval from an ethics board (an IRB/REB). Write the consent form from the "What participants agree to" section below, and host it at a public URL.
2. **Database & Ingest Server (precision.usask.ca).**
   1. The study database is hosted on Canadian servers at the University of Saskatchewan (`precision.usask.ca`).
   2. SSH into `precision.usask.ca` and initialize PostgreSQL with `study/schema.sql`, then `study/analysis.sql`.
   3. Run the lightweight Node.js telemetry ingestion service in `study/server/` (see `study/server/README.md`) behind Nginx with HTTPS.
   4. The ingestion server validates batches and inserts them into dedicated relational tables (`episodes`, `editor_switches`, `opens`, etc.).
3. **Surveys.** Create the before and after surveys in any tool that can prefill a field from the URL. Put `{pid}` in the URL where the participant ID should go, for example `https://forms.example.org/pre?participant={pid}`. Thumbview replaces it, so survey answers can be joined to usage data.
4. **Configuration.** Fill in `src/study/study_config.ts`:
   - `ingestUrl`: e.g. `"https://precision.usask.ca/study/api"`
   - `ingestKey`: optional secret key if configured on the server
   - `consentUrl`
   - `preSurveyUrl` and `postSurveyUrl`
   - `postSurveyAfterDays`: when the follow-up survey is offered (default 14)
   - `inviteAfterOpens`: when the one-time invitation appears (default 1)
   - `consentVersion`: bump it whenever the consent text changes; participants then have to agree again before anything is sent
5. Build and publish as usual.

## How participation works

- **Invitation.** After the first time someone opens Thumbview, they see one notification asking whether they would help. They can also join at any time with **Thumbview: Join the Research Study**. Joining shows a summary and a link to the consent form, and needs an explicit "I Agree and Join".
- **Participant ID.** There is one participant per computer. Joining creates a random participant ID and a secret salt that never leaves the computer.
  - Both are stored in `~/.thumbview/study.json` and shared by every VS Code window and profile on that computer. **Thumbview: Research Study Info** shows and copies the ID.
  - With VS Code Remote, the extension runs on the remote host, which then has its own ID.
  - Leaving and joining again creates a new ID, because the old one's data may have been deleted on request.
- **Uninstalling ends participation**, the same as leaving. VS Code runs `dist/uninstall.js` once the extension is removed. That script marks the participant as former (`endedBy: "uninstall"`) and makes one best-effort attempt to send `study_left` with `reason: "uninstall"`, under the same conditions as any event: consent to the current form and usage telemetry on. The script cannot read the telemetry level, so it uses the last state a running Thumbview saw, which is kept in `study.json` (`usageTelemetryEnabled`); a file without it counts as off. Reinstalling Thumbview asks again, and joining creates a new ID. VS Code runs uninstall scripts at its next start after the removal, so `study_left` arrives late, and not at all if that start is offline.
- **Surveys.** The pre-study survey opens right after joining. The post-study survey is offered once, after `postSurveyAfterDays`.
- **When data is sent.** Only while the participant is enrolled, their consent matches the current `consentVersion`, and VS Code usage telemetry is on (`telemetry.telemetryLevel` is `all`). The levels `error` and `crash` mean the user declined usage data, so nothing is recorded under them.
- **Leaving.** **Thumbview: Leave the Research Study** stops collection immediately.
  - Participation ends in `study.json` first, so other windows send nothing from that moment.
  - Events not yet uploaded are discarded, not sent, in every window's queue, including queues left by windows that closed while offline. Only a `study_left` event (`reason: "leave"`) goes out, sent directly so an upload in progress cannot lose it.
  - Other open windows stop within a minute and discard their unsent events too.
  - Uploads only ever send the current participant's events, so nothing under a former ID is sent after a rejoin.
  - It shows the participant ID, so the participant can ask for their data to be deleted: `delete from participants where participant_id = '<id>';` (cascades to all related tables).
- **Sending.**
  - Events are batched and uploaded about once a minute to the ingest endpoint on `precision.usask.ca`. If the machine is offline, up to 5,000 unsent events per window are kept locally and sent later.
  - A closed window's leftover events are sent by the next window that starts.
  - Every event has a unique `event_id`. Duplicate events are ignored idempotently via `ON CONFLICT (event_id) DO NOTHING`.
  - A batch rejected for invalid row constraints (400/422/413) is bisected to isolate and drop only the problematic event.
  - Every other failure (temporary server error, network outage) keeps all events in local persistent storage and retries later with exponential back-off.

## What participants agree to (basis for the consent form)

**Recorded:**
- When Thumbview is opened and how, and how long it takes to appear.
- How long it takes to open a file from it.
- Whether they searched, how long the query was (never its text), and how many files matched.
- How many tiles they hovered, whether they used the magnifier or the keyboard, and folder drill-ins.
- Where the chosen tile sat on the grid, and whether it had moved since that file was last chosen (the previous position is kept only on the participant's computer).
- Which Thumbview actions they used (for example rearranging tiles or ignoring files), by name only.
- When they opened a file some other way.

**Never recorded:** file contents, file or folder names, paths, search text, and anything typed in the editor.

**Pseudonymous, not anonymous.** Every event carries the random participant ID for the computer, and the database host (`precision.usask.ca` at University of Saskatchewan, Canada) sees the IP address of each upload. The survey tool receives the same participant ID in the survey link, and sees whatever the participant types plus their IP address. The consent form must say all three.

**How files are identified.** Each file is identified by a keyed hash: HMAC-SHA256 over the workspace and relative path, keyed by the participant's secret salt. The hash tells you when the same file comes up again, but cannot be turned back into a name, even by the researchers.

## Database schema & fields (data dictionary)

Data is stored in dedicated, strongly-typed relational PostgreSQL tables on `precision.usask.ca`:

### 1. `episodes` table (Thumbview visits)

One row per Thumbview visit. A visit starts when Thumbview's page is revealed and ends with a jump, a tab switch, or leaving without opening anything:

| Field | Meaning |
|---|---|
| `outcome` | `jump` (opened a file at a line), `switch_tab` (switched to an open tab), or `dismissed` (left without choosing) |
| `interaction_method` | `click`, `keyboard` (arrows plus Enter), `view_band` (clicked the band showing the editor's visible range), or `none` |
| `time_to_target_ms` | **Time to target (visible)**: from the page appearing to the choice. Null when the start was not seen (`start_source` = `interaction`). A hide shorter than 500 ms, as during Zen mode steps, does not end the visit. |
| `focused_duration_ms` | **Time to target (focused)**: time the page had keyboard focus during the visit. Recommended as the primary time-to-target measure, because it excludes time Thumbview sat open beside code in tab or split mode. |
| `reaction_time_ms` | Time from the start of the visit to the first deliberate user action (typing, key, folder click); hovering does not count. |
| `start_source` | What started the clock: `reveal` (page appeared after F4), `shown` (host showed panel with no reveal step, e.g. tab click), or `interaction`. |
| `reveal_latency_ms` | **Time to open**: from pressing F4 (or running Open command) to the page appearing. |
| `search_used` | Whether search was used during this visit (`true`/`false`). |
| `query_length` | Length of query at time of selection (never the text). |
| `search_edits`, `search_toggles`, `search_match_count`, `target_matched_search` | Search interaction metrics and whether chosen file matched search. |
| `tiles_hovered`, `magnifier_uses`, `folder_drill_ins`, `folder_back_outs`, `keyboard_moves` | In-map exploration counts. |
| `slot_col`, `slot_row`, `grid_cols`, `grid_rows` | Chosen tile's slot in root grid, and total grid dimensions. |
| `target_position_changed` | Whether the chosen file's root slot differs from the last time it was chosen in Thumbview (`true`, `false`, or null on first visit). |
| `target_file_hash`, `target_prior_visits`, `target_since_last_visit_ms` | Keyed file hash pseudonym, visit history count, and time since previous visit. |
| `view_kind`, `folder_cards_view`, `focused_folder_depth`, `layout_mode`, `fullscreen`, `file_count`, `tab_closed` | Layout state and conditions during the visit. |

### 2. `editor_switches` table

Records when an active workspace editor changes:
- `navigation_source`: `thumbview` (opened via Thumbview) or `other` (Quick Open, Explorer, search, Go to Definition).
- `is_deliberate`: `true` for intentional file opens, `false` for focus moves between split editors or tab close shifts.
- `file_hash`, `prior_visits`, `since_last_visit_ms`, `since_last_switch_ms`, `thumbview_visible`.

### 3. Other relational tables
- `participants`: `participant_id`, `enrolled_at`, `left_at`, `consent_version`, `platform`, `vscode_version`, `ext_version`.
- `sessions`: `session_id`, `participant_id`, `started_at`, `workspace_hash`, `workspace_folders`, `layout_mode`, `fullscreen_on_open`, `days_since_enrolled`.
- `opens`: `trigger` (`f4`, `command`, `tab`), `cold_start`, `file_count`.
- `actions`: `action_name` (e.g. `reorderFile`, `reflow`, `ignoreFile`).
- `surveys`: `survey_type` (`pre`, `post`).
- `raw_events`: Complete JSON backup of every received event for auditability.

## Limitations to report in the paper

- **Speed against other ways of opening files.** VS Code does not tell extensions how a file was opened, so `navigation_source = 'other'` lumps together Quick Open, the Explorer, the Search view, Go to Definition, and tab clicks.
  - Only Thumbview visits have a start time, so time to target exists only for Thumbview. `since_last_switch_ms` is the time between file switches (reading plus navigating), not a time to target, so do not compare it with `time_to_target_ms`.
  - The data supports: the share of deliberate navigation that goes through Thumbview and how it changes (`navigation_share_weekly`), and within-participant improvement in Thumbview (`time_to_target_weekly`, `search_vs_spatial_weekly`, `time_by_prior_visits`).
  - "Faster than other ways" needs the before/after surveys, or a controlled task.
- **Deliberate switches are inferred** from tab and visibility signals (`is_deliberate`), which is a heuristic.
- **Attribution window.** A file opened from Thumbview is attributed to it when the editor switches to that file within 10 seconds.
- **Visit counts start at joining.** `prior_visits` starts at zero.
- **Session clock.** `ts` comes from the participant's clock. `received_at` is the server's clock on `precision.usask.ca`.
- **Selection bias.** Only people with VS Code usage telemetry on who accept the invitation take part.

## Contact & Feedback

- Issue tracker & study documentation: [github.com/jjoseph357/thumbview-issues](https://github.com/jjoseph357/thumbview-issues)
- Report an issue or feedback: [github.com/jjoseph357/thumbview-issues/issues](https://github.com/jjoseph357/thumbview-issues/issues)
- Informed consent form: [consent.html](https://jjoseph357.github.io/thumbview-issues/consent.html)

