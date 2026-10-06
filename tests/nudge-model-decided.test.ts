import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { describe, it } from "node:test";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { defaultConfig } from "acp-kernel";

process.env.NODE_ENV = "test";

// #2228 end-to-end: model-decided nudge timing through the REAL pipeline.
// A session must cross the GENTLE-GROWTH tier-1 arm (usage < maxContextLimitPct
// so the pressure band — which NEVER consults the model per the owner ruling —
// stays closed, while tokenCount grew past nudgeGrowthTokens since the last
// baseline). Reported usage lags one turn (settleUsageReport runs on each
// response), so the fixture needs three turns: turn 1 seeds the baseline,
// turn 2's report carries turn 3's prepare past the growth floor at 62.5%
// usage (under the 75% over-limit line). The mock upstream discriminates the
// decision side call by its ≤200-token output budget and answers per scenario;
// every other request gets an ordinary completion.

const WINDOW = 128_000;

type Verdict = "yes" | "no" | "garbage";

const longText = (n: number) => "a".repeat(n);

interface Fixture {
    turns: Record<string, unknown>[][];
    reports: number[];
    baseMainLen: number;
}

const GENTLE: Fixture = (() => {
    const t1 = [
        { role: "user", content: "hello" },
        { role: "assistant", content: longText(80_000) },
    ];
    const t2 = [
        ...t1,
        { role: "user", content: "go" },
        { role: "assistant", content: longText(120_000) },
        { role: "user", content: "more" },
        { role: "assistant", content: longText(120_000) },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2" },
        { role: "user", content: "u3" },
    ];
    const t3 = [...t2, { role: "user", content: "u4" }];
    return { turns: [t1, t2, t3], reports: [20_000, 80_000, 80_400], baseMainLen: 13 };
})();

const OVER_LIMIT: Fixture = (() => {
    const history: Record<string, unknown>[] = [{ role: "user", content: "hello" }];
    history.push({ role: "assistant", content: longText(20_000) });
    for (let i = 0; i < 12; i++) {
        history.push({ role: "user", content: `filler u${i}: ${"x".repeat(2_000)}` });
        history.push({ role: "assistant", content: `filler a${i}: ${"y".repeat(2_000)}` });
    }
    history.push({ role: "user", content: "u1" });
    history.push({ role: "assistant", content: "a1" });
    history.push({ role: "user", content: "u2" });
    history.push({ role: "assistant", content: "a2" });
    history.push({ role: "user", content: "u3" });
    return { turns: [[{ role: "user", content: "hello" }], history], reports: [50_000, 50_000], baseMainLen: 31 };
})();

function okJson(promptTokens: number): string {
    return JSON.stringify({
        id: "chatcmpl-test", object: "chat.completion", created: 1, model: "deepseek-v4-flash",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: promptTokens + 5 },
    });
}

async function runScenario(fixture: Fixture, verdict: Verdict | "off") {
    const seen = { mains: [] as any[], sides: [] as any[] };
    let mainTurn = 0;

    const up = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const isSide = typeof body.max_tokens === "number" && body.max_tokens <= 200;
            if (isSide) {
                seen.sides.push(body);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "chatcmpl-side", object: "chat.completion", created: 1, model: "deepseek-v4-flash",
                    choices: [{ index: 0, message: { role: "assistant", content: verdict === "yes" ? '{"compress": true}' : verdict === "no" ? '{"compress": false}' : "Sure, let me think about what to compress here." }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                }));
                return;
            }
            mainTurn += 1;
            seen.mains.push(body);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(okJson(fixture.reports[Math.min(mainTurn - 1, fixture.reports.length - 1)]));
        });
    });
    up.listen(0, "127.0.0.1");
    await once(up, "listening");
    const upstreamPort = (up.address() as { port: number }).port;
    const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;

    setRegistryForTest({});
    _setStoreForTest(new SessionStore({ enabled: false }));

    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`${upstreamUrl}/v1/chat/completions`]: { models: { "deepseek-v4-flash": { context: WINDOW } } } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW),
        compress: verdict === "off" ? { injectTool: true, injectNudge: true } : { injectTool: true, injectNudge: true, nudgeModelDecided: true, nudgeGrowthTokens: 20_000 },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        chainContentDetection: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] }, compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/${upstreamUrl}/v1/chat/completions`;

    try {
        const sessionId = `s-${verdict}-${Math.random().toString(36).slice(2)}`;
        for (const turn of fixture.turns) {
            const resp = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": sessionId },
                body: JSON.stringify({ model: "deepseek-v4-flash", messages: turn }),
            });
            assert.equal(resp.status, 200);
            await resp.text();
        }
        assert.equal(seen.mains.length, fixture.turns.length, "all turns reach the upstream");
        return { main: seen.mains[seen.mains.length - 1], sides: seen.sides };
    } finally {
        proxy.close();
        await once(proxy, "close");
        up.close();
        await once(up, "close");
    }
}

describe("#2228 model-decided nudge timing (e2e)", () => {
    it("gentle-growth yes → directive with program-finalized span injected", async () => {
        const { main, sides } = await runScenario(GENTLE, "yes");
        assert.equal(sides.length, 1, "exactly one decision side call");
        assert.deepEqual(sides.map((s) => s.max_tokens), [200]);
        const q = String(sides[0].messages[sides[0].messages.length - 1].content);
        assert.ok(q.includes("[bili-compress-decision]"), "side call ends with the decision question");
        assert.equal(main.messages.length, GENTLE.baseMainLen + 1, "directive occupies the nudge slot");
        const directive = String(main.messages[main.messages.length - 1].content);
        assert.ok(directive.includes("[bili-compress-directive]"), "directive marker present");
        assert.ok(directive.includes("Compress NOW"), "explicit instruction present");
        assert.match(directive, /Target span: m\d{4,}\u2013m\d{4,}/, "program-finalized span present");
    });

    it("gentle-growth no → nothing injected", async () => {
        const { main, sides } = await runScenario(GENTLE, "no");
        assert.equal(sides.length, 1);
        assert.equal(main.messages.length, GENTLE.baseMainLen, "no nudge slot consumed");
    });

    it("gentle-growth garbage prose → nothing injected (never degrades to blind compress)", async () => {
        const { main, sides } = await runScenario(GENTLE, "garbage");
        assert.equal(sides.length, 1);
        assert.equal(main.messages.length, GENTLE.baseMainLen, "malformed answer injects nothing");
    });

    it("feature off → legacy advisory byte-for-byte, zero side calls", async () => {
        const { main, sides } = await runScenario(GENTLE, "off");
        assert.equal(sides.length, 0, "decision path disabled");
        assert.equal(main.messages.length, GENTLE.baseMainLen + 1, "legacy advisory still injected");
        const tail = String(main.messages[main.messages.length - 1].content);
        assert.ok(!tail.includes("[bili-compress-decision]") && !tail.includes("[bili-compress-directive]"), "legacy advisory text unchanged");
    });

    it("over-limit (pressure band) → legacy advisory immediately, model never consulted", async () => {
        const { main, sides } = await runScenario(OVER_LIMIT, "yes");
        assert.equal(sides.length, 0, "owner ruling: over-limit arms hold no veto — no side call");
        assert.equal(main.messages.length, OVER_LIMIT.baseMainLen + 1, "legacy advisory injected straight away");
        const tail = String(main.messages[main.messages.length - 1].content);
        assert.ok(!tail.includes("[bili-compress-decision]") && !tail.includes("[bili-compress-directive]"), "legacy advisory text unchanged");
    });
});
