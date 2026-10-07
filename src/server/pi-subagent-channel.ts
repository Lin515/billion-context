// #2268: pi-subagents builtin roles ship strict frontmatter `tools:` allowlists
// that list none of the ACP context tool names. Since #2209's required-extension
// self-registration those children load bili and get named plugin sessions — but
// pi's child tool planning never adds extension-registered names to the effective
// allowlist, so the model cannot call compress/decompress/search_context/acp_status
// locally while the proxy (plugin mode) withholds wire injection. Pre-#2209,
// foreground children ran as anonymous proxy-mode sessions where wire-injected
// ACP tools worked; the upgrade silently downgraded interactive compression for
// those roles.
//
// Fix (owner-scoped to nicobailon/pi-subagents children only): a capability-aware
// channel fallback. Every in-process pi-subagents child request carries a stable
// marker at the head of its system prompt — `<active_agent name="...">` (see
// buildInProcessChildLaunch in pi-subagents' child-launch.ts). When a
// plugin-stamped pi request carries that marker AND its tools array exposes none
// of the tool names bili would inject, the request is served through the
// proxy-style channel (wire-injected tools + nudge, server-side execution,
// acp_summary carrier): exactly what pre-#2209 foreground children got, now on
// top of named-session identity. The decision is stateless per request — a
// mid-session whitelist change self-heals on the next request, and if upstream
// ever drops the tag we degrade gracefully to today's behavior. A role exposing
// ANY bili-injectable name stays pure plugin mode (duplicate tool declarations
// are rejected by providers; partial grants remain unsupported by design).

const PI_SUBAGENT_CHILD_MARKER = "\x3cactive_agent name=";

/** Tool names bili may add to the request tools array when serving the
 *  proxy-style channel: the core ACP four plus the feature extras at their
 *  default names (absorb.toolName / ccr.toolName are config-renamable — a
 *  renamed extra colliding with a role-whitelisted name is an accepted residual
 *  edge, see PR #2268 discussion). */
const BILI_INJECTABLE_TOOL_NAMES = new Set([
    "compress",
    "decompress",
    "search_context",
    "acp_status",
    "acp_rule",
    "acp_retrieve",
    "absorb",
    "image_full",
]);

type PiSubagentChildSignal = { present: false } | { present: true; agent?: string };

/** Detect the pi-subagents child marker in the raw request body. The marker
 *  lives inside a JSON string value; `<`, letters, spaces and `=` are never
 *  JSON-escaped, so a raw byte search is exact for all four wire shapes. The
 *  role name is extracted best-effort from the bytes right after the marker
 *  (for logging only) — the surrounding quotes arrive backslash-escaped in the
 *  raw body. */
export function detectPiSubagentChildSignal(bodyBuffer: Buffer): PiSubagentChildSignal {
    const idx = bodyBuffer.indexOf(PI_SUBAGENT_CHILD_MARKER);
    if (idx < 0) return { present: false };
    let agent: string | undefined;
    const tail = bodyBuffer.subarray(idx, Math.min(bodyBuffer.length, idx + PI_SUBAGENT_CHILD_MARKER.length + 96)).toString("utf8").replace(/\\/g, "");
    const m = tail.match(/name="([^"]*)"/);
    if (m && m[1]) agent = m[1];
    return { present: true, ...(agent ? { agent } : {}) };
}

function isInjectableName(v: unknown): boolean {
    return typeof v === "string" && BILI_INJECTABLE_TOOL_NAMES.has(v);
}

/** Does the client-declared tools array expose any bili-injectable tool name?
 *  One generic walk covers all four wire shapes: top-level `name` (anthropic /
 *  responses), `function.name` (openai), `functionDeclarations[].name` (google).
 *  Malformed entries are skipped, never thrown on — bodies are client-supplied. */
export function exposesBiliInjectableTool(tools: unknown): boolean {
    if (!Array.isArray(tools)) return false;
    for (const entry of tools) {
        if (typeof entry !== "object" || entry === null) continue;
        const rec = entry as Record<string, unknown>;
        if (isInjectableName(rec.name)) return true;
        const fn = rec.function;
        if (typeof fn === "object" && fn !== null && isInjectableName((fn as Record<string, unknown>).name)) return true;
        const decls = rec.functionDeclarations;
        if (Array.isArray(decls)) {
            for (const d of decls) {
                if (typeof d === "object" && d !== null && isInjectableName((d as Record<string, unknown>).name)) return true;
            }
        }
    }
    return false;
}

/** Full gate: pi-subagents child marker present AND the role allowlist exposes
 *  no bili-injectable tool name. Caller additionally requires pluginAgent==="pi". */
export function piSubagentChannelFallback(bodyBuffer: Buffer, parsed: unknown): PiSubagentChildSignal {
    const signal = detectPiSubagentChildSignal(bodyBuffer);
    if (!signal.present) return signal;
    const tools = typeof parsed === "object" && parsed !== null ? (parsed as { tools?: unknown }).tools : undefined;
    if (exposesBiliInjectableTool(tools)) return { present: false };
    return signal;
}
