-- Thumbview usage study: analysis views, one per research question (STUDY.md). Run after
-- supabase_schema.sql. They live in the "analysis" schema, which Supabase's API does not expose,
-- so the anon key in the extension cannot read them. Export any view to CSV for R or Python.

create schema if not exists analysis;
revoke all on schema analysis from anon, authenticated;

-- Participants with a consent record (events without one are ignored everywhere below, which also
-- filters junk anyone could insert with the public key).
create or replace view analysis.participants as
select participant_id,
       min(ts) filter (where event = 'study_enrolled') as enrolled_at,
       max(ts) filter (where event = 'study_left')     as left_at,
       max(ts)                                         as last_seen_at
from public.events
group by participant_id
having count(*) filter (where event = 'study_enrolled') > 0;

-- Every event with the participant's study day (0 = enrollment day) and week.
create or replace view analysis.events_by_day as
select e.*,
       floor(extract(epoch from (e.ts - p.enrolled_at)) / 86400)::int     as study_day,
       floor(extract(epoch from (e.ts - p.enrolled_at)) / (7 * 86400))::int as study_week
from public.events e
join analysis.participants p using (participant_id)
where e.ts >= p.enrolled_at;

-- One row per Thumbview visit with typed columns.
create or replace view analysis.episodes as
select participant_id, session_id, ts, study_day, study_week,
       props->>'outcome'                                  as outcome,
       props->>'method'                                   as method,
       (props->>'since_reveal_ms')::numeric               as since_reveal_ms,
       (props->>'focused_ms')::numeric                    as focused_ms,
       props->>'start_source'                             as start_source,
       (props->>'first_action_ms')::numeric               as first_action_ms,
       (props->>'search_used')::boolean                   as search_used,
       (props->>'search_edits')::int                      as search_edits,
       (props->>'search_toggles')::int                    as search_toggles,
       (props->>'query_length')::int                      as query_length,
       (props->>'search_match_count')::int                as search_match_count,
       (props->>'target_matched_search')::boolean         as target_matched_search,
       (props->>'tiles_hovered')::int                     as tiles_hovered,
       (props->>'magnifier_uses')::int                    as magnifier_uses,
       (props->>'folder_drill_ins')::int                  as folder_drill_ins,
       (props->>'folder_back_outs')::int                  as folder_back_outs,
       (props->>'keyboard_moves')::int                    as keyboard_moves,
       (props->>'target_col')::int                        as target_col,
       (props->>'target_row')::int                        as target_row,
       (props->>'grid_cols')::int                         as grid_cols,
       (props->>'grid_rows')::int                         as grid_rows,
       (props->>'folder_cards_view')::boolean             as folder_cards_view,
       props->>'view_kind'                                as view_kind,
       props->>'layout_mode'                              as layout_mode,
       (props->>'fullscreen')::boolean                    as fullscreen,
       (props->>'focused_folder_depth')::int              as focused_folder_depth,
       (props->>'file_count')::int                        as file_count,
       coalesce((props->>'tab_closed')::boolean, false)   as tab_closed,
       props->>'target_file_hash'                         as target_file_hash,
       (props->>'target_prior_visits')::int               as target_prior_visits,
       (props->>'target_since_last_visit_ms')::numeric    as target_since_last_visit_ms,
       (props->>'target_moved_since_last_visit')::boolean as target_moved_since_last_visit,
       (props->>'reveal_latency_ms')::numeric             as reveal_latency_ms
from analysis.events_by_day
where event = 'thumbview_episode';

-- RQ1: how often do participants open Thumbview? Opens per participant per study day.
create or replace view analysis.daily_opens as
select participant_id, study_day, count(*) as opens,
       count(*) filter (where props->>'trigger' = 'f4')      as opens_by_f4,
       count(*) filter (where props->>'trigger' = 'command') as opens_by_command,
       count(*) filter (where props->>'trigger' = 'tab')     as opens_by_tab
from analysis.events_by_day
where event = 'thumbview_shown'
group by participant_id, study_day;

