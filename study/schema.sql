-- Thumbview usage study: PostgreSQL schema for precision.usask.ca (University of Saskatchewan, Canada).
-- Dedicated relational tables with explicit, typed columns for direct readability at a glance.
-- Run once in PostgreSQL to initialize the study database.

-- Automated migration: If participant_id was previously created as UUID, migrate to TEXT.
do $$
begin
    if exists (
        select 1 from information_schema.columns 
        where table_name = 'participants' and column_name = 'participant_id' and data_type = 'uuid'
    ) then
        drop schema if exists analysis cascade;

        alter table if exists sessions drop constraint if exists sessions_participant_id_fkey;
        alter table if exists episodes drop constraint if exists episodes_participant_id_fkey;
        alter table if exists editor_switches drop constraint if exists editor_switches_participant_id_fkey;
        alter table if exists opens drop constraint if exists opens_participant_id_fkey;
        alter table if exists actions drop constraint if exists actions_participant_id_fkey;
        alter table if exists surveys drop constraint if exists surveys_participant_id_fkey;

        alter table if exists participants alter column participant_id type text using participant_id::text;
        alter table if exists sessions alter column participant_id type text using participant_id::text;
        alter table if exists episodes alter column participant_id type text using participant_id::text;
        alter table if exists editor_switches alter column participant_id type text using participant_id::text;
        alter table if exists opens alter column participant_id type text using participant_id::text;
        alter table if exists actions alter column participant_id type text using participant_id::text;
        alter table if exists surveys alter column participant_id type text using participant_id::text;
        alter table if exists raw_events alter column participant_id type text using participant_id::text;

        alter table if exists sessions add constraint sessions_participant_id_fkey foreign key (participant_id) references participants(participant_id) on delete cascade;
        alter table if exists episodes add constraint episodes_participant_id_fkey foreign key (participant_id) references participants(participant_id) on delete cascade;
        alter table if exists editor_switches add constraint editor_switches_participant_id_fkey foreign key (participant_id) references participants(participant_id) on delete cascade;
        alter table if exists opens add constraint opens_participant_id_fkey foreign key (participant_id) references participants(participant_id) on delete cascade;
        alter table if exists actions add constraint actions_participant_id_fkey foreign key (participant_id) references participants(participant_id) on delete cascade;
        alter table if exists surveys add constraint surveys_participant_id_fkey foreign key (participant_id) references participants(participant_id) on delete cascade;
    end if;
end $$;

