// The study participant for this computer, kept in the user's home folder so every VS Code window
// and profile shares one ID (the study's unit is the computer). Plain Node, no vscode API: the
// uninstall script (uninstall.ts) uses it too. Returns parsed contents and pure transforms.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface Participant {
    id: string;
    /** HMAC key for path hashes; never leaves this computer. */
    salt: string;
    enrolledAt: number;
    consentVersion: number;
}

export interface ParticipantFile {
    participant?: Participant;
    /** Shown after leaving, for data deletion requests. */
    formerParticipantId?: string;
    /** How participation ended: the Leave command, or uninstalling Thumbview. */
    endedBy?: "leave" | "uninstall";
    /**
     * VS Code usage telemetry as last seen by a running Thumbview. The uninstall script cannot read
     * the telemetry level, so it sends study_left only when this was true.
     */
    usageTelemetryEnabled?: boolean;
}

/** With VS Code Remote the extension runs on the remote host, which then has its own ID. */
export const PARTICIPANT_FILE = path.join(os.homedir(), ".thumbview", "study.json");

export function readParticipantFile(file: string = PARTICIPANT_FILE): ParticipantFile {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8")) as ParticipantFile;
    } catch {
        return {};
    }
}

export function writeParticipantFile(contents: ParticipantFile, file: string = PARTICIPANT_FILE): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(contents, null, 2), { mode: 0o600 });
}

/**
 * Ends participation: the participant becomes a former one (its ID kept only for deletion requests),
 * so nothing more is sent and joining again creates a new ID. Null when nobody is enrolled.
 */
export function endParticipation(contents: ParticipantFile, endedBy: "leave" | "uninstall"): ParticipantFile | null {
    if (!contents.participant) {
        return null;
    }
    return { formerParticipantId: contents.participant.id, endedBy };
}

/**
 * Whether the uninstall script may send study_left: someone is enrolled, under the current consent
 * form, and usage telemetry was on when Thumbview last ran. A file from before the telemetry state was
 * recorded counts as off.
 */
export function mayNotifyUninstall(contents: ParticipantFile, consentVersion: number): boolean {
    return !!contents.participant && contents.participant.consentVersion === consentVersion && contents.usageTelemetryEnabled === true;
}
