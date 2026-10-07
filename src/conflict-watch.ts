// #1206: per-session compression-conflict ledger. Every piece of evidence that
// another compressor (third-party plugin, client native compaction) touched
// this conversation lands here so the user can SEE it (acp_status / web UI /
// stats) instead of finding out later from scrambled context. Bounded ring —
// the ledger is diagnostic, not history.
// #2102: lifecycle — the display layer must treat it as diagnostic: events are
// split ACTIVE (within CONFLICT_ACTIVE_WINDOW_MS) vs historical so a months-old
// stock ledger no longer reads as a live alarm, and the whole ledger can be
// wiped via clearConflictEvents (POST /__bili/conflicts/clear). Wiping loses
// no conversation data — only the evidence notes.

import { markDirty, type Session } from "./session.js";
import { isSiblingConflictDetail } from "./thirdparty-scan.js";

type ConflictKind = "third-party-plugin" | "unannounced-rewrite" | "orphan-reap" | "native-compaction";

export interface ConflictEvent {
    at: number;
    kind: ConflictKind;
    detail: string;
}

export const CONFLICT_LEDGER_MAX = 20;

/** #2102: events newer than this count as ACTIVE (live double-compression
 *  risk); older ones are historical stock. Internal constant — deliberately
 *  NOT a config knob (config surface is owner-gated). The 7-day yardstick
 *  matches BILI_SESSION_GC_MAX_AGE_DAYS so "stale" means the same thing
 *  everywhere in bili. */
export const CONFLICT_ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function splitConflictEvents(events: ConflictEvent[], now: number = Date.now()): { active: ConflictEvent[]; historical: ConflictEvent[] } {
    const active: ConflictEvent[] = [];
    const historical: ConflictEvent[] = [];
    for (const e of events) (now - e.at <= CONFLICT_ACTIVE_WINDOW_MS ? active : historical).push(e);
    return { active, historical };
}

export function conflictEventsOf(session: Session): ConflictEvent[] {
    const raw = session.metadata.conflictEvents;
    if (!Array.isArray(raw)) return [];
    return raw.filter((e): e is ConflictEvent =>
        !!e && typeof e === "object" &&
        typeof (e as ConflictEvent).at === "number" &&
        typeof (e as ConflictEvent).kind === "string" &&
        typeof (e as ConflictEvent).detail === "string",
    );
}

export function recordConflict(session: Session, kind: ConflictKind, detail: string): void {
    const events = conflictEventsOf(session);
    events.push({ at: Date.now(), kind, detail });
    while (events.length > CONFLICT_LEDGER_MAX) events.shift();
    session.metadata.conflictEvents = events;
    markDirty(session);
}

