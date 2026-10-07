import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createInitialState, defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { detectLocalCompactionRewrite, listSessions, resetSessionCompression, type Session } from "../src/session.ts";
import { reconcileFoldCoverage } from "../src/fold-reconcile.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import type { ProxyOptions } from "../src/config.ts";
import type { CoreMessage } from "acp-kernel";

// #2372: Codex LOCAL auto-compaction replaces the early history client-side
// (retained tail + one summary) with no /responses/compact to key off. The
// Responses wire must treat that high-confidence shape as a semantic compaction
// boundary and REBASE the fold substrate (same primitive as the announced path)
// instead of letting dead coverage persist into "substrate destroyed".

function msg(id: string, role: string, text: string): CoreMessage {
    return { id, role, contentType: "text", text } as CoreMessage;
}

// A mature folded session: `coveredCount` active-fold-covered ids plus a prior
// order backbone of length `orderLen` (undefined = no backbone). `lastLen`
// optionally sets lastMessages as the detector's fallback length source.
function foldedSession(coveredCount: number, orderLen: number | undefined, lastLen?: number): Session {
    const ids = Array.from({ length: coveredCount }, (_, i) => `cov${i}`);
    const metadata: Record<string, unknown> = {};
    if (orderLen !== undefined) metadata.foldAnchorOrder = Array.from({ length: orderLen }, (_, i) => `ord${i}`);
    const session = { state: { blocks: [{ active: true, blockId: "b1", effectiveMessageIds: ids }] }, metadata, blockContents: new Map<string, unknown>(), pendingRetrievals: [] as unknown[], stats: {} } as unknown as Session & { lastMessages?: CoreMessage[] };
    if (lastLen !== undefined) session.lastMessages = Array.from({ length: lastLen }, (_, i) => msg(`lm${i}`, "user", `padding ${i}`));
    return session;
}

describe("detectLocalCompactionRewrite (#2372)", () => {
    test("detects a local-compaction-shaped shrinkage of a mature fold substrate", () => {
        const session = foldedSession(60, 60);
        const incoming = Array.from({ length: 12 }, (_, i) => msg(`new${i}`, "user", `post-compaction retained ${i}`));
        const det = detectLocalCompactionRewrite(session, incoming);
        assert.equal(det.detected, true);
        assert.equal(det.covered, 60);
        assert.equal(det.present, 0);
        assert.equal(det.lost, 60);
        assert.equal(det.incomingTotal, 12);
        assert.equal(det.prevTotal, 60);
    });

    test("does not fire without strict shrinkage (stable-count rewrite)", () => {
        // Same count as the prior pass: churn, not compaction — fold-reconcile's
        // re-anchor owns that case, a rebase would swallow it.
        const session = foldedSession(60, 60);
        const incoming = Array.from({ length: 60 }, (_, i) => msg(`new${i}`, "user", `rewritten ${i}`));
        assert.equal(detectLocalCompactionRewrite(session, incoming).detected, false);
    });

    test("does not fire on append growth", () => {
        const session = foldedSession(60, 60);
        const incoming = Array.from({ length: 80 }, (_, i) => msg(`new${i}`, "user", `appended ${i}`));
        assert.equal(detectLocalCompactionRewrite(session, incoming).detected, false);
    });

    test("does not fire below the covered floor (no real folds)", () => {
        const session = foldedSession(8, 8);
        const incoming = Array.from({ length: 3 }, (_, i) => msg(`new${i}`, "user", `tiny ${i}`));
        assert.equal(detectLocalCompactionRewrite(session, incoming).detected, false);
    });

    test("does not fire when most covered content survives", () => {
        // 15 of 20 covered ids still ride the wire -> survival 0.75 > 0.5.
        const session = foldedSession(20, 20);
        const incoming = Array.from({ length: 15 }, (_, i) => msg(i < 15 ? `cov${i}` : `new${i}`, "user", `kept ${i}`));
        assert.equal(detectLocalCompactionRewrite(session, incoming).detected, false);
    });

    test("fires exactly at the 0.5 survival boundary", () => {
        const session = foldedSession(20, 20);
        const incoming = Array.from({ length: 10 }, (_, i) => msg(`cov${i}`, "user", `half kept ${i}`));
        const det = detectLocalCompactionRewrite(session, incoming);
        assert.equal(det.present, 10);
        assert.equal(det.detected, true, "survival exactly 0.5 counts as majority-lost");
    });

    test("does not fire with no prior length (first turn, no backbone)", () => {
        const session = foldedSession(60, undefined);
        const incoming = Array.from({ length: 12 }, (_, i) => msg(`new${i}`, "user", `x ${i}`));
        assert.equal(detectLocalCompactionRewrite(session, incoming).detected, false);
    });

    test("falls back to lastMessages length when the order backbone is absent", () => {
        const session = foldedSession(60, undefined, 60);
        const incoming = Array.from({ length: 12 }, (_, i) => msg(`new${i}`, "user", `x ${i}`));
        const det = detectLocalCompactionRewrite(session, incoming);
        assert.equal(det.prevTotal, 60);
        assert.equal(det.detected, true);
    });

    test("ignores inactive blocks when measuring coverage", () => {
        const session = foldedSession(60, 60);
        const blocks = (session.state as unknown as { blocks: Array<{ active: boolean; effectiveMessageIds: string[] }> }).blocks;
        blocks[0].active = false;
        const incoming = Array.from({ length: 12 }, (_, i) => msg(`new${i}`, "user", `x ${i}`));
        assert.equal(detectLocalCompactionRewrite(session, incoming).detected, false, "deactivated coverage is not 'lost'");
    });
});

