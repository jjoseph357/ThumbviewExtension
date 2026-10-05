// Settings for the opt-in usage study (see STUDY.md). While the Supabase URL, key, or consent form
// is empty the study is dormant: its commands are hidden and nothing is ever sent.

export const STUDY_CONFIG = {
    /** Supabase project URL, e.g. "https://abcd1234.supabase.co". */
    supabaseUrl: "https://owuxnaaeizzydjtwjdij.supabase.co",
    /**
     * The project's anon (public) key. It ships inside the extension, so the database must allow
     * this role to insert into `events` and nothing else (study/supabase_schema.sql).
     */
    supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93dXhuYWFlaXp6eWRqdHdqZGlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA4NzczNDYsImV4cCI6MjEwNjQ1MzM0Nn0.z9x8sQt1H_yGnUSTZr7Zs5PXyKml6VpxR80cWp7rdOc",
    /** Informed-consent document shown before joining. */
    consentUrl: "https://jjoseph357.github.io/thumbview-issues/consent.html",
    /** Surveys; "{pid}" is replaced by the participant ID so answers link to usage data. */
    preSurveyUrl: "",
    postSurveyUrl: "",
    /** Days after joining when the post-study survey is offered (once). */
    postSurveyAfterDays: 14,
    /** Bump when the consent text changes; participants who agreed to an older version are asked again. */
    consentVersion: 1,
    /** The study invitation is offered once, after Thumbview has been opened this many times. */
    inviteAfterOpens: 1
};

/** Event format version, stored with every event so analyses can handle schema changes. */
export const STUDY_SCHEMA_VERSION = 1;

export function isStudyConfigured(config: typeof STUDY_CONFIG = STUDY_CONFIG): boolean {
    return !!(config.supabaseUrl && config.supabaseAnonKey && config.consentUrl);
}
