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

1. **Ethics approval.** Research with human participants usually needs approval from an ethics board (an IRB). Write the consent form from the "What participants agree to" section below, and host it at a public URL.
2. **Database.**
   1. Create a Supabase project.
   2. In its SQL editor, run `study/supabase_schema.sql`, then `study/analysis.sql`.
   3. The schema lets the public (anon) key insert events and nothing else, so shipping that key inside the extension is safe.
   4. Never ship the service-role key.
3. **Surveys.** Create the before and after surveys in any tool that can prefill a field from the URL. Put `{pid}` in the URL where the participant ID should go, for example `https://forms.example.org/pre?participant={pid}`. Thumbview replaces it, so survey answers can be joined to usage data.
4. **Configuration.** Fill in `src/study/study_config.ts`:
   - `supabaseUrl` and `supabaseAnonKey`
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
  - It shows the participant ID, so the participant can ask for their data to be deleted: `delete from public.events where participant_id = '<id>';`.
- **Sending.**
  - Events are batched and uploaded about once a minute. If the machine is offline, up to 5,000 unsent events per window are kept locally and sent later.
  - A closed window's leftover events are sent by the next window that starts.
  - Every event has a unique `event_id`. An event sent twice (two windows, or a retry after a lost response) is rejected as a duplicate and stored once.
  - A batch the database rejects because of its rows is split in halves until the bad event is alone. Rows are at fault for a duplicate (409), an oversized request (413), or a 400/422 whose body carries a PostgreSQL data or constraint error (SQLSTATE `22xxx` or `23xxx`, such as a failed check constraint). That event is dropped (a 409 is a duplicate that is already stored) and the rest are sent, so one bad event cannot block the others.
  - Every other failure keeps all events and retries later with back-off: a wrong URL (404), a rotated key or a policy mistake (401, 403), a 400 from PostgREST itself (`PGRST…`, for example PGRST204 when a column is missing from the schema) or with an unreadable body, rate limiting, server errors, and no network. A configuration mistake therefore delays data but never deletes it. Fix the configuration in a new release, and the queues drain.

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

**Pseudonymous, not anonymous.** Every event carries the random participant ID for the computer, and the database host (Supabase) sees the IP address of each upload. The survey tool receives the same participant ID in the survey link, and sees whatever the participant types plus their IP address. The consent form must say all three.

**How files are identified.** Each file is identified by a keyed hash: HMAC-SHA256 over the workspace and relative path, keyed by the participant's secret salt. The hash tells you when the same file comes up again, but cannot be turned back into a name, even by the researchers.

## Events (data dictionary)

Every row in `public.events` has these fields:
- `participant_id` and `session_id`: one session per VS Code window.
- `event`: the event name.
- `ts`: the participant's clock.
- `received_at`: the server's clock.
- `ext_version`.
- `schema_version`: currently 1.
- `props`: JSON with the fields below.