-- RQ2: how fast do they reach the target, and does it improve? Per participant and week. Only visits
-- with a measured start (the page's reveal, or the host showing it); "interaction" starts are excluded.
-- Kept apart: opening a file (jump) and switching to an already open, outlined tab (switch_tab) are
-- different tasks, and the reveal clock (F4) starts later than the shown clock (a tab click).
create or replace view analysis.time_to_target_weekly as
select participant_id, study_week, outcome, start_source, count(*) as visits,
       -- Visible time and focused time; STUDY.md says which the paper reports as primary.
       percentile_cont(0.5) within group (order by since_reveal_ms) as median_time_to_target_ms,
       percentile_cont(0.5) within group (order by focused_ms)      as median_focused_time_to_target_ms,
       percentile_cont(0.5) within group (order by first_action_ms) as median_time_to_first_action_ms
from analysis.episodes
where outcome in ('jump', 'switch_tab') and since_reveal_ms is not null and start_source in ('reveal', 'shown')
group by participant_id, study_week, outcome, start_source;

-- RQ2b: spatial memory needs the target to stay put. Time to target by whether the chosen file sat in
-- the same root-grid slot as at its previous Thumbview visit (first visits excluded).
create or replace view analysis.time_to_target_by_stability as
select participant_id, study_week, target_moved_since_last_visit as moved, count(*) as jumps,
       avg(case when search_used then 0 else 1 end)                   as share_direct,
       percentile_cont(0.5) within group (order by since_reveal_ms) as median_time_to_target_ms,
       percentile_cont(0.5) within group (order by focused_ms)      as median_focused_time_to_target_ms
from analysis.episodes
where outcome = 'jump' and target_moved_since_last_visit is not null and since_reveal_ms is not null
  and start_source in ('reveal', 'shown')
group by participant_id, study_week, target_moved_since_last_visit;

-- Perceived speed: from pressing F4 (or the Open command) to the page appearing, per week.
create or replace view analysis.reveal_latency_weekly as
select participant_id, study_week, count(*) as opens,
       percentile_cont(0.5) within group (order by reveal_latency_ms) as median_reveal_latency_ms,
       percentile_cont(0.9) within group (order by reveal_latency_ms) as p90_reveal_latency_ms
from analysis.episodes
where reveal_latency_ms is not null
group by participant_id, study_week;

-- RQ3: search versus spatial memory over time. A "direct" navigation reaches the target without
-- searching; its share rising over the weeks is evidence that spatial memory takes over.
create or replace view analysis.search_vs_spatial_weekly as
select participant_id, study_week, count(*) as jumps,
       avg(case when search_used then 0 else 1 end)                        as share_direct,
       avg(tiles_hovered)                                                  as mean_tiles_hovered,
       avg(magnifier_uses)                                                 as mean_magnifier_uses,
       percentile_cont(0.5) within group (order by since_reveal_ms)
           filter (where not search_used)                                  as median_direct_ms,
       percentile_cont(0.5) within group (order by since_reveal_ms)
           filter (where search_used)                                      as median_search_ms
from analysis.episodes
where outcome in ('jump', 'switch_tab')
group by participant_id, study_week;

-- RQ3b: spatial memory per file: time to reach the same file by how often it was visited before.
create or replace view analysis.time_by_prior_visits as
select participant_id,
       least(target_prior_visits, 20)                                    as prior_visits_capped,
       count(*)                                                          as jumps,
       avg(case when search_used then 0 else 1 end)                      as share_direct,
       percentile_cont(0.5) within group (order by since_reveal_ms)      as median_time_to_target_ms,
       percentile_cont(0.5) within group (order by focused_ms)           as median_focused_time_to_target_ms
from analysis.episodes
where outcome in ('jump', 'switch_tab') and target_prior_visits is not null and since_reveal_ms is not null
  and start_source in ('reveal', 'shown')
group by participant_id, least(target_prior_visits, 20);

-- RQ4: how much of their navigation goes through Thumbview, compared with every other way of opening
-- files (Quick Open, Explorer, search, Go to Definition; VS Code does not say which). Only deliberate
-- switches count (not focus moving between splits, nor the tab VS Code shows after a close). This is
-- a share and a frequency, not a speed comparison: only Thumbview visits have a start time, so
-- "faster than other ways" comes from within-participant trends (RQ2, RQ3) and the surveys.
create or replace view analysis.navigation_share_weekly as
select participant_id, study_week,
       count(*)                                                        as deliberate_switches,
       count(*) filter (where props->>'via' = 'thumbview')             as via_thumbview,
       avg(case when props->>'via' = 'thumbview' then 1 else 0 end)    as share_via_thumbview,
       -- Revisits (a file opened before) are where spatial memory can help.
       avg(case when props->>'via' = 'thumbview' then 1 else 0 end)
           filter (where (props->>'prior_visits')::int > 0)            as share_via_thumbview_on_revisits
from analysis.events_by_day
where event = 'editor_switch' and coalesce((props->>'deliberate')::boolean, true)
group by participant_id, study_week;

-- RQ5: do participants stop using Thumbview? Active days, last use, and days since last use.
create or replace view analysis.retention as
select p.participant_id, p.enrolled_at, p.left_at,
       count(distinct d.study_day) filter (where d.event = 'thumbview_shown')      as days_used,
       max(d.ts) filter (where d.event = 'thumbview_shown')                        as last_used_at,
       max(d.study_day) filter (where d.event = 'thumbview_shown')                 as last_used_study_day,
       max(d.study_day) filter (where d.event = 'session_start')                   as last_vscode_study_day,
       -- Still opening VS Code but no longer Thumbview: the abandonment signal.
       coalesce(max(d.study_day) filter (where d.event = 'session_start'), 0)
         - coalesce(max(d.study_day) filter (where d.event = 'thumbview_shown'), 0) as days_since_last_use
from analysis.participants p
left join analysis.events_by_day d using (participant_id)
group by p.participant_id, p.enrolled_at, p.left_at;

-- Customization: how often participants rearrange the map or hide files, by week.
create or replace view analysis.actions_weekly as
select participant_id, study_week, props->>'action' as action, count(*) as times
from analysis.events_by_day
where event = 'action'
group by participant_id, study_week, props->>'action';
