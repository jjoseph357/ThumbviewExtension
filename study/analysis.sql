-- Thumbview usage study: analysis views, one per research question (STUDY.md).
-- Run after schema.sql. They live in the "analysis" schema for clean reporting.
-- Export any view to CSV for R or Python.

create schema if not exists analysis;

-- Participants summary view
create or replace view analysis.participants as
select p.participant_id,
       p.enrolled_at,
       p.left_at,
       coalesce(max(e.ts), p.enrolled_at) as last_seen_at
from participants p
left join episodes e using (participant_id)
group by p.participant_id, p.enrolled_at, p.left_at;

-- One row per Thumbview visit with study day, week, and typed columns.
create or replace view analysis.episodes as
select e.*,
       floor(extract(epoch from (e.ts - p.enrolled_at)) / 86400)::int as study_day,
       floor(extract(epoch from (e.ts - p.enrolled_at)) / (7 * 86400))::int as study_week
from episodes e
join participants p using (participant_id)
where e.ts >= p.enrolled_at;

-- RQ1: how often do participants open Thumbview? Opens per participant per study day.
create or replace view analysis.daily_opens as
select o.participant_id,
       floor(extract(epoch from (o.ts - p.enrolled_at)) / 86400)::int as study_day,
       count(*) as opens,
       count(*) filter (where o.trigger = 'f4')      as opens_by_f4,
       count(*) filter (where o.trigger = 'command') as opens_by_command,
       count(*) filter (where o.trigger = 'tab')     as opens_by_tab
from opens o
join participants p using (participant_id)
where o.ts >= p.enrolled_at
group by o.participant_id, floor(extract(epoch from (o.ts - p.enrolled_at)) / 86400)::int;

-- RQ2: how fast do they reach the target, and does it improve? Per participant and week.
create or replace view analysis.time_to_target_weekly as
select participant_id, study_week, outcome, start_source, count(*) as visits,
       percentile_cont(0.5) within group (order by time_to_target_ms) as median_time_to_target_ms,
       percentile_cont(0.5) within group (order by focused_duration_ms) as median_focused_time_to_target_ms,
       percentile_cont(0.5) within group (order by reaction_time_ms) as median_reaction_time_ms
from analysis.episodes
where outcome in ('jump', 'switch_tab') and time_to_target_ms is not null and start_source in ('reveal', 'shown')
group by participant_id, study_week, outcome, start_source;

-- RQ2b: spatial memory needs the target to stay put. Time to target by whether the chosen file sat in
-- the same root-grid slot as at its previous Thumbview visit (first visits excluded).
create or replace view analysis.time_to_target_by_stability as
select participant_id, study_week, target_position_changed as moved, count(*) as jumps,
       avg(case when search_used then 0 else 1 end) as share_direct,
       percentile_cont(0.5) within group (order by time_to_target_ms) as median_time_to_target_ms,
       percentile_cont(0.5) within group (order by focused_duration_ms) as median_focused_time_to_target_ms
from analysis.episodes
where outcome = 'jump' and target_position_changed is not null and time_to_target_ms is not null
  and start_source in ('reveal', 'shown')
group by participant_id, study_week, target_position_changed;

-- Perceived speed: from pressing F4 (or the Open command) to the page appearing, per week.
create or replace view analysis.reveal_latency_weekly as
select participant_id, study_week, count(*) as opens,
       percentile_cont(0.5) within group (order by reveal_latency_ms) as median_reveal_latency_ms,
       percentile_cont(0.9) within group (order by reveal_latency_ms) as p90_reveal_latency_ms
from analysis.episodes
where reveal_latency_ms is not null
group by participant_id, study_week;

-- RQ3: search versus spatial memory over time.
create or replace view analysis.search_vs_spatial_weekly as
select participant_id, study_week, count(*) as jumps,
       avg(case when search_used then 0 else 1 end) as share_direct,
       avg(tiles_hovered)                           as mean_tiles_hovered,
       avg(magnifier_uses)                          as mean_magnifier_uses,
       percentile_cont(0.5) within group (order by time_to_target_ms)
           filter (where not search_used)           as median_direct_ms,
       percentile_cont(0.5) within group (order by time_to_target_ms)
           filter (where search_used)               as median_search_ms
from analysis.episodes
where outcome in ('jump', 'switch_tab')
group by participant_id, study_week;

-- RQ3b: spatial memory per file: time to reach the same file by how often it was visited before.
create or replace view analysis.time_by_prior_visits as
select participant_id,
       least(target_prior_visits, 20)                               as prior_visits_capped,
       count(*)                                                     as jumps,
       avg(case when search_used then 0 else 1 end)                 as share_direct,
       percentile_cont(0.5) within group (order by time_to_target_ms) as median_time_to_target_ms,
       percentile_cont(0.5) within group (order by focused_duration_ms) as median_focused_time_to_target_ms
from analysis.episodes
where outcome in ('jump', 'switch_tab') and target_prior_visits is not null and time_to_target_ms is not null
  and start_source in ('reveal', 'shown')
group by participant_id, least(target_prior_visits, 20);

-- RQ4: deliberate navigation share through Thumbview vs other methods.
create or replace view analysis.navigation_share_weekly as
select s.participant_id,
       floor(extract(epoch from (s.ts - p.enrolled_at)) / (7 * 86400))::int as study_week,
       count(*)                                                             as deliberate_switches,
       count(*) filter (where s.navigation_source = 'thumbview')            as via_thumbview,
       avg(case when s.navigation_source = 'thumbview' then 1 else 0 end)   as share_via_thumbview,
       avg(case when s.navigation_source = 'thumbview' then 1 else 0 end)
           filter (where s.prior_visits > 0)                                as share_via_thumbview_on_revisits
from editor_switches s
join participants p using (participant_id)
where s.is_deliberate and s.ts >= p.enrolled_at
group by s.participant_id, floor(extract(epoch from (s.ts - p.enrolled_at)) / (7 * 86400))::int;

-- RQ5: retention and usage abandonment signal.
create or replace view analysis.retention as
select p.participant_id, p.enrolled_at, p.left_at,
       count(distinct floor(extract(epoch from (o.ts - p.enrolled_at)) / 86400)::int) as days_used,
       max(o.ts)                                                                     as last_used_at,
       max(floor(extract(epoch from (o.ts - p.enrolled_at)) / 86400)::int)           as last_used_study_day,
       max(s.days_since_enrolled)                                                    as last_vscode_study_day,
       coalesce(max(s.days_since_enrolled), 0)
         - coalesce(max(floor(extract(epoch from (o.ts - p.enrolled_at)) / 86400)::int), 0) as days_since_last_use
from participants p
left join opens o using (participant_id)
left join sessions s using (participant_id)
group by p.participant_id, p.enrolled_at, p.left_at;

-- Customization actions weekly
create or replace view analysis.actions_weekly as
select a.participant_id,
       floor(extract(epoch from (a.ts - p.enrolled_at)) / (7 * 86400))::int as study_week,
       a.action_name,
       count(*) as times
from actions a
join participants p using (participant_id)
where a.ts >= p.enrolled_at
group by a.participant_id, floor(extract(epoch from (a.ts - p.enrolled_at)) / (7 * 86400))::int, a.action_name;
