// Web conflicts banner: the aggregate line must NAME the conflicting
// plugin/mechanism, not just counts (#1206 ledger carries per-event identity;
// the banner used to force users into acp_status to find out WHAT it was).
// #2102: non-plugin kinds (client-native rewrites) get time+detail items too,
// the line splits active vs historical, and non-plugin items are capped so a
// stock ledger doesn't turn the banner into a log dump.
import test from "node:test";
import assert from "node:assert/strict";
import { WEB_CLIENT } from "../src/web/client.ts";

// #2324: bili_conflictLine now localizes its age labels via t(), so the extracted
// slice must reach back to the IIFE top ("use strict") to capture MESSAGES/locale/t.
// In the Node test env localStorage/navigator throw inside the guarded try/catch, so
// locale deterministically defaults to "zh-CN" — assertions below expect zh labels.
const START_MARK = '"use strict";';
const END_MARK = "window.bili_conflictLine = bili_conflictLine;";

type LatestEntry = { kind: string; detail?: string; at?: number; sessionId?: string };
type BannerInput = { events?: number; sessions?: number; active?: number; historical?: number; kinds?: Record<string, number>; latest?: LatestEntry[] };
type SeverityInput = BannerInput & { sibling?: number; suspected?: number };
interface Severity { onKey: string; riskKey: string; hasConfirmed: boolean; what: string; active: number }

// Both helpers share the same extracted slice (they sit together in WEB_CLIENT);
// the slice ends at the first window.* export so no `window` reference runs under Node.
function _extract(): { line: (c: BannerInput) => string; severity: (c: SeverityInput) => Severity } {
    const s = WEB_CLIENT.indexOf(START_MARK);
    const e = WEB_CLIENT.indexOf(END_MARK);
    assert.ok(s >= 0 && e > s, "conflict-banner helpers missing from WEB_CLIENT");
    const src = WEB_CLIENT.slice(s, e) + "\nreturn { line: bili_conflictLine, severity: bili_conflictSeverity };";
    return new Function(src)() as { line: (c: BannerInput) => string; severity: (c: SeverityInput) => Severity };
}
function bannerLine(): (c: BannerInput) => string { return _extract().line; }
function bannerSeverity(): (c: SeverityInput) => Severity { return _extract().severity; }

test("banner line shows FULL identity (client: entry + source), dedupe, weights, suspected marker (#2045)", () => {
    const f = bannerLine();
    const out = f({
        events: 40, sessions: 23,
        kinds: { "third-party-plugin": 40 },
        latest: [
            { kind: "third-party-plugin", detail: "pi: npm:billion-context-pi (/home/dog/.pi/agent/settings.json)" },
            { kind: "third-party-plugin", detail: "pi: npm:context-forge (/home/dog/.pi/agent/settings.json) [suspected]" },
            { kind: "third-party-plugin", detail: "pi: npm:context-forge (/home/dog/.pi/agent/settings.json) [suspected]" },
            { kind: "third-party-plugin", detail: "opencode: opencode-acp (~/.config/opencode/opencode.json)" },
        ],
    });
    assert.equal(out,
        "40 event(s) in 23 session(s): third-party-plugin×40 — pi: npm:billion-context-pi (/home/dog/.pi/agent/settings.json) · pi: npm:context-forge (/home/dog/.pi/agent/settings.json) [suspected]×2 · opencode: opencode-acp (~/.config/opencode/opencode.json)");
});

test("banner line escapes HTML across the full detail incl. source path", () => {
    const f = bannerLine();
    const out = f({
        events: 1, sessions: 1, kinds: { "third-party-plugin": 1 },
        latest: [{ kind: "third-party-plugin", detail: "pi: npm:a<b&c (settings.json)" }],
    });
    assert.equal(out, "1 event(s) in 1 session(s): third-party-plugin×1 — pi: npm:a&lt;b&amp;c (settings.json)");
});

test("banner line lists ALL distinct plugin entries without truncation (#2045: 显示全尽量)", () => {
    const f = bannerLine();
    const latest = ["a-one", "a-two", "a-three", "a-four", "a-five"].map((n) => ({
        kind: "third-party-plugin" as const, detail: `pi: ${n} (/tmp/settings.json)`,
    }));
    const out = f({ events: 5, sessions: 5, kinds: { "third-party-plugin": 5 }, latest });
    assert.equal(out,
        "5 event(s) in 5 session(s): third-party-plugin×5 — pi: a-one (/tmp/settings.json) · pi: a-two (/tmp/settings.json) · pi: a-three (/tmp/settings.json) · pi: a-four (/tmp/settings.json) · pi: a-five (/tmp/settings.json)");
});