create table if not exists participants (
    participant_id      text        primary key,
    enrolled_at         timestamptz not null default now(),
    left_at             timestamptz,
    consent_version     integer     not null,
    platform            text,
    vscode_version      text,
    ext_version         text,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

-- Sequence for assigning sequential participant IDs (e.g. P-101, P-102).
-- Backwards compatible with any participant ID format (e.g. legacy auto-*, UUIDs, or custom survey IDs).
create sequence if not exists participant_id_seq start with 101;

-- If existing P-xxx participants exist, advance the sequence to prevent collisions while safely ignoring non-numeric IDs.
do $$
declare
    max_val bigint;
    cur_val bigint;
begin
    select coalesce(max((substring(participant_id from '^P-([0-9]+)$'))::bigint), 100)
    into max_val
    from participants
    where participant_id ~ '^P-[0-9]+$';

    select last_value into cur_val from participant_id_seq;

    if max_val >= cur_val then
        perform setval('participant_id_seq', max_val, true);
    end if;
end $$;

create table if not exists sessions (
    session_id          uuid        primary key,
    participant_id      text        not null references participants(participant_id) on delete cascade,
    started_at          timestamptz not null,
    workspace_hash      text,
    workspace_folders   integer,
    layout_mode         text,
    fullscreen_on_open  boolean,
    days_since_enrolled integer,
    platform            text,
    vscode_version      text,
    ext_version         text,
    received_at         timestamptz not null default now()
);

create table if not exists episodes (
    event_id                    uuid        primary key,
    participant_id              text        not null references participants(participant_id) on delete cascade,
    session_id                  uuid        not null,
    ts                          timestamptz not null,
    received_at                 timestamptz not null default now(),
    ext_version                 text,

    -- Outcome & timing metrics
    outcome                     text        not null check (outcome in ('jump', 'switch_tab', 'dismissed')),
    interaction_method          text        not null check (interaction_method in ('click', 'keyboard', 'view_band', 'none')),
    time_to_target_ms           integer,
    focused_duration_ms         integer,
    reaction_time_ms            integer,
    start_source                text        check (start_source in ('reveal', 'shown', 'interaction')),
    reveal_latency_ms           integer,

    -- Target file & spatial grid metrics
    target_file_hash            text,
    slot_col                    integer,
    slot_row                    integer,
    grid_cols                   integer,
    grid_rows                   integer,
    target_position_changed     boolean,
    target_prior_visits         integer,
    target_since_last_visit_ms  numeric,

    -- Search behavior
    search_used                 boolean     not null default false,
    query_length                integer,
    search_edits                integer,
    search_toggles              integer,
    search_match_count          integer,
    target_matched_search       boolean,

    -- Exploration & map interaction counts
    tiles_hovered               integer,
    magnifier_uses              integer,
    folder_drill_ins            integer,
    folder_back_outs            integer,
    keyboard_moves              integer,

    -- Display & layout conditions
    view_kind                   text        check (view_kind in ('root', 'folder', 'cards')),
    folder_cards_view           boolean,
    focused_folder_depth        integer,
    layout_mode                 text,
    fullscreen                  boolean,
    file_count                  integer,
    tab_closed                  boolean     not null default false
);

create table if not exists editor_switches (
    event_id                uuid        primary key,
    participant_id          text        not null references participants(participant_id) on delete cascade,
    session_id              uuid        not null,
    ts                      timestamptz not null,
    received_at             timestamptz not null default now(),
    ext_version             text,

    navigation_source       text        not null check (navigation_source in ('thumbview', 'other')),
    is_deliberate           boolean     not null,
    file_hash               text        not null,
    prior_visits            integer     not null default 0,
    since_last_visit_ms     numeric,
    since_last_switch_ms    numeric,
    thumbview_visible       boolean     not null,
    new_tab                 boolean,
    after_tab_close         boolean,
    previous_still_visible  boolean
);

create table if not exists opens (
    event_id            uuid        primary key,
    participant_id      text        not null references participants(participant_id) on delete cascade,
    session_id          uuid        not null,
    ts                  timestamptz not null,
    received_at         timestamptz not null default now(),
    ext_version         text,

    trigger             text        check (trigger in ('f4', 'command', 'tab')),
    cold_start          boolean,
    file_count          integer
);

create table if not exists actions (
    event_id            uuid        primary key,
    participant_id      text        not null references participants(participant_id) on delete cascade,
    session_id          uuid        not null,
    ts                  timestamptz not null,
    received_at         timestamptz not null default now(),
    ext_version         text,

    action_name         text        not null
);

create table if not exists surveys (
    event_id            uuid        primary key,
    participant_id      text        not null references participants(participant_id) on delete cascade,
    session_id          uuid        not null,
    ts                  timestamptz not null,
    received_at         timestamptz not null default now(),
    ext_version         text,

    survey_type         text        not null check (survey_type in ('pre', 'post'))
);

-- Raw event stream log for audit and backup
create table if not exists raw_events (
    id                  bigint generated always as identity primary key,
    event_id            uuid        unique,
    participant_id      text        not null,
    session_id          uuid        not null,
    event               text        not null,
    ts                  timestamptz not null,
    received_at         timestamptz not null default now(),
    ext_version         text,
    schema_version      integer,
    props               jsonb
);

create index if not exists idx_episodes_participant_ts on episodes (participant_id, ts);
create index if not exists idx_episodes_outcome on episodes (outcome, ts);
create index if not exists idx_editor_switches_participant on editor_switches (participant_id, ts);
create index if not exists idx_opens_participant_ts on opens (participant_id, ts);
create index if not exists idx_sessions_participant on sessions (participant_id);
