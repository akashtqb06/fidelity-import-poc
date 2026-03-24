/**
 * platform-preview-shared.ts — POC Edition (CDN-Free Target)
 *
 * Implements all three fidelity POC steps:
 *   Step 1: Selective stylesheet forwarding (classifyStylesheetHref + selective sanitizeTargetHtml)
 *   Step 2: Source config extraction + canonical CSS variable block injection
 *   Step 3: buildPlatformTargetDocument — CDN in source preview is fine;
 *            target preview uses app's compiled platform.css + CSS var override (no CDN).
 *
 * Architecture:
 *   Source iframe  → raw imported HTML (CDN Tailwind OK — this shows "as-imported" fidelity)
 *   Target iframe  → <link href="{platformCssSrc}"> + <style id="lmnas-canonical-vars"> at end of body
 *
 * The CSS cascade in the target:
 *   1. Forwarded source <link> stylesheets  (fonts, source CSS vars, resets)
 *   2. Platform compiled CSS               (all Tailwind utilities + default @theme vars)
 *   3. <style id="lmnas-canonical-vars">   (canonical token override — LAST, always wins)
 */

import type { PlatformPreviewAssets, StudioTheme } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Substrings whose presence in a stylesheet href means the sheet should be
 * blocked (excluded) from the target preview. This list covers:
 * - The Tailwind CDN (all variant URLs)
 * - The @tailwindcss/browser ESM build
 * - The LMNAs studio-runtime injected sheet
 *
 * The default policy is: PRESERVE unless the href matches one of these.
 */
export const TAILWIND_CDN_BLOCKLIST_PATTERNS: readonly string[] = [
  "cdn.tailwindcss.com",
  "@tailwindcss/browser",
  "tailwindcss.com",
  // Cover compiled tailwind output filenames commonly used in build artefacts
  "tailwind.min.css",
  "tailwind.css",
  "studio-runtime.css",
  "lmnas-preview-runtime"
] as const;

/**
 * Known Tailwind first-party plugin names (v4 compatible).
 * Used for theme debt detection — if a source component requires a plugin
 * listed here, it is pre-compiled into the platform CSS via @plugin.
 * Unknown plugin names not in this set are flagged as theme debt.
 */
export const KNOWN_TAILWIND_PLUGINS: ReadonlySet<string> = new Set([
  "typography",
  "forms",
  "container-queries",
  "aspect-ratio"
]);

// ---------------------------------------------------------------------------
// Step 1 helpers — stylesheet classification
// ---------------------------------------------------------------------------

/**
 * Classifies a single stylesheet href as "allow" or "block" for the target
 * preview. The policy is allow-by-default: only block when the href matches
 * a CDN/runtime pattern or the caller-supplied additional patterns.
 *
 * @param href               - The href attribute value of the <link> tag.
 * @param additionalPatterns - Extra substrings to treat as block-triggers
 *                             (e.g. the host's own platformCssSrc path).
 */
export function classifyStylesheetHref(
  href: string,
  additionalPatterns: readonly string[] = []
): "allow" | "block" {
  const normalized = href.toLowerCase().trim();
  const allPatterns: readonly string[] = [...TAILWIND_CDN_BLOCKLIST_PATTERNS, ...additionalPatterns];
  // Guard: skip empty patterns — an empty string matches every href via .includes("")
  const isBlocked = allPatterns.some(
    (pattern) => pattern.trim().length > 0 && normalized.includes(pattern.toLowerCase().trim())
  );
  return isBlocked ? "block" : "allow";
}

// ---------------------------------------------------------------------------
// Step 2 helpers — Tailwind config extraction
// ---------------------------------------------------------------------------

/**
 * Extracts a source component's Tailwind config from raw HTML.
 *
 * Detection strategy (in priority order):
 *   1. <script id="tailwind-config">{ … }</script>
 *   2. <script id="lmnas-tailwind-runtime-config">…</script>
 *   3. Inline window.tailwind.config = { … }
 *   4. Inline tailwind.config = { … }
 *
 * The object literal is evaluated via Function constructor (sandboxed).
 * Returns {} on any extraction or evaluation failure — never throws.
 *
 * Constraints:
 * - Generic: does not assume any specific color names, token keys, or plugins.
 * - No hardcoded design values are emitted by this function.
 */
