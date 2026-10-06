-- Thumbview usage study: PostgreSQL schema for precision.usask.ca (University of Saskatchewan, Canada).
-- Dedicated relational tables with explicit, typed columns for direct readability at a glance.
-- Run once in PostgreSQL to initialize the study database.

create table if not exists participants (
    participant_id      uuid        primary key,
    enrolled_at         timestamptz not null default now(),
    left_at             timestamptz,
    consent_version     integer     not null,
    platform            text,
    vscode_version      text,
    ext_version         text,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create table if not exists sessions (
    session_id          uuid        primary key,
    participant_id      uuid        not null references participants(participant_id) on delete cascade,
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
    participant_id              uuid        not null references participants(participant_id) on delete cascade,
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
    participant_id          uuid        not null references participants(participant_id) on delete cascade,
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
    participant_id      uuid        not null references participants(participant_id) on delete cascade,
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
    participant_id      uuid        not null references participants(participant_id) on delete cascade,
    session_id          uuid        not null,
    ts                  timestamptz not null,
    received_at         timestamptz not null default now(),
    ext_version         text,

    action_name         text        not null
);

create table if not exists surveys (
    event_id            uuid        primary key,
    participant_id      uuid        not null references participants(participant_id) on delete cascade,
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
    participant_id      uuid        not null,
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