function fmtTime(at: number): string {
    return new Date(at).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function isSuspectedEvent(e: ConflictEvent): boolean {
    return e.kind === "third-party-plugin" && e.detail.endsWith("[suspected]");
}

export function formatConflictSection(events: ConflictEvent[], now: number = Date.now()): string[] {
    const lines: string[] = [];
    // #2102: label the age split up front — an all-historical section must not
    // read as a live alarm (it previously said "two compressors ..." imperatively
    // even when every event was months old).
    const { active, historical } = splitConflictEvents(events, now);
    lines.push(`COMPRESSION CONFLICTS — ${events.length} event(s) in this session (${active.length} active · ${historical.length} historical; active = within ${CONFLICT_ACTIVE_WINDOW_MS / 86_400_000} days). Two compressors on one conversation (bili + another compression plugin — third-party or bili's own sibling — or client native compaction) double-compress and corrupt message refs:`);
    for (const e of events.slice(-10)) {
        lines.push(`  [${fmtTime(e.at)}] ${e.kind} — ${e.detail}`);
    }
    if (events.length > 10) lines.push(`  … ${events.length - 10} earlier event(s); full list: GET /__bili/stats → conflicts`);
    // #1736: the [suspected] tier is a name-only guess, not observed evidence —
    // say so, and don't command removal when nothing confirmed was found.
    const suspectedCount = events.filter(isSuspectedEvent).length;
    if (suspectedCount > 0) {
        lines.push("  [suspected] = name-only keyword match — verify the plugin actually compresses before acting; a context dashboard/viewer/tool is NOT a compressor.");
    }
    const allSuspected = suspectedCount > 0 && suspectedCount === events.length;
    // #2261: a ledger naming ONLY bili's own siblings (billion-context-pi /
    // opencode-acp) is not a foreign-compressor alarm — they stand down while
    // bili drives the session (#820/#920), so never command removal for them.
    const siblingEvents = events.filter((e) => e.kind === "third-party-plugin" && isSiblingConflictDetail(e.detail));
    const siblingsOnly = siblingEvents.length > 0 && siblingEvents.length === events.length;
    lines.push(siblingsOnly
        ? "Every event above names bili's OWN sibling extension (billion-context-pi / opencode-acp), not a third-party compressor: while bili drives the session it stands down automatically (BILLION_CONTEXT_NATIVE marker in native mode, /bili/ baseUrl self-check otherwise), so no second compressor is active. Verify your bili/sibling versions are recent, then clear this ledger — Web UI conflict banner / session page, or POST /__bili/conflicts/clear."
        : active.length === 0
            ? "All events above are older than 7 days (historical stock): the double-compression risk may no longer be live. Verify the other compression plugin is removed or blocked by bili, then clear this ledger — Web UI conflict banner / session page, or POST /__bili/conflicts/clear?session=<id>."
            : allSuspected
                ? "Every event above is [suspected]: confirm each named plugin really compresses before removing anything — do not drop a read-only tool on the strength of its name."
                : "Keep exactly ONE compressor per conversation: remove/disable the other plugin (or its native auto-compaction), then start a fresh session.");
    return lines;
}

interface ConflictSummary {
    sessions: number;
    events: number;
    /** #2102: events within CONFLICT_ACTIVE_WINDOW_MS of `now` (live risk). */
    active: number;
    /** #2102: events older than the window (historical stock). */
    historical: number;
    /** #2102: timestamp of the newest event across all sessions, or null. */
    lastAt: number | null;
    kinds: Partial<Record<ConflictKind, number>>;
    /** #2261: plugin-kind events naming bili's OWN siblings (billion-context-pi /
     *  opencode-acp) — display-time classification of recorded details, additive
     *  to `kinds`, so surfaces can stop calling first-party siblings "third-party". */
    sibling: number;
    /** #2324: name-only [suspected] plugin events — a subset of kinds["third-party-plugin"],
     *  additive, so display surfaces can stop treating unverified name matches as
     *  confirmed compressors. Disjoint from `sibling` (siblings are never suspected). */
    suspected: number;
    latest: Array<{ sessionId: string; at: number; kind: ConflictKind; detail: string }>;
}

export function summarizeConflicts(sessions: Session[], now: number = Date.now()): ConflictSummary {
    const summary: ConflictSummary = { sessions: 0, events: 0, active: 0, historical: 0, lastAt: null, kinds: {}, latest: [], sibling: 0, suspected: 0 };
    for (const s of sessions) {
        const events = conflictEventsOf(s);
        if (events.length === 0) continue;
        summary.sessions += 1;
        summary.events += events.length;
        for (const e of events) {
            summary.kinds[e.kind] = (summary.kinds[e.kind] ?? 0) + 1;
            if (e.kind === "third-party-plugin" && isSiblingConflictDetail(e.detail)) summary.sibling += 1;
            if (isSuspectedEvent(e)) summary.suspected += 1;
            if (now - e.at <= CONFLICT_ACTIVE_WINDOW_MS) summary.active += 1; else summary.historical += 1;
            if (summary.lastAt === null || e.at > summary.lastAt) summary.lastAt = e.at;
        }
        const last = events[events.length - 1]!;
        summary.latest.push({ sessionId: s.id, at: last.at, kind: last.kind, detail: last.detail });
    }
    summary.latest.sort((a, b) => b.at - a.at);
    return summary;
}

/** #2102: wipe diagnostic ledgers — globally, or one session by id. Wiping is
 *  safe by design (#1206: "diagnostic, not history") and loses no conversation
 *  data. Returns how much was actually cleared. */
export function clearConflictEvents(sessions: Session[], sessionId?: string): { events: number; sessions: number } {
    let events = 0;
    let clearedSessions = 0;
    for (const s of sessions) {
        if (sessionId !== undefined && s.id !== sessionId) continue;
        const raw = conflictEventsOf(s);
        if (raw.length === 0) continue;
        delete s.metadata.conflictEvents;
        markDirty(s);
        events += raw.length;
        clearedSessions += 1;
    }
    return { events, sessions: clearedSessions };
}