test("banner line degrades gracefully: no latest keeps the count-only shape", () => {
    const f = bannerLine();
    assert.equal(
        f({ events: 39, sessions: 22, kinds: { "third-party-plugin": 39 } }),
        "39 event(s) in 22 session(s): third-party-plugin×39");
});

test("banner line names non-plugin kinds with time + short session id + detail (#2102)", () => {
    const f = bannerLine();
    const out = f({
        events: 2, sessions: 1, kinds: { "native-compaction": 1, "unannounced-rewrite": 1 },
        latest: [
            { kind: "native-compaction", at: Date.UTC(2026, 9, 3, 5, 2), sessionId: "abcdef123456", detail: "codex: compaction_trigger item" },
            { kind: "unannounced-rewrite", at: Date.UTC(2026, 9, 3, 4, 58), sessionId: "fedcba654321", detail: "history rewrite without marker" },
        ],
    });
    assert.equal(out,
        "2 event(s) in 1 session(s): native-compaction×1, unannounced-rewrite×1 — [2026-10-03 05:02Z] abcde…: codex: compaction_trigger item · [2026-10-03 04:58Z] fedcb…: history rewrite without marker");
});

test("banner line omits the session id for short ids and truncates long details (#2102)", () => {
    const f = bannerLine();
    const longDetail = "x".repeat(70);
    const out = f({
        events: 1, sessions: 1, kinds: { "unannounced-rewrite": 1 },
        latest: [{ kind: "unannounced-rewrite", at: Date.UTC(2026, 9, 3, 5, 2), sessionId: "short1", detail: longDetail }],
    });
    const expectedDetail = longDetail.slice(0, 57) + "...";
    assert.equal(out,
        "1 event(s) in 1 session(s): unannounced-rewrite×1 — [2026-10-03 05:02Z]: " + expectedDetail);
});

test("banner line appends the active/historical split when present, degrades when absent (#2102)", () => {
    const f = bannerLine();
    const base = {
        events: 22, sessions: 6,
        kinds: { "unannounced-rewrite": 22 },
        latest: [
            { kind: "unannounced-rewrite", at: Date.UTC(2026, 9, 3, 5, 2), sessionId: "abcdef123456", detail: "d1" },
            { kind: "unannounced-rewrite", at: Date.UTC(2026, 9, 3, 4, 58), sessionId: "abcdef123456", detail: "d1" },
        ],
    };
    // Non-plugin item NAMES carry their own timestamp ([time] sid: detail), so
    // entries at distinct times stay separate rows — each row keeps its "when"
    // (the whole point of #2102 sub-problem ①). The ×N weight only collapses
    // identity-only names (plugin entries), never time-stamped ones.
    // #2324: the split is now localized record-recency labels (zh-CN under the
    // Node test env), not "N active / M historical" which read as liveness.
    const withSplit = f({ ...base, active: 0, historical: 22 });
    assert.equal(withSplit,
        "22 event(s) in 6 session(s): unannounced-rewrite×22 · 近 7 天 0 条 · 更早 22 条 — [2026-10-03 05:02Z] abcde…: d1 · [2026-10-03 04:58Z] abcde…: d1");
    const withoutSplit = f(base);
    assert.equal(withoutSplit.indexOf("近 7 天"), -1, "payloads without active/historical emit no age split at all");
    assert.equal(withoutSplit,
        "22 event(s) in 6 session(s): unannounced-rewrite×22 — [2026-10-03 05:02Z] abcde…: d1 · [2026-10-03 04:58Z] abcde…: d1");
});

test("banner line caps NON-plugin items at 4 with a stats pointer; plugin items stay uncapped (#2102)", () => {
    const f = bannerLine();
    const t0 = Date.UTC(2026, 9, 3, 5);
    const latest: LatestEntry[] = [
        ...["p1", "p2", "p3", "p4", "p5", "p6"].map((n) => ({ kind: "third-party-plugin", detail: `pi: ${n} (/tmp/settings.json)` })),
        { kind: "unannounced-rewrite", at: t0, sessionId: "aaaa1111bbbb", detail: "np-one" },
        { kind: "unannounced-rewrite", at: t0 + 60000, sessionId: "cccc2222dddd", detail: "np-two" },
        { kind: "unannounced-rewrite", at: t0 + 120000, sessionId: "eeee3333ffff", detail: "np-three" },
        { kind: "unannounced-rewrite", at: t0 + 180000, sessionId: "gggg4444hhhh", detail: "np-four" },
        { kind: "unannounced-rewrite", at: t0 + 240000, sessionId: "iiii5555jjjj", detail: "np-five" },
    ];
    const out = f({ events: 11, sessions: 7, kinds: { "third-party-plugin": 6, "unannounced-rewrite": 5 }, latest });
    assert.equal(out,
        "11 event(s) in 7 session(s): third-party-plugin×6, unannounced-rewrite×5 — pi: p1 (/tmp/settings.json) · pi: p2 (/tmp/settings.json) · pi: p3 (/tmp/settings.json) · pi: p4 (/tmp/settings.json) · pi: p5 (/tmp/settings.json) · pi: p6 (/tmp/settings.json) · [2026-10-03 05:00Z] aaaa1…: np-one · [2026-10-03 05:01Z] cccc2…: np-two · [2026-10-03 05:02Z] eeee3…: np-three · [2026-10-03 05:03Z] gggg4…: np-four · …+1 more (GET /__bili/stats → conflicts)");
});

