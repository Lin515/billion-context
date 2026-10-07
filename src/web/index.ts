import { renderPage } from "./page.js";
import { VERSION } from "../version.js";

export {
    handleConfigGet,
    handleConfigPut,
    handleSummaryCredentialPut,
    readProviders,
    readUpstreamSettings,
} from "./api.js";

export { buildOverview, buildSessionList, buildSessionPage, buildSessionDetail, hiddenEmptyCount } from "./sessions-data.js";

export function renderUI(origin: string, opts?: { embed?: boolean }): string {
    // #1426 fix: reuse the bundle-safe VERSION from src/version.ts — resolving
    // package.json relative to import.meta.url broke once tsup bundles this
    // module into dist/index.js (two levels up from dist/ misses the repo).
    // #2321: opts.embed renders the frameless face for hosts that embed the UI
    // in an iframe (the dsh settings panel).
    return renderPage(origin, VERSION, opts?.embed === true);
}
