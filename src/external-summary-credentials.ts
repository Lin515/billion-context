import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { configFile } from "./paths.js";
import { validSummaryCredentialName } from "./external-summary-settings.js";

function validKey(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 8192 && !/[\x00-\x20\x7f]/.test(value);
}

/** Separate from configFile(): normal config GET/raw exports never read these bytes. */
export class SummaryCredentialStore {
    constructor(private readonly path: string = `${configFile()}.summary-credentials.json`) {}

    private read(): Record<string, string> {
        if (!existsSync(this.path)) return Object.create(null) as Record<string, string>;
        try {
            const stat = lstatSync(this.path);
            if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error();
            if (stat.size > 256 * 1024) throw new Error();
            const data: unknown = JSON.parse(readFileSync(this.path, "utf8"));
            if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
            const result = Object.create(null) as Record<string, string>;
            for (const [name, key] of Object.entries(data)) {
                if (!validSummaryCredentialName(name) || !validKey(key)) throw new Error();
                result[name] = key;
            }
            return result;
        } catch { throw new Error("External summary credentials unavailable; repair the private store permissions or contents"); }
    }

    resolve(reference: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
        let value: unknown;
        if (/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) value = env[reference.slice(4)];
        else if (reference.startsWith("secret:") && validSummaryCredentialName(reference.slice(7))) value = this.read()[reference.slice(7)];
        else throw new Error("Invalid external summary credential reference");
        if (value === undefined) return undefined;
        if (!validKey(value)) throw new Error("Invalid external summary credential");
        return value;
    }

    configured(reference: string, env: NodeJS.ProcessEnv = process.env): boolean {
        try { return this.resolve(reference, env) !== undefined; } catch { return false; }
    }

    set(name: string, key: string | null): void {
        if (!validSummaryCredentialName(name) || (key !== null && !validKey(key))) throw new Error("Invalid external summary credential");
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        // Multiple proxy instances may share the same config directory.
        let lock: number;
        try { lock = openSync(`${this.path}.lock`, "wx", 0o600); }
        catch { throw new Error("External summary credential store is locked or unavailable"); }
        const temp = `${this.path}.${randomUUID()}.tmp`;
        let descriptor: number | undefined;
        try {
            const values = this.read();
            if (key === null) delete values[name];
            else values[name] = key;
            if (Object.keys(values).length > 16) throw new Error("External summary credential store is full");
            descriptor = openSync(temp, "wx", 0o600);
            writeFileSync(descriptor, JSON.stringify(values) + "\n", "utf8");
            fsyncSync(descriptor);
            closeSync(descriptor);
            descriptor = undefined;
            renameSync(temp, this.path);
        } finally {
            if (descriptor !== undefined) closeSync(descriptor);
            try { unlinkSync(temp); } catch { /* rename already consumed the temporary file */ }
            closeSync(lock);
            unlinkSync(`${this.path}.lock`);
        }
    }
}
