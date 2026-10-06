// Settings for the opt-in usage study (see STUDY.md). While the ingestion URL or consent form
// is empty the study is dormant: its commands are hidden and nothing is ever sent.

export const STUDY_CONFIG = {
    /** Ingestion server endpoint on precision.usask.ca (University of Saskatchewan, Canada). */
    ingestUrl: "https://precision.usask.ca/study/api",
    /** Optional secret / API key for the ingest endpoint. */
    ingestKey: "",
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
export const STUDY_SCHEMA_VERSION = 2;

export function isStudyConfigured(config: any = STUDY_CONFIG): boolean {
    if (!config || !config.consentUrl) {
        return false;
    }
    if (config.supabaseUrl === "" && config.ingestUrl === STUDY_CONFIG.ingestUrl) {
        return false;
    }
    const url = config.ingestUrl || config.supabaseUrl;
    return !!url;
}
