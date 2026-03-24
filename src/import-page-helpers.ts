/**
 * import-page-helpers.ts
 *
 * Client-side helpers extracted from import/page.tsx that implement the
 * stylesheet filtering and config threading for the target preview.
 *
 * Implements:
 *   Step 1: filterSourceStylesheets (async content inspection)
 *           readManifestAssetList + resolveAssetUrl (unchanged from page.tsx)
 *           resolveProposalTargetPreviewHtml (updated to pass importMaster)
 */

import { extractSourceTailwindConfig, classifyStylesheetHref, buildPlatformBlockPreviewDocument } from "./platform-preview-shared.js";
import type { StudioImportMaster, StudioTheme, PlatformPreviewAssets } from "./types.js";

// ---------------------------------------------------------------------------
// Manifest asset readers (unchanged from import/page.tsx)
// ---------------------------------------------------------------------------

function readManifestAssetUrl(entry: unknown): string | null {
  if (typeof entry === "string" && entry.trim().length > 0) {
    return entry.trim();
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const candidates = [record["href"], record["src"], record["url"], record["value"]];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

export function resolveAssetUrl(asset: string, baseUrl?: string): string {
  const value = asset.trim();
  if (value.length === 0) {
    return "";
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

export function readManifestAssetList(
  manifest: unknown,
  key: "stylesheets" | "scripts",
  baseUrl?: string
): string[] {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [];
  }
  const raw = (manifest as Record<string, unknown>)[key];
  if (!Array.isArray(raw)) {
    return [];
  }
  return Array.from(
    new Set(
      raw
        .map((entry) => readManifestAssetUrl(entry))
        .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
        .map((entry) => resolveAssetUrl(entry, baseUrl))
        .filter((entry) => entry.length > 0)
    )
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Synchronous URL-heuristic stylesheet filter
// (used inside useMemo / sync contexts where fetch is not possible)
// ---------------------------------------------------------------------------

/**
 * Applies a URL-heuristic-only classification to each href.
 * Returns only hrefs that are NOT classified as "block".
 * This is the sync version — no fetch, suitable for use inside useMemo.
 *
 * @param hrefs      - Raw href list from the source asset manifest.
 * @param runtimeSrc - Host's Tailwind runtime src (blocked if present).
 */
export function filterSourceStylesheetsByUrl(hrefs: string[], runtimeSrc?: string): string[] {
  const additionalPatterns: string[] = [];
  if (runtimeSrc) {
    const path = runtimeSrc.replace(/^https?:\/\/[^/]+/, "").split("?")[0]?.trim() ?? "";
    if (path.length > 0) {
      additionalPatterns.push(path);
    } else {
      const origin = runtimeSrc.replace(/^https?:\/\//, "").split("/")[0]?.trim() ?? "";
      if (origin.length > 0) {
        additionalPatterns.push(origin);
      }
    }
  }
  return hrefs.filter((href) => classifyStylesheetHref(href, additionalPatterns) === "allow");
}

// ---------------------------------------------------------------------------
// Step 1 — Async content-inspection stylesheet filter
// (for use in async effects, not in render/useMemo paths)
// ---------------------------------------------------------------------------

/**
 * Classifiers for fetched CSS content.
 * Returns "baseline" if the CSS declares custom properties, :root blocks, or
 * @font-face rules — these are essential for preserving source fidelity.
 * Returns "redundant" if it reads like a compiled Tailwind output bundle.
 * Returns "skip" on CORS/network error.
 */
export async function inspectStylesheetContent(
  href: string
): Promise<"baseline" | "redundant" | "skip"> {
  try {
    const response = await fetch(href, { mode: "cors", cache: "no-store" });
    if (!response.ok) {
      return "skip";
    }
    const text = await response.text();

    // Baseline indicators: CSS custom properties or @font-face
    const hasCustomProperties = /--[\w-]+\s*:/i.test(text);
    const hasFontFace = /@font-face\s*\{/i.test(text);
    const hasRootBlock = /:root\s*\{/i.test(text);
    if (hasCustomProperties || hasFontFace || hasRootBlock) {
      return "baseline";
    }

    // Redundant: compiled Tailwind output — high density of utility class definitions
    const utilityClassDensity =
      (text.match(/\.(bg-|text-|flex|grid|px-|py-|md:|lg:|w-|h-|p-|m-|rounded)/g) ?? []).length;
    const redundancyThreshold = 50; // arbitrary threshold; tunable
    if (utilityClassDensity > redundancyThreshold) {
      return "redundant";
    }

    // If we fetched it and it's not identifiably redundant, treat as baseline
    return "baseline";
  } catch {
    return "skip";
  }
}

/**
 * Async version of the stylesheet filter. Uses URL heuristics first, then
 * fetches "unknown" hrefs to inspect their content.
 * Returns only hrefs that should be forwarded to the target preview.
 *
 * @param hrefs      - Raw href list from the source asset manifest.
 * @param runtimeSrc - Host's Tailwind runtime src (blocked if present).
 */
export async function filterSourceStylesheets(
  hrefs: string[],
  runtimeSrc?: string
): Promise<string[]> {
  const additionalPatterns: string[] = runtimeSrc
    ? [runtimeSrc.replace(/^https?:\/\/[^/]+/, "").split("?")[0] ?? ""]
    : [];

  const results: string[] = [];

  await Promise.all(
    hrefs.map(async (href) => {
      const urlClassification = classifyStylesheetHref(href, additionalPatterns);
      if (urlClassification === "block") {
        // Blocked by URL heuristic — skip
        return;
      }
      // URL is allowed — inspect content to confirm it's baseline (not redundant)
      const contentClassification = await inspectStylesheetContent(href);
      if (contentClassification === "baseline") {
        results.push(href);
      }
    })
  );

  return results;
}

// ---------------------------------------------------------------------------
// Step 1+2+3 — resolveProposalTargetPreviewHtml (updated)
// ---------------------------------------------------------------------------

/**
 * Builds the target preview HTML for a single block proposal.
 *
 * Compared to the original in import/page.tsx, this version:
 * - Accepts `importMaster` to derive filtered source stylesheets (Step 1).
 * - Extracts the source Tailwind config from importMaster.sourceHtml (Step 2).
 * - Passes both to buildPlatformBlockPreviewDocument (Step 3).
 *
 * The sync URL-heuristic filter is used here (no fetch in render path).
 * The caller is responsible for passing an importMaster with sourceHtml
 * populated if Tailwind config extraction is desired.
 */
export function resolveProposalTargetPreviewHtml(params: {
  proposalHtml: string;
  persistedTargetPreviewHtml?: string | null;
  theme: StudioTheme | null;
  hostAssets: PlatformPreviewAssets;
  importMaster?: StudioImportMaster | null;
}): string {
  const proposalHtml =
    params.proposalHtml ||
    params.persistedTargetPreviewHtml ||
    "<section></section>";

  // Step 1: derive filtered stylesheet hrefs (sync URL-heuristic only)
  const rawStylesheets = readManifestAssetList(
    params.importMaster?.sourceAssetManifest,
    "stylesheets",
    params.importMaster?.sourceBaseUrl
  );
  const runtimeSrc = params.hostAssets.platformCssSrc;
  const additionalStylesheetHrefs = filterSourceStylesheetsByUrl(rawStylesheets, runtimeSrc);

  // Step 2: extract source Tailwind config from the import master's source HTML
  const sourceTailwindConfig = extractSourceTailwindConfig(
    params.importMaster?.sourceHtml ?? ""
  );

  // Step 3: thread both through the document builder
  return buildPlatformBlockPreviewDocument({
    proposalHtml,
    theme: params.theme,
    hostAssets: params.hostAssets,
    additionalStylesheetHrefs,
    sourceTailwindConfig
  });
}
