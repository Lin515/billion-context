import { performance } from "node:perf_hooks";
import { SummaryCredentialStore } from "./external-summary-credentials.js";
import { createSummaryHttpCandidate } from "./external-summary-http.js";
import { parseExternalSummarySettings, type ExternalSummarySettings } from "./external-summary-settings.js";
import { ExternalSummaryExecutor, type ExternalSummaryBatchResult, type SummaryCandidate, type SummaryWork } from "./external-summary.js";

// One shared queue across all sessions and all compression entry points.
const executor = new ExternalSummaryExecutor(4);

export class ConfiguredSummaryPlan {
    private readonly candidates: readonly SummaryCandidate[];
    private readonly settings: ExternalSummarySettings;
    readonly deadline: number;

    // `raw` may be an already-parsed chain off the request rail or raw JSON
    // from a hand-edited file — re-parse here so invalid settings fail
    // loudly at plan build, never silently use main-model summaries.
    constructor(raw: unknown, store = new SummaryCredentialStore(), env: NodeJS.ProcessEnv = process.env) {
        this.settings = parseExternalSummarySettings(raw);
        const proxyUrl = env.BILI_UPSTREAM_PROXY?.trim() || undefined;
        this.deadline = performance.now() + this.settings.budget.totalTimeoutMs;
        this.candidates = this.settings.targets.map((target) => {
            try {
                const key = store.resolve(target.credentialRef, env);
                if (!key) throw new Error();
                const headers: Record<string, string> = target.protocol === "anthropic" ? { "x-api-key": key }
                    : target.protocol === "google" ? { "x-goog-api-key": key }
                    : { authorization: `Bearer ${key}` };
                return createSummaryHttpCandidate({ ...target, headers, proxyUrl }, this.settings.budget.maxSummaryBytes * 4 + 65536);
            } catch {
                // Preserve order without leaking private errors or borrowing main auth.
                return { async summarize(): Promise<string> { throw new Error("External summary candidate unavailable"); } };
            }
        });
    }

    async summarize(work: readonly SummaryWork[], signal?: AbortSignal): Promise<ExternalSummaryBatchResult> {
        const remaining = Math.floor(this.deadline - performance.now());
        if (remaining <= 0) return { status: "deadline", results: [] };
        return executor.executeBatch(work, this.candidates, {
            ...this.settings.budget, totalTimeoutMs: remaining,
            targetTimeoutMs: Math.min(remaining, this.settings.budget.targetTimeoutMs),
        }, signal);
    }
}

/** Build the per-request plan from the RESOLVED settings riding the request
 *  Config rail (`ResolvedKernelConfig.externalSummary`, merged by
 *  `mergeCompress` with whole-chain-replace semantics). undefined/disabled →
 *  undefined (legacy in-model summaries). Invalid settings throw — they must
 *  fail loudly, never silently fall back to main-model summaries. */
export function configuredSummaryPlan(settings: unknown): ConfiguredSummaryPlan | undefined {
    if (!settings || typeof settings !== "object") return undefined;
    if ((settings as { enabled?: unknown }).enabled !== true) return undefined;
    return new ConfiguredSummaryPlan(settings);
}