| Event | When | `props` |
|---|---|---|
| `study_enrolled` | Joined | `consent_version`, `platform`, `vscode_version` |
| `study_left` | Left | none |
| `session_start` | VS Code window starts (enrolled) | `workspace_hash`, `workspace_folders`, `layout_mode`, `fullscreen_on_open`, `days_since_enrolled`, `platform`, `vscode_version` |
| `thumbview_shown` | Thumbview becomes visible (a hide and show within 500 ms, as during Zen mode steps, is one visit) | `trigger` (`f4`: the F4 keybinding; `command`: the Command Palette, sidebar button, or a rebound key without the keybinding's argument; `tab`: a tab click or Ctrl+Tab), `cold_start` (the panel was created, not revealed), `file_count` (null while the first scan is still running) |
| `thumbview_episode` | Each visit ends | See below |
| `editor_switch` | A workspace file becomes the active editor | `via` (`thumbview` or `other`); `deliberate` (false when focus merely moved between split editors, or VS Code showed the next tab after a close); `new_tab`, `after_tab_close`, `previous_still_visible` (the signals behind `deliberate`); `file_hash`; `prior_visits`; `since_last_visit_ms`; `since_last_switch_ms`; `thumbview_visible`. Returning to the same file (for example closing Thumbview without choosing) is not recorded. |
| `action` | A named Thumbview action | `action`: for example `reorderFile`, `swapCardItems`, `ignoreFile`, `addIgnorePattern`, `reflow`, `setLayoutMode`, `openToSide`, `renameFile`, `deleteFile`, `close` (a tab closed from a tile) |
| `survey_opened` | A survey link was opened | `which` (`pre` or `post`) |

`thumbview_episode` fields. A visit starts when Thumbview's page is revealed and ends with a jump, a tab switch, or leaving without opening anything:

| Field | Meaning |
|---|---|
| `outcome` | `jump` (opened a file at a line), `switch_tab` (switched to an open tab), or `dismissed` (left without choosing) |
| `method` | `click`, `keyboard` (arrows plus Enter), `view_band` (clicked the band showing the editor's visible range), or `none` |
| `since_reveal_ms` | **Time to target (visible)**: from the page appearing to the choice. Null when the start was not seen (`start_source` = `interaction`). A hide shorter than 500 ms, as during Zen mode steps, does not end the visit; the host ends a visit only once the panel stays hidden (`studyVisitEnd`). |
| `start_source` | What started the clock. `reveal`: the page appeared after F4 (the most precise). `shown`: the host showed the panel with no reveal step, for example after a tab click. `interaction`: neither was seen. |
| `focused_ms` | **Time to target (focused)**: time the page had keyboard focus during the visit. Recommended as the primary time-to-target measure, because it excludes time Thumbview sat open beside the code in tab or split mode. In fullscreen it is close to `since_reveal_ms`. Report both. |
| `first_action_ms` | From the start of the visit to the first deliberate action (typing, a key, a folder click); hovering does not count |
| `search_used`, `search_edits`, `query_length`, `search_toggles` | Whether search was used, how many edits, query length at the choice, Match Case/Whole Word/Regex toggles |
| `search_match_count`, `target_matched_search` | Files matching the query at the choice, and whether the chosen file was one of them |
| `tiles_hovered` | Distinct tiles the pointer passed over |
| `magnifier_uses` | Times Ctrl was pressed over a tile (the magnifier) |
| `folder_drill_ins`, `folder_back_outs`, `keyboard_moves` | Navigation inside the map |
| `target_col`, `target_row`, `grid_cols`, `grid_rows` | The chosen tile's slot in the root grid, and the grid's size (spatial position) |
| `folder_cards_view`, `focused_folder_depth` | Whether folders were shown as cards, and how deep the focused folder was |
| `view_kind` | Where the target was chosen: `root` (the whole grid), `folder` (an opened folder), or `cards` (a view of folder cards). `target_col`/`target_row` are always the root-grid slot, so use this to tell what the participant actually saw. |
| `layout_mode`, `fullscreen` | The conditions of this visit: `spanning_grid` or `uniform_grid`, and whether Thumbview was in its fullscreen (Zen) mode. They can change mid-session, so they are recorded per visit as well as in `session_start`. |
| `file_count` | Files on the map |
| `tab_closed` | The Thumbview tab was closed during the visit (outcome `dismissed`). The page and its counts were destroyed with it, so the host reports the visit: `since_reveal_ms` is the host's visible time, `start_source` is `shown`, and the interaction fields are null. |
| `target_file_hash`, `target_prior_visits`, `target_since_last_visit_ms` | Which file (pseudonym), how often it had been opened before in any way, and how long ago |
| `target_moved_since_last_visit` | Whether the chosen file's root-grid slot (`target_col`, `target_row`) differs from the last time it was chosen in Thumbview: `true`, `false`, or null on its first Thumbview visit (or when the slot is unknown). The last slot per file is kept only on the participant's computer, keyed by the path hash. The covariate for spatial-memory claims: learning should show on files that did not move. |
| `reveal_latency_ms` | **Time to open**: from pressing F4 (or running the Open command) to the page appearing. Only for `start_source` = `reveal` visits opened by F4 or the command; null for tab clicks and implausible values (over 60 s). Host and page clocks are the same machine's wall clock. |

## Limitations to report in the paper

- **Speed against other ways of opening files.** VS Code does not tell extensions how a file was opened, so `via = other` lumps together Quick Open, the Explorer, the Search view, Go to Definition, and tab clicks.
  - Only Thumbview visits have a start time, so time to target exists only for Thumbview. `since_last_switch_ms` is the time between file switches (reading plus navigating), not a time to target, so do not compare it with `since_reveal_ms`.
  - The data supports: the share of deliberate navigation that goes through Thumbview and how it changes (`navigation_share_weekly`), and within-participant improvement in Thumbview (`time_to_target_weekly`, `search_vs_spatial_weekly`, `time_by_prior_visits`).
  - "Faster than other ways" needs the before/after surveys, or a controlled task.
- **Deliberate switches are inferred** from tab and visibility signals (`deliberate`), which is a heuristic. Go Back/Forward and Go to Definition within an already open file still count as deliberate opens.
- **Attribution window.** A file opened from Thumbview is attributed to it when the editor switches to that file within 10 seconds. Only the first such switch counts.
- **Visit counts start at joining.** `prior_visits` starts at zero, so early weeks undercount familiarity with files the participant knew before. The pre-study survey can ask about project familiarity.
  - Visit history is per computer, merged across windows. Each window saves its new visits about 5 seconds after they happen, so a file opened in one window and then within those seconds in another may miss one prior visit.
  - Visit history belongs to a VS Code profile (`globalState`), so a second profile on the same computer counts visits separately even though the participant ID is shared.
  - Files are hashed per workspace, so opening the same repository through a different folder path or a `.code-workspace` file counts as a different workspace.
- **Idle visits.** In tab or split mode, Thumbview can stay visible for a long time. Use `focused_ms`, or exclude long dismissed visits.
- **Session clock.** `ts` comes from the participant's clock and is the time the event happened (for `editor_switch`, the switch itself, although it is sent 500 ms later). `received_at` is the server's clock.
- **Selection bias.** Only people with VS Code usage telemetry on who accept the invitation take part.

## Contact & Feedback

- Issue tracker & study documentation: [github.com/jjoseph357/thumbview-issues](https://github.com/jjoseph357/thumbview-issues)
- Report an issue or feedback: [github.com/jjoseph357/thumbview-issues/issues](https://github.com/jjoseph357/thumbview-issues/issues)
- Informed consent form: [consent.html](https://jjoseph357.github.io/thumbview-issues/consent.html)

