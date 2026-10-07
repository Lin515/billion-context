import type { TagEchoFilterStats } from "./loop/tag-echo-filter.js";

// #673: detection of degenerate terminal turns — upstream finishes normally
// (end_turn / stop / completed) but the client receives zero visible text and
// zero tool calls. Observed cause: the turn's only text was a render-tag echo
// the stripper missed (typo'd tag name), so the agent receives an empty turn
// mid-orchestration and stalls until manually nudged. The condition is
// deliberately recall-first: a legitimately empty text-only terminal turn is
// rare and equally confusing to an agentic client, so it warns too. Callers
// gate on their wire's own state (reason seen, tool calls emitted, thinking
// presence) and feed the filter's lifetime text accounting.
interface TurnOutcome {
    /** Wire-native reason observed (stop_reason / finish_reason / status), if any. */
    reason: string | undefined;
    /** The wire's normal-completion reason ("end_turn" / "stop" / "completed"). */
    terminalReason: string;
    toolCalls: number;
    /** Lifetime visible-text accounting (summed across text fields/blocks). */
    text: TagEchoFilterStats;
    sawThinking: boolean;
    /** Wire label for logs, e.g. "anthropic" or "plugin-passthrough-openai". */
    wire: string;
}

export function degenerateTurnWarning(o: TurnOutcome): string | null {
    if ((o.reason ?? o.terminalReason) !== o.terminalReason) return null;
    if (o.toolCalls > 0) return null;
    if (o.text.outputChars > 0) return null;
    const bits: string[] = [];
    if (o.sawThinking) bits.push("thinking present");
    if (o.text.dropped && o.text.inputChars > 0) bits.push(`${o.text.inputChars} chars of emitted text stripped as render-tag echo`);
    else bits.push("no visible text emitted");
    return (
        `[degenerate-turn] ${o.wire}: turn ended ${o.terminalReason} with zero visible text and zero tool calls (${bits.join("; ")}) ` +
        `— the agent receives an empty turn and may stall until nudged (#673)`
    );
}

// #2303: a terminal turn whose visible prose ENDS with a compression-draft
// closing tag (the summary / analysis close forms) and no tool call is non-
// converged even though it delivered text: the model wrote a handoff or
// compression draft as prose — describing the tool call it was about to make —
// instead of issuing it, most often after the upstream cut the final tool call
// out of the step (observed: 149 silent stops across 70 sessions, DSH native).
// The tag vocabulary is model-side learned convention (the kernel prompts
// contain no such tags), so the matcher is deliberately narrow: exactly the two
// closing tags seen in production, fully closed (truncated forms are a
// different defect class — #1755/#2190 — and stay out of scope), case-
// insensitive (#1731 case drift), trailing whitespace allowed.
const DRAFT_CLOSE_TAIL = /\x3c\/(?:summary|analysis)\x3e\s*$/i;
export function endsWithDraftClose(text: string): boolean {
    return text.length > 0 && DRAFT_CLOSE_TAIL.test(text);
}
