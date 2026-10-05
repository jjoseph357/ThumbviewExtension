-- Thumbview usage study: database schema for Supabase (Postgres). Run once in the SQL editor.
-- The extension ships the project's anon key, so anyone can reach this API as the "anon" role.
-- That role may only INSERT into events (row-level security, no select/update/delete policy):
-- the key in the extension can never read, change, or delete data. Analyze with the SQL editor
-- or the service-role key, which must never be shipped. See STUDY.md.

create table if not exists public.events (
    id              bigint generated always as identity primary key,
    received_at     timestamptz not null default now(),
    -- Unique per event, so an event sent twice (two windows, a retry) is stored once: the repeat is
    -- rejected (409) and the extension drops it. Not insert-or-ignore: ON CONFLICT under row-level
    -- security needs a select policy, which would let the public key read data.
    event_id        uuid        not null unique,
    participant_id  uuid        not null,
    session_id      uuid        not null,
    event           text        not null check (event in (
                        'study_enrolled', 'study_left', 'session_start', 'thumbview_shown',
                        'thumbview_episode', 'editor_switch', 'action', 'survey_opened')),
    ts              timestamptz not null,
    ext_version     text        not null check (length(ext_version) <= 32),
    schema_version  integer     not null check (schema_version between 1 and 100),
    -- Bounded so a leaked key cannot fill the database with large rows.
    props           jsonb       not null default '{}'::jsonb check (pg_column_size(props) <= 4096)
);

create index if not exists events_participant_ts on public.events (participant_id, ts);
create index if not exists events_event_ts on public.events (event, ts);

alter table public.events enable row level security;

drop policy if exists "extension may insert events" on public.events;
create policy "extension may insert events" on public.events
    for insert to anon
    with check (true);

revoke all on public.events from anon, authenticated;
grant insert on public.events to anon;

-- Data deletion on request (participant ID from "Thumbview: Research Study Info"), as the owner:
--   delete from public.events where participant_id = '<id>';