// #2324: the banner's title/risk selection must NEVER treat name-only [suspected] matches
// as confirmed compressors. Assert on the i18n KEYS (locale-independent) so this pins the
// decision logic regardless of zh/en wording.
test("#2324 suspected-only ledger -> soft 'verify first' framing, no confirmed-conflict warning", () => {
    const sev = bannerSeverity();
    const r = sev({ events: 96, sessions: 96, kinds: { "third-party-plugin": 96 }, sibling: 0, suspected: 96, active: 96, historical: 0 });
    assert.strictEqual(r.hasConfirmed, false);
    assert.strictEqual(r.onKey, "conflict.on_suspected");
    assert.strictEqual(r.riskKey, "conflict.risk_suspected");
    assert.strictEqual(r.active, 96);
});

test("#2324 confirmed third-party plugin keeps the double-compression warning (active)", () => {
    const sev = bannerSeverity();
    const r = sev({ events: 10, kinds: { "third-party-plugin": 10 }, suspected: 0, active: 5, historical: 5 });
    assert.strictEqual(r.hasConfirmed, true);
    assert.strictEqual(r.onKey, "conflict.on");
    assert.strictEqual(r.riskKey, "conflict.risk_active");
});

test("#2324 confirmed plugin with only historical stock -> risk_historical", () => {
    const sev = bannerSeverity();
    const r = sev({ events: 4, kinds: { "third-party-plugin": 4 }, suspected: 0, active: 0, historical: 4 });
    assert.strictEqual(r.hasConfirmed, true);
    assert.strictEqual(r.riskKey, "conflict.risk_historical");
});

test("#2324 sibling-only -> stands-down framing, not a confirmed conflict (#2261 preserved)", () => {
    const sev = bannerSeverity();
    const r = sev({ events: 3, kinds: { "third-party-plugin": 3 }, sibling: 3, suspected: 0, active: 3 });
    assert.strictEqual(r.hasConfirmed, false);
    assert.strictEqual(r.onKey, "conflict.on");
    assert.strictEqual(r.riskKey, "conflict.risk_sibling");
});

test("#2324 mixed suspected+confirmed -> strong warning retained while naming both families", () => {
    const sev = bannerSeverity();
    const r = sev({ events: 10, kinds: { "third-party-plugin": 10 }, sibling: 0, suspected: 6, active: 10 });
    assert.strictEqual(r.hasConfirmed, true, "a single confirmed event keeps the imperative warning");
    assert.strictEqual(r.riskKey, "conflict.risk_active");
    assert.ok(r.what.length > 0, "families named");
});

test("#2324 native-compaction-only -> confirmed conflict framing", () => {
    const sev = bannerSeverity();
    const r = sev({ events: 7, kinds: { "native-compaction": 7 }, active: 7 });
    assert.strictEqual(r.hasConfirmed, true);
    assert.strictEqual(r.onKey, "conflict.on");
    assert.strictEqual(r.riskKey, "conflict.risk_active");
});

test("#2324 old payload without c.suspected degrades to the previous all-confirmed view", () => {
    const sev = bannerSeverity();
    const r = sev({ events: 96, sessions: 96, kinds: { "third-party-plugin": 96 }, active: 96 });
    assert.strictEqual(r.hasConfirmed, true);
    assert.strictEqual(r.riskKey, "conflict.risk_active");
});

test("banner wiring: conflicts-banner branch renders bili_conflictLine (drift guard)", () => {
    assert.ok(WEB_CLIENT.includes("window.bili_conflictLine = bili_conflictLine;"), "test seam export present");
    assert.ok(WEB_CLIENT.includes("bili_conflictLine(c)"), "banner branch calls the helper");
    const occurrences = WEB_CLIENT.split(" event(s) in ").length - 1;
    assert.equal(occurrences, 1, "'event(s) in' phrasing lives only inside bili_conflictLine");
});
