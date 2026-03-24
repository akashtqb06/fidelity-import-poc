/**
 * platform-preview-shared.test.ts — Updated for CDN-Free Target (Vite + Tailwind v4)
 *
 * Step 1 tests (stylesheet classification) → UNCHANGED
 * Step 2 tests → buildCanonicalCssVarsBlock replaces buildTailwindRuntimeConfig
 * Step 3 tests → no CDN scripts; assert platformCssSrc link + canonical vars block
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import {
  classifyStylesheetHref,
  extractSourceTailwindConfig,
  buildCanonicalCssVarsBlock,
  buildPlatformBlockPreviewDocument,
  buildPlatformTargetDocument,
  createStaticPlatformPreviewAssets,
  sanitizeTargetHtml,
  TAILWIND_CDN_BLOCKLIST_PATTERNS,
  KNOWN_TAILWIND_PLUGINS
} from "./platform-preview-shared.js";
import {
  filterSourceStylesheetsByUrl,
  readManifestAssetList,
  resolveProposalTargetPreviewHtml
} from "./import-page-helpers.js";
import type { StudioTheme } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function buildTheme(overrides: Partial<StudioTheme> = {}): StudioTheme {
  return {
    id: "theme-sunrise",
    themeKey: "sunrise",
    name: "Sunrise",
    status: "active",
    sourceRef: "test",
    createdAt: "2026-03-23",
    updatedAt: "2026-03-23",
    tokenCoverage: 1,
    themeDebt: "none",
    darkMode: false,
    tokens: [
      { key: "primary",          label: "Primary",      category: "color",      value: "#ff4f00", cssVariable: "--color-primary",           mapped: true },
      { key: "background-light", label: "BG Light",     category: "color",      value: "#fff6e9", cssVariable: "--color-background-light",  mapped: true },
      { key: "background-dark",  label: "BG Dark",      category: "color",      value: "#1f0d05", cssVariable: "--color-background-dark",   mapped: true },
      { key: "foreground",       label: "Foreground",   category: "color",      value: "#2b1207", cssVariable: "--foreground",              mapped: true },
      { key: "font-display",     label: "Display Font", category: "typography", value: "Fraunces, serif", cssVariable: "--font-display",    mapped: true }
    ],
    ...overrides
  };
}

const PLATFORM_CSS = "http://localhost:5173/src/style.css";

// ---------------------------------------------------------------------------
// Existing pipeline tests (must continue passing)
// ---------------------------------------------------------------------------

describe("platform preview shared — existing pipeline", () => {
  it("builds block previews linking to the compiled platform CSS", () => {
    const html = buildPlatformBlockPreviewDocument({
      proposalHtml: `<section><h1>Hero</h1></section>`,
      theme: buildTheme(),
      hostAssets: createStaticPlatformPreviewAssets("http://localhost:5173")
    });

    expect(html).toContain(`href="${PLATFORM_CSS}"`);
    expect(html).toContain("lmnas-canonical-vars");
    expect(html).toContain("#ff4f00");
    expect(html).toContain("#fff6e9");
    expect(html).toContain("Fraunces");
    // NO CDN script
    expect(html).not.toContain("cdn.tailwindcss.com");
    expect(html).not.toContain("window.tailwind.config");
  });

  it("changes canonical vars when theme changes", () => {
    const assets = createStaticPlatformPreviewAssets("https://preview.example");
    const warmHtml = buildPlatformBlockPreviewDocument({
      proposalHtml: `<section><h1>Hero</h1></section>`,
      theme: buildTheme(),
      hostAssets: assets
    });
    const coolHtml = buildPlatformBlockPreviewDocument({
      proposalHtml: `<section><h1>Hero</h1></section>`,
      theme: buildTheme({
        id: "cool", themeKey: "cool",
        tokens: [
          { key: "primary", label: "Primary", category: "color", value: "#0057ff", cssVariable: "--color-primary", mapped: true },
          { key: "background-light", label: "BG Light", category: "color", value: "#ecf5ff", cssVariable: "--color-background-light", mapped: true },
          { key: "background-dark", label: "BG Dark", category: "color", value: "#07162f", cssVariable: "--color-background-dark", mapped: true },
          { key: "foreground", label: "Foreground", category: "color", value: "#04204d", cssVariable: "--foreground", mapped: true },
          { key: "font-display", label: "Display Font", category: "typography", value: "IBM Plex Sans, sans-serif", cssVariable: "--font-display", mapped: true }
        ]
      }),
      hostAssets: assets
    });

    expect(warmHtml).toContain("#ff4f00");
    expect(coolHtml).toContain("#0057ff");
    expect(warmHtml).not.toEqual(coolHtml);
  });

  it("works with null theme", () => {
    const html = buildPlatformBlockPreviewDocument({
      proposalHtml: "<section><h1>Test</h1></section>",
      theme: null,
      hostAssets: createStaticPlatformPreviewAssets()
    });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain(`href="${PLATFORM_CSS}"`);
    expect(html).not.toContain("cdn.tailwindcss.com");
  });
});

// ---------------------------------------------------------------------------
// Step 1: classifyStylesheetHref
// ---------------------------------------------------------------------------

describe("Step 1 — classifyStylesheetHref", () => {
  it("blocks all known Tailwind CDN patterns", () => {
    const cdnUrls = [
      "https://cdn.tailwindcss.com",
      "https://cdn.tailwindcss.com?plugins=forms",
      "https://cdn.tailwindcss.com/tailwind.min.css",
      "https://esm.sh/@tailwindcss/browser",
      "https://example.com/tailwind.min.css",
      "https://example.com/tailwind.css",
      "https://my-app.com/studio-runtime.css"
    ];
    for (const url of cdnUrls) {
      expect(classifyStylesheetHref(url), `Expected block for: ${url}`).toBe("block");
    }
  });

  it("allows non-CDN stylesheet URLs", () => {
    const allowedUrls = [
      "https://fonts.googleapis.com/css2?family=Inter",
      "https://source.example.com/globals.css",
      "/styles/custom-reset.css",
      "https://myapp.com/tokens.css"
    ];
    for (const url of allowedUrls) {
      expect(classifyStylesheetHref(url), `Expected allow for: ${url}`).toBe("allow");
    }
  });

  it("blocks hrefs matching additional caller-supplied patterns", () => {
    expect(
      classifyStylesheetHref("https://preview.example.com/studio-runtime.css", ["/studio-runtime.css"])
    ).toBe("block");
  });

  it("is case-insensitive", () => {
    expect(classifyStylesheetHref("https://CDN.TAILWINDCSS.COM")).toBe("block");
    expect(classifyStylesheetHref("https://FOO.COM/GLOBALS.CSS")).toBe("allow");
  });

  it("TAILWIND_CDN_BLOCKLIST_PATTERNS is non-empty", () => {
    expect(TAILWIND_CDN_BLOCKLIST_PATTERNS.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Step 1: sanitizeTargetHtml
// ---------------------------------------------------------------------------

describe("Step 1 — sanitizeTargetHtml selective stripping", () => {
  it("strips CDN tailwind script tags", () => {
    const input = `<html><head>
      <link rel="stylesheet" href="https://cdn.tailwindcss.com">
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
    </head><body><section><p>Hello</p></section></body></html>`;
    const result = sanitizeTargetHtml(input);
    expect(result).not.toContain("cdn.tailwindcss.com");
  });

  it("strips tailwind.config script blocks from body", () => {
    const input = `<html><body>
      <script id="tailwind-config">window.tailwind = {};</script>
      <section><h1>Hello</h1></section>
    </body></html>`;
    const result = sanitizeTargetHtml(input);
    expect(result).not.toContain("tailwind-config");
    expect(result).toContain("<h1>Hello</h1>");
  });

  it("returns body content without wrapper html/head tags", () => {
    const result = sanitizeTargetHtml("<section><h2>Block</h2></section>");
    expect(result).toContain("<section>");
    expect(result).not.toContain("<html>");
    expect(result).not.toContain("<head>");
  });
});

// ---------------------------------------------------------------------------
// Step 2: extractSourceTailwindConfig
// ---------------------------------------------------------------------------

describe("Step 2 — extractSourceTailwindConfig", () => {
  it("returns {} for empty input", () => {
    expect(extractSourceTailwindConfig("")).toEqual({});
    expect(extractSourceTailwindConfig("   ")).toEqual({});
  });

  it("extracts config from <script id='tailwind-config'> block", () => {
    const html = `<script id="tailwind-config">
      { darkMode: "class", theme: { extend: { colors: { brand: "#abc123" } } } }
    </script>`;
    const config = extractSourceTailwindConfig(html);
    expect(config["darkMode"]).toBe("class");
    expect((config["theme"] as Record<string, unknown>)?.["extend"]).toBeDefined();
  });

  it("extracts config from window.tailwind.config = {...}", () => {
    const html = `<script>
      window.tailwind = window.tailwind || {};
      window.tailwind.config = { darkMode: "media", theme: { extend: { fontFamily: { sans: ["Inter"] } } } };
    </script>`;
    const config = extractSourceTailwindConfig(html);
    expect(config["darkMode"]).toBe("media");
  });

  it("returns {} when no config found", () => {
    expect(extractSourceTailwindConfig("<html><body>no config</body></html>")).toEqual({});
  });

  it("returns {} on malformed JS", () => {
    const html = `<script id="tailwind-config">this is broken { }</script>`;
    expect(extractSourceTailwindConfig(html)).toEqual({});
  });

  it("handles complex config shapes", () => {
    const html = `<script id="tailwind-config">
      {
        darkMode: "class",
        plugins: ["typography", "forms"],
        theme: {
          screens: { "2xl": "1440px" },
          extend: { colors: { coral: "#ff6b6b" } }
        }
      }
    </script>`;
    const config = extractSourceTailwindConfig(html);
    expect(config["plugins"]).toEqual(["typography", "forms"]);
    const theme = config["theme"] as Record<string, unknown>;
    expect((theme?.["screens"] as Record<string, string>)?.["2xl"]).toBe("1440px");
  });
});

// ---------------------------------------------------------------------------
// Step 2: buildCanonicalCssVarsBlock (replaces buildTailwindRuntimeConfig)
// ---------------------------------------------------------------------------

describe("Step 2 — buildCanonicalCssVarsBlock (CDN-free CSS var injection)", () => {
  it("returns a <style id='lmnas-canonical-vars'> block", () => {
    const result = buildCanonicalCssVarsBlock(buildTheme());
    expect(result).toContain(`id="lmnas-canonical-vars"`);
    expect(result).toContain("<style");
    expect(result).toContain("</style>");
    expect(result).toContain(":root{");
  });

  it("contains canonical primary color from StudioTheme tokens", () => {
    const result = buildCanonicalCssVarsBlock(buildTheme());
    expect(result).toContain("#ff4f00");
  });

  it("maps color tokens to --color-* namespace for Tailwind v4 utility compatibility", () => {
    const result = buildCanonicalCssVarsBlock(buildTheme());
    // primary token (cssVariable --color-primary) → --color-primary in style block
    expect(result).toContain("--color-primary");
    expect(result).toContain("--color-background-light");
  });

  it("changes output when theme tokens change", () => {
    const warm = buildCanonicalCssVarsBlock(buildTheme());
    const cool = buildCanonicalCssVarsBlock(buildTheme({
      tokens: [{ key: "primary", label: "Primary", category: "color", value: "#0057ff", cssVariable: "--color-primary", mapped: true }]
    }));
    expect(warm).toContain("#ff4f00");
    expect(cool).toContain("#0057ff");
    expect(warm).not.toEqual(cool);
  });

  it("returns empty string for null theme", () => {
    expect(buildCanonicalCssVarsBlock(null)).toBe("");
  });

  it("returns empty string for theme with no tokens", () => {
    expect(buildCanonicalCssVarsBlock(buildTheme({ tokens: [] }))).toBe("");
  });

  it("does NOT contain window.tailwind.config", () => {
    const result = buildCanonicalCssVarsBlock(buildTheme());
    expect(result).not.toContain("window.tailwind");
    expect(result).not.toContain("tailwind.config");
  });
});

// ---------------------------------------------------------------------------
// Step 3: buildPlatformTargetDocument — CDN-free assertions
// ---------------------------------------------------------------------------

describe("Step 3 — buildPlatformTargetDocument (no CDN)", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("contains <link> to platformCssSrc instead of CDN script", () => {
    const hostAssets = createStaticPlatformPreviewAssets("http://localhost:5173");
    const html = buildPlatformTargetDocument({
      bodyHtml: "<div>test</div>",
      theme: buildTheme(),
      hostAssets
    });
    expect(html).toContain(`href="${PLATFORM_CSS}"`);
    expect(html).not.toContain("<script src=\"https://cdn.tailwindcss.com");
    expect(html).not.toContain("window.tailwind.config");
  });

  it("canonical vars block is at end of body", () => {
    const html = buildPlatformTargetDocument({
      bodyHtml: "<div>test</div>",
      theme: buildTheme(),
      hostAssets: createStaticPlatformPreviewAssets()
    });
    const varsIndex = html.indexOf("lmnas-canonical-vars");
    const bodyCloseIndex = html.indexOf("</body>");
    expect(varsIndex).toBeGreaterThan(0);
    expect(varsIndex).toBeLessThan(bodyCloseIndex);
  });

  it("forwarded source stylesheets appear before platform CSS", () => {
    const html = buildPlatformTargetDocument({
      bodyHtml: "<div>test</div>",
      theme: buildTheme(),
      hostAssets: createStaticPlatformPreviewAssets(),
      additionalStylesheetHrefs: ["https://source.example.com/globals.css"]
    });
    const sourceIdx = html.indexOf("globals.css");
    const platformIdx = html.indexOf(PLATFORM_CSS);
    expect(sourceIdx).toBeLessThan(platformIdx);
  });

  it("logs console.warn for unknown plugins as theme debt", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    buildPlatformTargetDocument({
      bodyHtml: "<div>test</div>",
      theme: buildTheme(),
      hostAssets: createStaticPlatformPreviewAssets(),
      sourceTailwindConfig: { plugins: ["my-custom-plugin-xyz"] }
    });
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toContain("my-custom-plugin-xyz");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("Theme debt");
  });

  it("does NOT warn for known plugins (they are pre-compiled)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    buildPlatformTargetDocument({
      bodyHtml: "<div>test</div>",
      theme: buildTheme(),
      hostAssets: createStaticPlatformPreviewAssets(),
      sourceTailwindConfig: { plugins: ["typography", "forms"] }
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("KNOWN_TAILWIND_PLUGINS covers the 4 official first-party plugins", () => {
    for (const name of ["typography", "forms", "container-queries", "aspect-ratio"]) {
      expect(KNOWN_TAILWIND_PLUGINS.has(name), `Missing: ${name}`).toBe(true);
    }
  });

  it("createStaticPlatformPreviewAssets returns platformCssSrc (not tailwindRuntimeSrc)", () => {
    const assets = createStaticPlatformPreviewAssets("http://localhost:5173");
    expect(assets.platformCssSrc).toBe(PLATFORM_CSS);
    // No tailwindRuntimeSrc field
    expect((assets as Record<string, unknown>)["tailwindRuntimeSrc"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Step 1+2+3: buildPlatformBlockPreviewDocument end-to-end
// ---------------------------------------------------------------------------

describe("buildPlatformBlockPreviewDocument — end-to-end", () => {
  it("additionalStylesheetHrefs appear in the document head", () => {
    const html = buildPlatformBlockPreviewDocument({
      proposalHtml: "<section>Test</section>",
      theme: buildTheme(),
      hostAssets: createStaticPlatformPreviewAssets(),
      additionalStylesheetHrefs: [
        "https://source.example.com/globals.css",
        "https://fonts.googleapis.com/css2?family=Inter"
      ]
    });
    expect(html).toContain("globals.css");
    expect(html).toContain("fonts.googleapis.com");
  });

  it("canonical vars reflect current theme tokens", () => {
    const html = buildPlatformBlockPreviewDocument({
      proposalHtml: "<section>Block</section>",
      theme: buildTheme(),
      hostAssets: createStaticPlatformPreviewAssets()
    });
    expect(html).toContain("#ff4f00"); // sunrise primary
    expect(html).toContain("Fraunces");
  });
});

// ---------------------------------------------------------------------------
// Step 1: filterSourceStylesheetsByUrl + readManifestAssetList
// ---------------------------------------------------------------------------

describe("Step 1 — filterSourceStylesheetsByUrl", () => {
  it("excludes CDN tailwind, preserves others", () => {
    const hrefs = [
      "https://cdn.tailwindcss.com",
      "https://source.example.com/globals.css",
      "https://fonts.googleapis.com/css2?family=Inter"
    ];
    const result = filterSourceStylesheetsByUrl(hrefs);
    expect(result).not.toContain("https://cdn.tailwindcss.com");
    expect(result).toContain("https://source.example.com/globals.css");
    expect(result).toContain("https://fonts.googleapis.com/css2?family=Inter");
  });

  it("additionally blocks runtimeSrc when provided", () => {
    const hrefs = ["https://host.example.com/platform.css", "https://source.example.com/reset.css"];
    const result = filterSourceStylesheetsByUrl(hrefs, "https://host.example.com/platform.css");
    expect(result).not.toContain("https://host.example.com/platform.css");
    expect(result).toContain("https://source.example.com/reset.css");
  });
});

describe("readManifestAssetList", () => {
  it("reads stylesheets from a manifest with string values", () => {
    const manifest = { stylesheets: ["https://source.example.com/globals.css"] };
    const result = readManifestAssetList(manifest, "stylesheets");
    expect(result).toContain("https://source.example.com/globals.css");
  });

  it("reads stylesheets from manifest with object entries (href/src/url)", () => {
    const manifest = { stylesheets: [{ href: "https://source.example.com/globals.css" }] };
    const result = readManifestAssetList(manifest, "stylesheets");
    expect(result).toContain("https://source.example.com/globals.css");
  });

  it("returns [] for null/undefined/non-array", () => {
    expect(readManifestAssetList(null, "stylesheets")).toEqual([]);
    expect(readManifestAssetList({}, "stylesheets")).toEqual([]);
  });

  it("resolves relative hrefs against baseUrl", () => {
    const manifest = { stylesheets: ["/styles/globals.css"] };
    const result = readManifestAssetList(manifest, "stylesheets", "https://source.example.com");
    expect(result).toContain("https://source.example.com/styles/globals.css");
  });
});

// ---------------------------------------------------------------------------
// Step 1+2+3: resolveProposalTargetPreviewHtml
// ---------------------------------------------------------------------------

describe("resolveProposalTargetPreviewHtml", () => {
  it("works without importMaster — returns valid HTML with platform CSS link", () => {
    const html = resolveProposalTargetPreviewHtml({
      proposalHtml: "<section><h1>Hello</h1></section>",
      theme: buildTheme(),
      hostAssets: createStaticPlatformPreviewAssets()
    });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain(`href="${PLATFORM_CSS}"`);
    expect(html).toContain("lmnas-canonical-vars");
    expect(html).not.toContain("cdn.tailwindcss.com");
    expect(html).not.toContain("window.tailwind.config");
  });

  it("filters source stylesheets from importMaster.sourceAssetManifest", () => {
    const html = resolveProposalTargetPreviewHtml({
      proposalHtml: "<section>Block</section>",
      theme: buildTheme(),
      hostAssets: createStaticPlatformPreviewAssets(),
      importMaster: {
        id: "im-1", importKey: "k", sourceType: "raw_html", sourceRef: "test.html",
        sourceAssetManifest: {
          stylesheets: [
            "https://source.example.com/globals.css",
            "https://cdn.tailwindcss.com"
          ]
        },
        sourceHtml: "", referencePreviewHtml: "", targetPreviewHtml: "",
        selectedThemeKey: "sunrise", selectedShellKey: "", importMode: "blocks",
        status: "processed", lifecycle: "draft", createdAt: "2026-03-23", updatedAt: "2026-03-23"
      }
    });
    expect(html).toContain("globals.css");
    // CDN URL should not appear as a <link rel="stylesheet"> tag
    expect(html).not.toMatch(/<link[^>]+href=["'][^"']*cdn\.tailwindcss\.com[^"']*["'][^>]*>/);
  });

  it("uses persistedTargetPreviewHtml as fallback when proposalHtml is empty", () => {
    const html = resolveProposalTargetPreviewHtml({
      proposalHtml: "",
      persistedTargetPreviewHtml: "<section><h2>Persisted</h2></section>",
      theme: buildTheme(),
      hostAssets: createStaticPlatformPreviewAssets()
    });
    expect(html).toContain("Persisted");
  });
});
