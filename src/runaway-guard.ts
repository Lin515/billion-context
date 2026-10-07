import { ACP_NAME_ALT } from "./loop/tag-echo-filter.js";

// Runaway-enumeration intrinsic termination (#2346). One assistant message can
// degenerate into hundreds of echoed markers (render tags / tool-call XML) with no
// semantic stop, running to the output limit or a manual cutoff (instance A: 265 acp
// tags m02040..m02304; instance B: ~8.7k antml fragments). This gives the stream an
// INTRINSIC scale-based terminator. Scale, never shape/malformed-tag: legit turns top
// out at ~11 tags, and turns with a few DEGENERATE tags still complete normally — those
// must never be co-blocked. Ref-validity is NOT a signal (instance A's refs were all
// valid) and frame-kind counting is not used (it misfires on tool turns). INVARIANT
// (#1039): counts RAW bytes only, never rewrites/drops/reorders a forwarded byte, sends
// no corrective re-request nudge; on trip the caller aborts the upstream, which also
// sets the loop signal and so suppresses the one-shot retries (all gated on !aborted).

export interface RunawayVerdict {
    tripped: boolean;
    reason?: "acp-enumeration" | "tool-xml-flood";
    detail?: {
        acpTags: number;
        toolXmlFragments: number;
        maxMonotonicRefRun: number;
        zeroTokenFraction: number;
    };
}

interface RunawayGuard {
    /** Feed one chunk of RAW wire text (utf8-decoded SSE/JSON body). Stateful across chunk boundaries. */
    feed(chunkText: string): RunawayVerdict;
}

// Scale thresholds sit far above any legitimate single-message maximum.
export const ACP_TAG_THRESHOLD = 50; // legit single-msg ceiling observed: 11
const MONO_REF_RUN_THRESHOLD = 50; // corroborator: consecutive +1 kernel refs
const ZERO_TOKEN_FRACTION = 0.9; // corroborator: >=90% of counted tags carry tokens="0"
export const TOOL_XML_THRESHOLD = 300; // legit multi-tool turns << this; runaway B ~= 8700

// Bounded carry-over so a marker split across two chunks is still seen whole. Longer
// than any single runaway marker (short tags with short attrs); a pathological long
// attr-run simply under-counts (fail-safe direction — it is not a runaway shape).
const TAIL_CAP = 256;

// A render-tag OPENING (<name …attrs…> or bare <name>). Reuses the SAME name mutation
// set the stripper uses (ACP_NAME_ALT) so the counter counts exactly what the system
// treats as a render tag. The attrs are the single capturing group (m[1]).
const ACP_OPEN_RE = new RegExp("\x3c" + ACP_NAME_ALT + "((?:\\s[^<>]*)?)>", "g");
// Tool-call XML template fragments (instance B carrier): any open/close invoke /
// parameter / function[_calls] / tool_call(s), antml-namespaced or not.
const TOOL_XML_RE = new RegExp("\\x3c\\/?(?:antml:)?(invoke|tool_calls|tool_call|parameter|parameters|function_calls|function)\\b", "gi");
const REF_RE = /m(\d{4,})/;
const TOKENS_ATTR_RE = /tokens\s*=\s*"(\d+)"/i;