export function extractSourceTailwindConfig(html: string): Record<string, unknown> {
  if (!html || html.trim().length === 0) {
    return {};
  }

  // Strategy 1 & 2: named script id blocks
  const idPatterns = [
    /id=["']tailwind-config["'][^>]*>([\s\S]*?)<\/script>/i,
    /id=["']lmnas-tailwind-runtime-config["'][^>]*>([\s\S]*?)<\/script>/i,
    /id=["']lmnas-preview-tailwind-config["'][^>]*>([\s\S]*?)<\/script>/i
  ];

  for (const pattern of idPatterns) {
    const match = pattern.exec(html);
    if (match?.[1]) {
      const result = evalObjectLiteral(match[1].trim());
      if (result !== null) {
        return result;
      }
    }
  }

  // Strategy 3: window.tailwind.config = { … }
  const windowConfigMatch =
    /window\.tailwind(?:\.config)?\s*=\s*window\.tailwind(?:\.config)?\s*\|\|\s*\{\s*\};\s*window\.tailwind\.config\s*=\s*(\{[\s\S]*?\});/i.exec(html) ??
    /window\.tailwind\.config\s*=\s*(\{[\s\S]*?\});/i.exec(html);
  if (windowConfigMatch?.[1]) {
    const result = evalObjectLiteral(windowConfigMatch[1].trim());
    if (result !== null) {
      return result;
    }
  }

  // Strategy 4: tailwind.config = { … }
  const plainConfigMatch = /(?:^|[;\n])[ \t]*tailwind\.config\s*=\s*(\{[\s\S]*?\});/im.exec(html);
  if (plainConfigMatch?.[1]) {
    const result = evalObjectLiteral(plainConfigMatch[1].trim());
    if (result !== null) {
      return result;
    }
  }

  return {};
}

/**
 * Safely evaluates a JS object literal string.
 * Returns null if evaluation fails for any reason.
 */
function evalObjectLiteral(literal: string): Record<string, unknown> | null {
  try {
    // eslint-disable-next-line no-new-func
    const value = new Function(`"use strict"; return (${literal})`)() as unknown;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal theme token helpers
// ---------------------------------------------------------------------------

function themeTokenValue(
  theme: StudioTheme | null,
  matchers: string[],
  fallback: string,
  fallbackColorIndex?: number
): string {
  if (!theme) {
    return fallback;
  }

  const exactMatch = theme.tokens.find((token) =>
    matchers.some((matcher) => token.key.toLowerCase().includes(matcher))
  );
  if (typeof exactMatch?.value === "string" && exactMatch.value.trim().length > 0) {
    return exactMatch.value.trim();
  }

  if (typeof fallbackColorIndex === "number") {
    const colorTokens = theme.tokens.filter(
      (token) => token.category === "color" && token.value.trim().length > 0
    );
    const fallbackToken = colorTokens[fallbackColorIndex] ?? colorTokens[0];
    if (fallbackToken) {
      return fallbackToken.value.trim();
    }
  }

  return fallback;
}

function fontFamilyArray(theme: StudioTheme | null): string[] {
  const raw = themeTokenValue(
    theme,
    ["font-display", "typography.font.1", "font"],
    "Manrope, sans-serif"
  );
  return raw
    .split(",")
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""))
    .filter((entry) => entry.length > 0);
}

// ---------------------------------------------------------------------------
// Step 2 — canonical CSS variables block
// ---------------------------------------------------------------------------

/**
 * Builds the canonical CSS variable override block for the target preview.
 *
 * Returns a <style id="lmnas-canonical-vars"> block that re-declares all
 * StudioTheme token CSS variables. This is injected at the END of the target
 * <body> so it is last in the document cascade and always overrides any
 * source :root declarations.
 *
 * Uses Tailwind v4 --color-* naming convention so platform utility classes
 * (bg-primary, text-foreground-light, etc.) pick up the overridden values.
 *
 * Replaces the old window.tailwind.config injection — no CDN, no JS runtime.
 *
 * @param theme - Canonical StudioTheme. If null, returns empty string.
 */
export function buildCanonicalCssVarsBlock(theme: StudioTheme | null): string {
  if (!theme || theme.tokens.length === 0) {
    return "";
  }

  const declarations = theme.tokens
    .map((token) => {
      const rawVar = token.cssVariable.startsWith("--") ? token.cssVariable : `--${token.cssVariable}`;
      // Map token CSS variables to Tailwind v4 --color-* / --font-family-* namespace
      // so that compiled utility classes (bg-primary, text-foreground-light, etc.)
      // pick up the overridden values via var(--color-primary) etc.
      const twVar = toTailwindVar(rawVar, token.category);
      return `${twVar}:${token.value};`;
    })
    .join("");

  return `<style id="lmnas-canonical-vars">:root{${declarations}}</style>`;
}

/**
 * Maps a token CSS variable to its Tailwind v4 equivalent namespace.
 * Tailwind v4 generates utility classes from --color-* and --font-family-* variables.
 */
function toTailwindVar(cssVar: string, category: string): string {
  const name = cssVar.replace(/^--/, "");
  if (category === "color") {
    // Already namespaced → use as-is; else add --color- prefix
    if (name.startsWith("color-")) return `--${name}`;
    return `--color-${name}`;
  }
  if (category === "typography") {
    if (name.startsWith("font-family-") || name.startsWith("font-")) return `--font-family-${name.replace(/^font-family-|^font-/, "")}`;
    return `--${name}`;
  }
  return `--${name}`;
}

/**
 * Builds the raw CSS variable declarations string (for the <style> block in head).
 * Used for inline style blocks that need the bare var declarations without the
 * canonical override semantics.
 */
function buildThemeCssVars(theme: StudioTheme | null): string {
  if (!theme || theme.tokens.length === 0) {
    return "";
  }
  return theme.tokens
    .map((token) => {
      const variable = token.cssVariable.startsWith("--")
        ? token.cssVariable
        : `--${token.cssVariable}`;
      return `${variable}:${token.value};`;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Existing shared helpers (preserved from original)
// ---------------------------------------------------------------------------

function stripPreviewRuntime(html: string): string {
  return html
    .replace(
      /<script\b[^>]*src=["'][^"']*(?:cdn\.tailwindcss\.com|@tailwindcss\/browser)[^"']*["'][^>]*>\s*<\/script>/gi,
      ""
    )
    .replace(
      /<script\b[^>]*id=["'](?:tailwind-config|lmnas-tailwind-runtime-config|lmnas-preview-tailwind-config)[^"']*["'][^>]*>[\s\S]*?<\/script>/gi,
      ""
    )
    .replace(/<script\b[^>]*>[\s\S]*?tailwind\.config\s*=[\s\S]*?<\/script>/gi, "");
}

export function ensureHtmlDocument(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return "<!doctype html><html><head></head><body></body></html>";
  }
  if (/<html[\s>]/i.test(trimmed)) {
    return trimmed;
  }
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body>${trimmed}</body></html>`;
}

export function extractBodyHtml(input: string): string {
  const bodyMatch = input.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (typeof bodyMatch?.[1] === "string") {
    return bodyMatch[1];
  }
  return input;
}

// ---------------------------------------------------------------------------
// Step 1 — Selective sanitizeTargetHtml
// ---------------------------------------------------------------------------

/**
 * Sanitizes imported HTML for use in the target preview.
 *
 * Replaces the previous strip-all regex with a selective version:
 * - Only strips <link rel="stylesheet"> tags whose href is classified as "block".
 * - Preserves all other stylesheet links (baseline resets, CSS-variable sheets, etc.)
 * - Also strips preview runtime scripts (Tailwind CDN, tailwind.config scripts).
 *
 * @param input      - Raw imported HTML string.
 * @param runtimeSrc - The host's own platform CSS src (added to block patterns).
 */
export function sanitizeTargetHtml(input: string, runtimeSrc?: string): string {
  const runtimePatterns: string[] = [];
  if (runtimeSrc) {
    const runtimePath = runtimeSrc.replace(/^https?:\/\/[^/]+/, "").split("?")[0]?.trim() ?? "";
    if (runtimePath.length > 0) {
      runtimePatterns.push(runtimePath);
    } else {
      // If no path component (e.g. bare CDN domain), use the full origin instead
      const runtimeOrigin = runtimeSrc.replace(/^https?:\/\//, "").split("/")[0]?.trim() ?? "";
      if (runtimeOrigin.length > 0) {
        runtimePatterns.push(runtimeOrigin);
      }
    }
  }

  // Strip runtime scripts first (Tailwind CDN scripts, tailwind.config scripts)
  const runtimeStripped = stripPreviewRuntime(input);

  // Selectively strip only blocked stylesheets, preserve allowed ones
  const selectivelyStripped = runtimeStripped.replace(
    /<link([^>]+)rel=["'][^"']*stylesheet[^"']*["']([^>]*)>/gi,
    (fullMatch, before: string, after: string) => {
      // Extract href from attribute string (href may appear before or after rel)
      const hrefMatch = /href=["']([^"']+)["']/i.exec(before + " " + after);
      if (!hrefMatch?.[1]) {
        // No href → strip (defensive)
        return "";
      }
      const href = hrefMatch[1];
      const classification = classifyStylesheetHref(href, runtimePatterns);
      return classification === "block" ? "" : fullMatch;
    }
  );

  // Extract body content for the preview fragment
  return extractBodyHtml(ensureHtmlDocument(selectivelyStripped));
}

function toPreviewBodyHtml(input: string): string {
  if (input.trim().length === 0) {
    return "";
  }
  return sanitizeTargetHtml(input);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a PlatformPreviewAssets object pointing to the Vite dev server CSS.
 * In production, pass the CDN/origin URL of the compiled platform CSS.
 *
 * @param origin - The app's origin (e.g. "http://localhost:5173"). Defaults to Vite dev server.
 */
export function createStaticPlatformPreviewAssets(origin?: string): PlatformPreviewAssets {
  const base = origin ? origin.replace(/\/$/, "") : "http://localhost:5173";
  return {
    platformCssSrc: `${base}/src/style.css`,
    headMarkup: ""
  };
}

// ---------------------------------------------------------------------------
// Step 3 — buildPlatformTargetDocument (CDN-Free)
// ---------------------------------------------------------------------------

/**
 * Detects theme debt from source plugins — logs warnings for unknown plugins.
 * Known plugins are pre-compiled into the platform CSS via @plugin.
 * No CDN script injection.
 */
function detectPluginThemeDebt(sourcePlugins: unknown[]): void {
  for (const plugin of sourcePlugins) {
    if (typeof plugin === "string" && !KNOWN_TAILWIND_PLUGINS.has(plugin)) {
      console.warn(
        `[LMNAs Import POC] Theme debt: unknown Tailwind plugin "${plugin}" ` +
          `is not pre-compiled into the platform CSS. ` +
          `Add @plugin "${plugin}" to src/style.css to resolve.`
      );
    }
  }
}

/**
 * Builds a complete HTML document for the target (right) preview iframe.
 *
 * CDN-Free approach:
 * - Links to the app's compiled platform CSS (Tailwind v4 compiled utilities + default tokens).
 * - Injects forwarded source stylesheets BEFORE the platform CSS (so platform @theme vars override).
 * - Injects <style id="lmnas-canonical-vars"> at the END of <body> — last in cascade,
 *   so canonical StudioTheme tokens always win over any source :root declarations.
 * - NO cdn.tailwindcss.com script, NO window.tailwind.config.
 *
 * CSS cascade in target iframe:
 *   [forwarded source links] → [platform CSS with @theme defaults] → [canonical vars override]
 */
export function buildPlatformTargetDocument(params: {
  bodyHtml: string;
  theme: StudioTheme | null;
  hostAssets: PlatformPreviewAssets;
  beforeBodyHtml?: string;
  afterBodyHtml?: string;
  additionalStylesheetHrefs?: string[];
  sourceTailwindConfig?: Record<string, unknown>;
}): string {
  const htmlClass = params.theme?.darkMode ? "dark" : "";

  // ── Plugin theme debt detection (no CDN injection — plugins must be in platform CSS) ─
  const sourceTailwindConfig = params.sourceTailwindConfig ?? {};
  const sourcePlugins: unknown[] = Array.isArray(sourceTailwindConfig["plugins"])
    ? (sourceTailwindConfig["plugins"] as unknown[])
    : [];
  detectPluginThemeDebt(sourcePlugins);

  // ── Prepare body fragments ────────────────────────────────────────────────
  const cleanedBodyHtml = stripPreviewRuntime(params.bodyHtml);
  const cleanedBeforeBodyHtml = params.beforeBodyHtml
    ? toPreviewBodyHtml(params.beforeBodyHtml)
    : "";
  const cleanedAfterBodyHtml = params.afterBodyHtml
    ? toPreviewBodyHtml(params.afterBodyHtml)
    : "";

  // ── Forwarded source stylesheets ──────────────────────────────────────────
  // These come BEFORE the platform CSS so source vars are lower-priority,
  // and the canonical override at end of body is the final authority.
  const additionalStylesheets = Array.from(
    new Set(
      (params.additionalStylesheetHrefs ?? [])
        .filter((href): href is string => typeof href === "string" && href.trim().length > 0)
        .map((href) => href.trim())
    )
  )
    .map((href) => `<link rel="stylesheet" href="${href}">`)
    .join("");

  // ── Canonical CSS vars block — injected at end of body ────────────────────
  // Last in document order → wins over any source :root declarations.
  const canonicalVarsBlock = buildCanonicalCssVarsBlock(params.theme);

  // ── Small inline style for structural (non-theme) rules ───────────────────
  const cssVars = buildThemeCssVars(params.theme);
  const structuralStyle = [
    `<style>`,
    cssVars ? `:root{${cssVars}}` : "",
    `html,body{margin:0;padding:0;min-height:100%}`,
    `.lmnas-preview-shell{display:block}`,
    `.lmnas-target-main{display:block}`,
    `</style>`
  ].join("");

  return [
    `<!doctype html><html class="${htmlClass}" lang="en"><head>`,
    `<meta charset="utf-8"/>`,
    `<meta name="viewport" content="width=device-width,initial-scale=1"/>`,
    params.hostAssets.headMarkup,
    // 1. Forwarded source stylesheets (fonts, source CSS vars) before platform CSS
    additionalStylesheets,
    // 2. Structural style (layout, non-theme)
    structuralStyle,
    // 3. Platform compiled CSS last in head — canonical @theme defaults
    `<link rel="stylesheet" href="${params.hostAssets.platformCssSrc}">`,
    `</head>`,
    // body — uses Tailwind v4 utility classes from compiled platform CSS
    `<body class="bg-background-light text-foreground-light dark:bg-background-dark dark:text-foreground-dark font-display antialiased">`,
    cleanedBeforeBodyHtml
      ? `<div class="lmnas-preview-shell">${cleanedBeforeBodyHtml}</div>`
      : "",
    cleanedBodyHtml,
    cleanedAfterBodyHtml
      ? `<div class="lmnas-preview-shell">${cleanedAfterBodyHtml}</div>`
      : "",
    // 4. Canonical vars override at very end of body — always wins
    canonicalVarsBlock,
    `</body></html>`
  ].join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Step 3 — buildPlatformBlockPreviewDocument (updated signature)
// ---------------------------------------------------------------------------

/**
 * Builds an HTML document for a single block proposal in the target preview.
 *
 * Step 1: accepts additionalStylesheetHrefs (filtered source stylesheets).
 * Step 2+3: accepts sourceTailwindConfig (extracted from import payload);
 *           used for plugin theme debt detection.
 */
export function buildPlatformBlockPreviewDocument(params: {
  proposalHtml: string;
  theme: StudioTheme | null;
  hostAssets: PlatformPreviewAssets;
  additionalStylesheetHrefs?: string[];
  sourceTailwindConfig?: Record<string, unknown>;
}): string {
  const proposalBody = toPreviewBodyHtml(params.proposalHtml);
  return buildPlatformTargetDocument({
    bodyHtml:
      proposalBody.length > 0
        ? `<main class="lmnas-target-main">${proposalBody}</main>`
        : "<main></main>",
    theme: params.theme,
    hostAssets: params.hostAssets,
    additionalStylesheetHrefs: params.additionalStylesheetHrefs,
    sourceTailwindConfig: params.sourceTailwindConfig
  });
}

// Re-export isRecord for helpers that use it
export { isRecord };
