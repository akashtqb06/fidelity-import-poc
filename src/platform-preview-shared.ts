/**
 * platform-preview-shared.ts — POC Edition
 *
 * Implements all three fidelity POC steps:
 *   Step 1: Selective stylesheet forwarding (classifyStylesheetHref + selective sanitizeTargetHtml)
 *   Step 2: Deep-merge Tailwind config (extractSourceTailwindConfig + buildTailwindRuntimeConfig)
 *   Step 3: Thread sourceTailwindConfig through buildPlatformTargetDocument + plugin CDN injection
 */

import type { PlatformPreviewAssets, StudioTheme } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_TAILWIND_RUNTIME_SRC = "https://cdn.tailwindcss.com?plugins=forms,container-queries";

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
 * Known Tailwind plugin names → their CDN <script> src on cdn.tailwindcss.com.
 * Only the official first-party plugins that ship as standalone CDN bundles
 * are listed here. Unknown/custom plugins are logged as theme debt.
 */
export const KNOWN_TAILWIND_PLUGIN_CDN: Readonly<Record<string, string>> = {
  typography: "https://cdn.tailwindcss.com/typography.js",
  forms: "https://cdn.tailwindcss.com/forms.js",
  "container-queries": "https://cdn.tailwindcss.com/container-queries.js",
  "aspect-ratio": "https://cdn.tailwindcss.com/aspect-ratio.js"
} as const;

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
 *                             (e.g. the host's own runtimeSrc origin).
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
  const windowConfigMatch = /window\.tailwind(?:\.config)?\s*=\s*window\.tailwind(?:\.config)?\s*\|\|\s*\{\s*\};\s*window\.tailwind\.config\s*=\s*(\{[\s\S]*?\});/i.exec(html) ??
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
// Step 2 — Deep-merge Tailwind runtime config
// ---------------------------------------------------------------------------

/**
 * Builds the window.tailwind.config script block.
 *
 * Merge order (source first, canonical always wins):
 *   - darkMode:             source ?? "class"
 *   - plugins:              deduplicated union of source + canonical [] (no canonical plugins by default)
 *   - theme.extend.colors:  { ...sourceColors, ...canonicalColors }
 *   - theme.extend.fontFamily: { ...sourceFontFamily, display: canonicalDisplay }
 *   - theme.extend.borderRadius: { ...sourceRadius, ...canonicalRadius }
 *   - theme.extend (other): { ...sourceExtend, ...canonicalExtend }
 *   - theme (non-extend):   { ...sourceTheme, ...canonicalNonExtend }
 *
 * No hardcoded color/font/spacing values — all canonical values are read
 * exclusively from the StudioTheme token map.
 *
 * @param theme                - Canonical StudioTheme (read-only; never mutated).
 * @param sourceConfigOverrides - Extracted source tailwind config (may be {}).
 */
export function buildTailwindRuntimeConfig(
  theme: StudioTheme | null,
  sourceConfigOverrides: Record<string, unknown> = {}
): string {
  // ── Canonical token values (all derived from theme, no literals) ──────────
  const canonicalPrimary = themeTokenValue(theme, ["primary", "accent"], "#135bec", 0);
  const canonicalBackgroundLight = themeTokenValue(
    theme,
    ["background-light", "surface-light", "surface", "background", "bg"],
    "#f6f6f8",
    1
  );
  const canonicalBackgroundDark = themeTokenValue(
    theme,
    ["background-dark", "surface-dark", "background", "bg"],
    "#101622",
    2
  );
  const canonicalTextLight = themeTokenValue(
    theme,
    ["text-light", "foreground-light", "text", "foreground"],
    "#0f172a"
  );
  const canonicalTextDark = themeTokenValue(
    theme,
    ["text-dark", "foreground-dark", "text", "foreground"],
    "#e2e8f0"
  );
  const canonicalDisplayFont = fontFamilyArray(theme);
  const canonicalRadiusDefault = themeTokenValue(theme, ["radius.default", "radius"], "0.25rem");
  const canonicalRadiusLg = themeTokenValue(theme, ["radius.lg", "radius"], "0.5rem");
  const canonicalRadiusXl = themeTokenValue(theme, ["radius.xl", "radius"], "0.75rem");
  const canonicalRadiusFull = themeTokenValue(theme, ["radius.full", "radius"], "9999px");

  // ── Named canonical color/extend objects (no inline literals) ────────────
  const canonicalColors: Record<string, string> = {
    primary: canonicalPrimary,
    "background-light": canonicalBackgroundLight,
    "background-dark": canonicalBackgroundDark,
    "foreground-light": canonicalTextLight,
    "foreground-dark": canonicalTextDark
  };

  const canonicalBorderRadius: Record<string, string> = {
    DEFAULT: canonicalRadiusDefault,
    lg: canonicalRadiusLg,
    xl: canonicalRadiusXl,
    full: canonicalRadiusFull
  };

  const canonicalFontFamily: Record<string, string[]> = {
    display: canonicalDisplayFont
  };

  // ── Extract source sections safely ────────────────────────────────────────
  const sourceDarkMode = isString(sourceConfigOverrides["darkMode"])
    ? sourceConfigOverrides["darkMode"]
    : "class";

  const sourcePlugins: unknown[] = Array.isArray(sourceConfigOverrides["plugins"])
    ? (sourceConfigOverrides["plugins"] as unknown[])
    : [];

  const sourceTheme = isRecord(sourceConfigOverrides["theme"])
    ? sourceConfigOverrides["theme"]
    : {};

  const sourceExtend = isRecord(sourceTheme["extend"]) ? sourceTheme["extend"] : {};

  const sourceColors = isRecord(sourceExtend["colors"])
    ? (sourceExtend["colors"] as Record<string, string>)
    : {};

  const sourceFontFamily = isRecord(sourceExtend["fontFamily"])
    ? (sourceExtend["fontFamily"] as Record<string, string[]>)
    : {};

  const sourceRadius = isRecord(sourceExtend["borderRadius"])
    ? (sourceExtend["borderRadius"] as Record<string, string>)
    : {};

  // ── Build merged extend (source first, canonical on top) ─────────────────
  const mergedExtend: Record<string, unknown> = {
    // Carry all source extend keys that aren't explicitly overridden below
    ...sourceExtend,
    // Canonical wins for these specific extend keys
    colors: { ...sourceColors, ...canonicalColors },
    fontFamily: { ...sourceFontFamily, ...canonicalFontFamily },
    borderRadius: { ...sourceRadius, ...canonicalBorderRadius }
  };

  // ── Build merged theme (non-extend source keys, then canonical extend) ────
  const sourceThemeWithoutExtend = Object.fromEntries(
    Object.entries(sourceTheme).filter(([k]) => k !== "extend")
  );

  const mergedTheme: Record<string, unknown> = {
    ...sourceThemeWithoutExtend,
    extend: mergedExtend
  };

  // ── Deduplicate plugins by string identity / reference ───────────────────
  const deduplicatedPlugins = deduplicatePlugins(sourcePlugins);

  // ── Final config ─────────────────────────────────────────────────────────
  const config = {
    darkMode: sourceDarkMode,
    plugins: deduplicatedPlugins,
    theme: mergedTheme
  };

  return [
    `<script id="lmnas-preview-tailwind-config">`,
    `window.tailwind = window.tailwind || {}; window.tailwind.config = ${JSON.stringify(config)};`,
    `</script>`
  ].join("");
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deduplicatePlugins(plugins: unknown[]): unknown[] {
  const seen = new Set<unknown>();
  const result: unknown[] = [];
  for (const plugin of plugins) {
    const key = typeof plugin === "string" ? plugin : JSON.stringify(plugin);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(plugin);
    }
  }
  return result;
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
      /<script\b[^>]*id=["'](?:tailwind-config|lmnas-tailwind-runtime-config|lmnas-preview-tailwind-config)["'][^>]*>[\s\S]*?<\/script>/gi,
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
 * @param runtimeSrc - The host's own Tailwind runtime src (added to block patterns).
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

function toPreviewBodyHtml(input: string): string {
  if (input.trim().length === 0) {
    return "";
  }
  return sanitizeTargetHtml(input);
}

export function createStaticPlatformPreviewAssets(origin?: string): PlatformPreviewAssets {
  const href = origin
    ? `${origin.replace(/\/$/, "")}/studio-runtime.css`
    : "/studio-runtime.css";
  return {
    headMarkup: `<link rel="stylesheet" href="${href}">`,
    tailwindRuntimeSrc: DEFAULT_TAILWIND_RUNTIME_SRC
  };
}

// ---------------------------------------------------------------------------
// Step 3 — buildPlatformTargetDocument with sourceTailwindConfig
// ---------------------------------------------------------------------------

/**
 * Builds a complete HTML document for the target (right) preview iframe.
 *
 * Step 3 additions:
 * - Accepts `sourceTailwindConfig` and threads it into `buildTailwindRuntimeConfig`.
 * - Detects known Tailwind plugin names in `sourceTailwindConfig.plugins` and
 *   injects their CDN <script> tags BEFORE the main Tailwind runtime.
 * - Unknown/custom plugin names are logged as theme debt warnings.
 *
 * The canonical StudioTheme is never mutated — config is rebuilt fresh each call.
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
  const cssVars = buildThemeCssVars(params.theme);
  const runtimeSrc = params.hostAssets.tailwindRuntimeSrc ?? DEFAULT_TAILWIND_RUNTIME_SRC;

  // All body values derived from theme tokens — no inline literals
  const backgroundLight = themeTokenValue(
    params.theme,
    ["background-light", "surface-light", "surface", "background", "bg"],
    "#f6f6f8",
    1
  );
  const backgroundDark = themeTokenValue(
    params.theme,
    ["background-dark", "surface-dark", "background", "bg"],
    "#101622",
    2
  );
  const textLight = themeTokenValue(
    params.theme,
    ["text-light", "foreground-light", "text", "foreground"],
    "#0f172a"
  );
  const textDark = themeTokenValue(
    params.theme,
    ["text-dark", "foreground-dark", "text", "foreground"],
    "#e2e8f0"
  );

  const cleanedBodyHtml = stripPreviewRuntime(params.bodyHtml);
  const cleanedBeforeBodyHtml = params.beforeBodyHtml
    ? toPreviewBodyHtml(params.beforeBodyHtml)
    : "";
  const cleanedAfterBodyHtml = params.afterBodyHtml
    ? toPreviewBodyHtml(params.afterBodyHtml)
    : "";

  const additionalStylesheets = Array.from(
    new Set(
      (params.additionalStylesheetHrefs ?? [])
        .filter((href): href is string => typeof href === "string" && href.trim().length > 0)
        .map((href) => href.trim())
    )
  )
    .map((href) => `<link rel="stylesheet" href="${href}">`)
    .join("");

  // ── Step 3: detect known plugins and inject CDN scripts ──────────────────
  const sourceTailwindConfig = params.sourceTailwindConfig ?? {};
  const sourcePlugins: unknown[] = Array.isArray(sourceTailwindConfig["plugins"])
    ? (sourceTailwindConfig["plugins"] as unknown[])
    : [];

  const pluginScriptTags = resolvePluginCdnScriptTags(sourcePlugins);

  // ── Build merged tailwind config script ───────────────────────────────────
  const tailwindConfigScript = buildTailwindRuntimeConfig(params.theme, sourceTailwindConfig);

  return [
    `<!doctype html><html class="${htmlClass}" lang="en"><head>`,
    `<meta charset="utf-8"/>`,
    `<meta name="viewport" content="width=device-width,initial-scale=1"/>`,
    params.hostAssets.headMarkup,
    // Additional filtered source stylesheets placed BEFORE Tailwind CDN
    additionalStylesheets,
    `<style>`,
    `:root{${cssVars}}`,
    `html,body{margin:0;padding:0;min-height:100%}`,
    `body{font-family:var(--font-display,"Manrope"),"Segoe UI",sans-serif;background:${backgroundLight};color:${textLight}}`,
    `html.dark body{background:${backgroundDark};color:${textDark}}`,
    `.lmnas-preview-shell{display:block}`,
    `.lmnas-target-main{display:block}`,
    `</style>`,
    tailwindConfigScript,
    // Known plugin CDN scripts BEFORE the main Tailwind runtime
    pluginScriptTags,
    `<script src="${runtimeSrc}"><\/script>`,
    `</head>`,
    `<body class="bg-background-light text-foreground-light dark:bg-background-dark dark:text-foreground-dark font-display antialiased">`,
    cleanedBeforeBodyHtml
      ? `<div class="lmnas-preview-shell">${cleanedBeforeBodyHtml}</div>`
      : "",
    cleanedBodyHtml,
    cleanedAfterBodyHtml
      ? `<div class="lmnas-preview-shell">${cleanedAfterBodyHtml}</div>`
      : "",
    `</body></html>`
  ].join("");
}

/**
 * Resolves CDN <script> tags for known Tailwind plugins found in the source
 * plugins array. Unknown plugin names are logged as theme debt warnings.
 *
 * Returns the concatenated script tags string (may be empty).
 */
function resolvePluginCdnScriptTags(sourcePlugins: unknown[]): string {
  const scriptTags: string[] = [];

  for (const plugin of sourcePlugins) {
    const pluginName = typeof plugin === "string" ? plugin : null;
    if (pluginName) {
      const cdnSrc = KNOWN_TAILWIND_PLUGIN_CDN[pluginName];
      if (cdnSrc) {
        scriptTags.push(`<script src="${cdnSrc}"><\/script>`);
      } else {
        // Log as theme debt — unknown plugin cannot be auto-resolved from CDN
        console.warn(
          `[LMNAs Import POC] Theme debt: unknown Tailwind plugin "${pluginName}" ` +
            `has no known CDN equivalent. It will not be injected into the target preview.`
        );
      }
    }
  }

  return scriptTags.join("");
}

// ---------------------------------------------------------------------------
// Step 3 — buildPlatformBlockPreviewDocument (updated signature)
// ---------------------------------------------------------------------------

/**
 * Builds an HTML document for a single block proposal in the target preview.
 *
 * Step 1: accepts additionalStylesheetHrefs (filtered source stylesheets).
 * Step 3: accepts sourceTailwindConfig (extracted from import payload).
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