export function createRunawayGuard(): RunawayGuard {
    let pending = "";
    let acpTags = 0;
    let toolXml = 0;
    let zeroTokens = 0;
    let lastRef: number | null = null;
    let monoRun = 0;
    let maxMonoRun = 0;
    let tripped = false;

    const detail = (): NonNullable<RunawayVerdict["detail"]> => ({
        acpTags,
        toolXmlFragments: toolXml,
        maxMonotonicRefRun: maxMonoRun,
        zeroTokenFraction: acpTags > 0 ? zeroTokens / acpTags : 0,
    });

    const feed = (chunkText: string): RunawayVerdict => {
        if (tripped) return { tripped: true, reason: undefined, detail: detail() };
        if (chunkText.length === 0) return { tripped: false };
        const scan = pending + chunkText;
        let lastEnd = 0;

        ACP_OPEN_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = ACP_OPEN_RE.exec(scan)) !== null) {
            acpTags += 1;
            const end = m.index + m[0].length;
            if (end > lastEnd) lastEnd = end;
            const tm = TOKENS_ATTR_RE.exec(m[1] ?? "");
            if (tm && tm[1] === "0") zeroTokens += 1;
            // The kernel ref sits immediately after the opening (<…>mNNNNN</…>); read a
            // short window past the ">". A ref split at a chunk boundary is missed (its
            // open tag already left pending) — that only ever SHORTENS a monotonic run,
            // i.e. fail-safe direction: a miss, never a false corroboration.
            const rm = REF_RE.exec(scan.slice(end, end + 48));
            if (rm) {
                const n = Number.parseInt(rm[1], 10);
                monoRun = lastRef !== null && n === lastRef + 1 ? monoRun + 1 : 1;
                lastRef = n;
                if (monoRun > maxMonoRun) maxMonoRun = monoRun;
            }
        }

        TOOL_XML_RE.lastIndex = 0;
        while ((m = TOOL_XML_RE.exec(scan)) !== null) {
            toolXml += 1;
            const end = m.index + m[0].length;
            if (end > lastEnd) lastEnd = end;
        }

        // Retain only the unconsumed tail (past the last full match) so nothing already
        // counted is re-scanned next chunk, yet a partial head still completes across the
        // boundary. Pure-prose chunks (no "<") skip feed() upstream, leaving pending intact.
        pending = scan.slice(lastEnd);
        if (pending.length > TAIL_CAP) pending = pending.slice(-TAIL_CAP);

        const zeroFraction = acpTags > 0 ? zeroTokens / acpTags : 0;
        if (acpTags >= ACP_TAG_THRESHOLD && (maxMonoRun >= MONO_REF_RUN_THRESHOLD || zeroFraction >= ZERO_TOKEN_FRACTION)) {
            tripped = true;
            return { tripped: true, reason: "acp-enumeration", detail: detail() };
        }
        if (toolXml >= TOOL_XML_THRESHOLD) {
            tripped = true;
            return { tripped: true, reason: "tool-xml-flood", detail: detail() };
        }
        // Always expose the running counts (even below threshold) so callers can log
        // near-misses and the thresholds stay tunable against live traffic (#2346/#2347).
        return { tripped: false, detail: detail() };
    };

    return { feed };
}

/** Tee a raw response stream through a runaway guard. Bytes are forwarded BYTE-EXACT;
 *  on trip it fires onTrip (caller aborts the upstream), closes the downstream cleanly
 *  (EOF, not an error), and releases the source reader. */
export function wrapStreamWithRunawayGuard<T extends Uint8Array>(
    source: ReadableStream<T>,
    onTrip: (verdict: RunawayVerdict) => void,
): ReadableStream<T> {
    const guard = createRunawayGuard();
    const reader = source.getReader();
    const decoder = new TextDecoder();
    let settled = false;
    return new ReadableStream<T>({
        async pull(controller) {
            if (settled) return;
            const r = await reader.read();
            if (r.done) {
                settled = true;
                controller.close();
                return;
            }
            const value = r.value;
            // Cheap pre-gate: a chunk with no angle bracket cannot start a marker, so it
            // needs no regex pass (pending stays intact for a later completing chunk).
            const text = decoder.decode(value, { stream: true });
            if (text.includes("\x3c")) {
                const v = guard.feed(text);
                if (v.tripped) {
                    settled = true;
                    onTrip(v);
                    controller.close();
                    reader.cancel().catch(() => {});
                    return;
                }
            }
            controller.enqueue(value);
        },
        cancel(reason) {
            settled = true;
            reader.cancel(reason).catch(() => {});
        },
    });
}