test("rebase retires dead coverage and stops persistent substrate-destruction (#2372)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const shrunken = Array.from({ length: 12 }, (_, i) => msg(`p${i}`, "user", `post-compaction retained ${i}`));
    const escalations = (s: Session) => {
        const logs: string[] = [];
        for (let p = 0; p < 3; p++) reconcileFoldCoverage(s, shrunken, { mode: "repair", sessionId: "s", log: (_l, m) => logs.push(m) });
        return logs.filter((l) => l.includes("substrate appears destroyed")).length;
    };
    // Pre-fix shape: three consecutive compacted passes over dead coverage escalate once.
    assert.equal(escalations(foldedSession(60, 60)), 1, "without rebase the substrate-destruction error fires");
    // Post-fix: prepareResponses detects + rebases first, so the same passes stay quiet.
    const healed = foldedSession(60, 60);
    assert.equal(detectLocalCompactionRewrite(healed, shrunken).detected, true);
    resetSessionCompression(healed);
    assert.equal(escalations(healed), 0, "rebased session never escalates");
    assert.equal(healed.state.blocks.length, 0, "dead coverage retired");
    assert.equal((healed.metadata.foldDriftStreak as number | undefined), undefined, "drift episode reset");
});

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}
function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

type RespItem = { type: "message"; id: string; status: "completed"; role: "user"; content: Array<{ type: "input_text"; text: string }> };

function respBody(n: number, prefix: string): Record<string, unknown> {
    const input: RespItem[] = Array.from({ length: n }, (_, i) => ({
        type: "message", id: `${prefix}${i}`, status: "completed", role: "user",
        content: [{ type: "input_text", text: `${prefix} turn ${i} with enough words to hash distinctly` }],
    }));
    return { model: "gpt-5", stream: false, instructions: `stable instructions for ${prefix}`, input };
}

test("Codex local auto-compaction rebases the fold substrate through the Responses wire (#2372)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstream = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "resp_test", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 1 } }));
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-5": { context: 400_000 } } } },
        modelContextLimit: 400_000, kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, chainContentDetection: false, autoUpdate: false,
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null,
        autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const base = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}`;
    const post = async (sessionId: string, body: Record<string, unknown>) => {
        const r = await fetch(`${base}/responses`, { method: "POST", headers: { "session-id": sessionId, "content-type": "application/json" }, body: JSON.stringify(body) });
        await r.arrayBuffer();
        assert.equal(r.status, 200);
    };
    const find = (sessionId: string) => {
        const s = listSessions().find((c) => c.meta.label === sessionId);
        assert.ok(s, `session ${sessionId} exists`);
        return s!;
    };
    const injectFolds = (s: Session, n: number) => {
        s.state.blocks = [{ active: true, blockId: "b1", effectiveMessageIds: Array.from({ length: n }, (_, i) => `cov${i}`) }] as typeof s.state.blocks;
        s.metadata.foldAnchorOrder = Array.from({ length: n }, (_, i) => `ord${i}`);
    };
    try {
        // --- positive: local compaction (shrunken history) triggers a rebase ---
        const sidPos = "2372-positive-session";
        await post(sidPos, respBody(3, "pos"));
        const pos = find(sidPos);
        injectFolds(pos, 60); // simulate a mature fold substrate from prior turns
        assert.equal(pos.state.blocks.length, 1);
        await post(sidPos, respBody(12, "pos-after")); // retained tail + summary, shrunken
        const posAfter = find(sidPos);
        assert.equal(posAfter.state.blocks.length, 0, "fold substrate rebased (coverage retired)");
        assert.equal((posAfter.state as unknown as { nextBlockId: number }).nextBlockId, createInitialState().nextBlockId, "refs restarted on rebase");
        assert.equal(posAfter.blockContents.size, 0, "original-content cache cleared on rebase");
        const boundary = posAfter.metadata.nativeCompactionBoundary as Record<string, unknown>;
        assert.equal(boundary.source, "local-compaction-detected");
        assert.equal(boundary.pendingRebase, false);
        assert.ok(typeof boundary.rebasedAt === "number");

        // --- negative: ordinary GROWTH must NOT rebase (shrinkage gate) ---
        const sidNeg = "2372-negative-session";
        await post(sidNeg, respBody(3, "neg"));
        const neg = find(sidNeg);
        injectFolds(neg, 60);
        await post(sidNeg, respBody(70, "neg-grow")); // history grew beyond the prior pass
        const negAfter = find(sidNeg);
        const negBoundary = negAfter.metadata.nativeCompactionBoundary as Record<string, unknown> | undefined;
        assert.notEqual(negBoundary?.source, "local-compaction-detected", "growth is not a compaction");
        assert.equal(negAfter.state.blocks.length, 1, "folds preserved on growth");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});
