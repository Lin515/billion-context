import type { ResolvedKernelConfig } from "./compress-settings.js";

export const EXTERNAL_SUMMARY_NOTE = "\n\n[External summary mode: the conversation model selects consumed ranges; the configured independent summary service generates the authoritative summary. Use object-form content: [{startId, endId, topic?}]. summary is optional and, if supplied, only a non-authoritative hint, not the committed summary. Selected source text and read-only context are sent to the configured service using its separate credentials. All candidates failing leaves originals unchanged. This mode overrides instructions above requiring you to write the final summary.]";

/** External-summary mode for one request, decided by the request's own
 *  resolved Config (three-level cascade, same as every other compress field):
 *  `config.externalSummary?.enabled === true`. The settings ride the
 *  ResolvedKernelConfig rail from resolveRequestConfig → storeEffectiveConfig,
 *  so no consumer re-reads the config file. */
export function externalSummaryEnabled(config: unknown): boolean {
    return (config as ResolvedKernelConfig | undefined)?.externalSummary?.enabled === true;
}

function adaptSchema(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(adaptSchema);
    if (!value || typeof value !== "object") return value;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        result[key] = key === "required" && Array.isArray(child) ? child.filter((name) => name !== "summary") : adaptSchema(child);
    }
    const properties = result.properties as Record<string, unknown> | undefined;
    if (properties?.summary) properties.summary = { type: "string", description: "Optional non-authoritative hint; the independent service generates the committed summary." };
    return result;
}

/** Preserve protocol wrappers and unrelated tools; never mutate shared kernel constants. */
export function withExternalSummaryTools<T>(tools: readonly T[], enabled: boolean): T[] {
    if (!enabled) return [...tools];
    return tools.map((tool) => {
        const copy = structuredClone(tool) as T & { name?: string; description?: string; parameters?: unknown; input_schema?: unknown; function?: { name?: string; description?: string; parameters?: unknown } };
        const declaration = copy.function ?? copy;
        if (declaration.name !== "compress") return tool;
        declaration.description = "Compress selected consumed ranges using the configured independent summary service." + EXTERNAL_SUMMARY_NOTE;
        if (declaration.parameters) declaration.parameters = adaptSchema(declaration.parameters);
        if (copy.input_schema) copy.input_schema = adaptSchema(copy.input_schema);
        return copy;
    });
}
