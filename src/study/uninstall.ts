// Run by VS Code once Thumbview is fully uninstalled (package.json "vscode:uninstall", bundled to
// dist/uninstall.js). Uninstalling counts as leaving the study: participation ends on this computer,
// and a best-effort study_left is sent (only if usage telemetry was on and consent current) so the
// data shows why the participant went quiet. Plain Node: the vscode API is not available here. Never throws; VS Code ignores the exit code anyway.
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { endParticipation, mayNotifyUninstall, readParticipantFile, writeParticipantFile } from "./participant_file";
import { isStudyConfigured, STUDY_CONFIG, STUDY_SCHEMA_VERSION } from "./study_config";
import { StudyClient } from "./study_client";

function extensionVersion(): string {
    try {
        return String(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version ?? "");
    } catch {
        return "";
    }
}

async function main(): Promise<void> {
    const contents = readParticipantFile();
    const ended = endParticipation(contents, "uninstall");
    if (!ended || !contents.participant) {
        return;
    }
    writeParticipantFile(ended);
    // The same conditions as any other event: consent to the current form and usage telemetry on.
    if (!isStudyConfigured() || !mayNotifyUninstall(contents, STUDY_CONFIG.consentVersion)) {
        return;
    }
    const client = new StudyClient(
        { url: (STUDY_CONFIG as any).ingestUrl || (STUDY_CONFIG as any).supabaseUrl, key: (STUDY_CONFIG as any).ingestKey || (STUDY_CONFIG as any).supabaseAnonKey },
        { load: () => [], save: () => { } },
        (url, init) => fetch(url, init)
    );
    await client.sendNow({
        event_id: randomUUID(),
        participant_id: contents.participant.id,
        session_id: randomUUID(),
        event: "study_left",
        ts: new Date().toISOString(),
        ext_version: extensionVersion().slice(0, 32),
        schema_version: STUDY_SCHEMA_VERSION,
        props: { reason: "uninstall" }
    });
}

main().catch(() => { }).finally(() => process.exit(0));
