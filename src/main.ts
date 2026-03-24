/**
 * main.ts — Vite app entry for the Component Import Fidelity POC demo.
 *
 * Imports from the real library (platform-preview-shared.ts) so the demo
 * actually exercises the production code path, not a simulation.
 *
 * The target preview uses the app's compiled platform CSS served by the
 * Vite dev server — NO cdn.tailwindcss.com in the target iframe.
 */

import "./style.css";

import {
  classifyStylesheetHref,
  extractSourceTailwindConfig,
  buildPlatformBlockPreviewDocument,
  buildCanonicalCssVarsBlock,
  sanitizeTargetHtml,
  extractBodyHtml,
  KNOWN_TAILWIND_PLUGINS
} from "./platform-preview-shared.js";

import type { StudioTheme, PlatformPreviewAssets } from "./types.js";

// ---------------------------------------------------------------------------
// Canonical StudioTheme (simulated — real one comes from the Studio API)
// ---------------------------------------------------------------------------

const STUDIO_THEME: StudioTheme = {
  id: "theme-lmnas-default",
  themeKey: "default",
  name: "LMNAs Default",
  status: "active",
  sourceRef: "default",
  darkMode: false,
  tokenCoverage: 1,
  themeDebt: "none",
  createdAt: "2026-01-01",
  updatedAt: "2026-03-23",
  tokens: [
    { key: "primary",           label: "Primary",       category: "color",      value: "#4f8ef7", cssVariable: "--color-primary",           mapped: true },
    { key: "background-light",  label: "BG Light",      category: "color",      value: "#f8fafc", cssVariable: "--color-background-light",  mapped: true },
    { key: "background-dark",   label: "BG Dark",       category: "color",      value: "#0f172a", cssVariable: "--color-background-dark",   mapped: true },
    { key: "foreground-light",  label: "Text Light",    category: "color",      value: "#1e293b", cssVariable: "--color-foreground-light",  mapped: true },
    { key: "foreground-dark",   label: "Text Dark",     category: "color",      value: "#e2e8f0", cssVariable: "--color-foreground-dark",   mapped: true },
    { key: "font-display",      label: "Display Font",  category: "typography", value: "Inter, sans-serif", cssVariable: "--font-display", mapped: true }
  ]
};

// ---------------------------------------------------------------------------
// Host assets — points at this Vite dev server's compiled CSS
// ---------------------------------------------------------------------------

function getHostAssets(): PlatformPreviewAssets {
  return {
    // The compiled platform CSS from Tailwind v4 — served by Vite dev server.
    // In production, this would be the CDN URL of the compiled output.
    platformCssSrc: `${window.location.origin}/src/style.css`,
    headMarkup: ""
  };
}

// ---------------------------------------------------------------------------
// Pipeline — extract report from raw HTML
// ---------------------------------------------------------------------------

interface PipelineReport {
  sourceLinks: string[];
  allowedLinks: string[];
  blockedLinks: string[];
  sourceConfig: Record<string, unknown>;
  detectedPlugins: string[];
  knownPlugins: string[];
  unknownPlugins: string[];
}

function extractLinkHrefs(html: string): string[] {
  const results: string[] = [];
  const re = /<link([^>]+)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const block = m[1] ?? "";
    if (/rel=["'][^"']*stylesheet[^"']*["']/i.test(block)) {
      const href = /href=["']([^"']+)["']/i.exec(block)?.[1];
      if (href) results.push(href);
    }
  }
  return results;
}

function runPipeline(rawHtml: string): PipelineReport {
  const sourceLinks = extractLinkHrefs(rawHtml);
  const allowedLinks: string[] = [];
  const blockedLinks: string[] = [];

  for (const href of sourceLinks) {
    if (classifyStylesheetHref(href) === "allow") {
      allowedLinks.push(href);
    } else {
      blockedLinks.push(href);
    }
  }

  const sourceConfig = extractSourceTailwindConfig(rawHtml);
  const rawPlugins = Array.isArray(sourceConfig["plugins"])
    ? (sourceConfig["plugins"] as unknown[]).filter((p): p is string => typeof p === "string")
    : [];

  const knownPlugins = rawPlugins.filter((p) => KNOWN_TAILWIND_PLUGINS.has(p));
  const unknownPlugins = rawPlugins.filter((p) => !KNOWN_TAILWIND_PLUGINS.has(p));

  return {
    sourceLinks,
    allowedLinks,
    blockedLinks,
    sourceConfig,
    detectedPlugins: rawPlugins,
    knownPlugins,
    unknownPlugins
  };
}

// ---------------------------------------------------------------------------
// UI: render iframes
// ---------------------------------------------------------------------------

function renderPreviews(rawHtml: string, report: PipelineReport): void {
  const hostAssets = getHostAssets();

  // Source iframe — raw HTML as-is (may use CDN Tailwind — that's fine for source)
  const sourceFrame = document.getElementById("source-iframe") as HTMLIFrameElement | null;
  if (sourceFrame) {
    sourceFrame.srcdoc = rawHtml;
    sourceFrame.onload = () => {
      document.getElementById("source-loading")?.style.setProperty("display", "none");
    };
  }

  // Target iframe — compiled CSS, no CDN
  const sanitized = extractBodyHtml(sanitizeTargetHtml(rawHtml));
  const targetHtml = buildPlatformBlockPreviewDocument({
    proposalHtml: sanitized,
    theme: STUDIO_THEME,
    hostAssets,
    additionalStylesheetHrefs: report.allowedLinks,
    sourceTailwindConfig: report.sourceConfig
  });

  const targetFrame = document.getElementById("target-iframe") as HTMLIFrameElement | null;
  if (targetFrame) {
    targetFrame.srcdoc = targetHtml;
    targetFrame.onload = () => {
      document.getElementById("target-loading")?.style.setProperty("display", "none");
    };
  }
}

// ---------------------------------------------------------------------------
// UI: detection panel
// ---------------------------------------------------------------------------

function renderDetectionPanel(report: PipelineReport): void {
  const panel = document.getElementById("detection-panel");
  if (!panel) return;

  const hasConfig = Object.keys(report.sourceConfig).length > 0;
  const canonicalVarsBlock = buildCanonicalCssVarsBlock(STUDIO_THEME);
  const cssVarCount = (canonicalVarsBlock.match(/--[\w-]+:/g) ?? []).length;

  const chip = (text: string, cls: string) =>
    `<span class="detect-chip ${cls}">${text}</span>`;

  const archNote = `
    <div class="arch-note">
      <div class="arch-note-title">◈ CDN-Free Target Preview</div>
      <div class="arch-note-body">
        Source iframe uses <strong>CDN Tailwind</strong> (shows "as-imported" fidelity).<br>
        Target iframe uses <code>${getHostAssets().platformCssSrc}</code><br>
        — compiled Tailwind v4, no CDN script.
        Canonical tokens injected as CSS vars at end of <code>&lt;body&gt;</code>.
      </div>
    </div>`;

  const compiledCssInfo = `
    <div class="detect-block">
      <div class="detect-block-title canon">
        <div class="detect-dot canon"></div>
        Canonical CSS Vars Injected (${cssVarCount})
      </div>
      <div class="detect-code">${html(canonicalVarsBlock.replace(/<\/?style[^>]*>/g, "").trim())}</div>
    </div>`;

  const configSection = `
    <div class="detect-block">
      <div class="detect-block-title source-c">
        <div class="detect-dot source-c"></div>
        Source Config Extracted
      </div>
      ${hasConfig
        ? `<div class="detect-code">${html(JSON.stringify(report.sourceConfig, null, 2))}</div>`
        : `<div class="detect-empty">${
            "No tailwind.config in source — canonical tokens applied only"
          }</div>`}
    </div>`;

  const sheetsSection = `
    <div class="detect-block">
      <div class="detect-block-title source-c">
        <div class="detect-dot source-c"></div>
        Stylesheets Forwarded to Target (${report.allowedLinks.length})
      </div>
      ${report.allowedLinks.length > 0
        ? report.allowedLinks.map((h) => chip(trunc(h, 55), "success-c")).join("")
        : `<div class="detect-empty">None — only platform CSS in target</div>`}
    </div>
    <div class="detect-block">
      <div class="detect-block-title danger-c">
        <div class="detect-dot danger-c"></div>
        Stylesheets Blocked (${report.blockedLinks.length})
      </div>
      ${report.blockedLinks.length > 0
        ? report.blockedLinks.map((h) => chip(trunc(h, 55), "danger-c")).join("")
        : `<div class="detect-empty">None</div>`}
    </div>`;

  const pluginSection = `
    <div class="detect-block">
      <div class="detect-block-title success-c">
        <div class="detect-dot success-c"></div>
        Known Plugins — Pre-Compiled in Platform CSS (${report.knownPlugins.length})
      </div>
      ${report.knownPlugins.length > 0
        ? report.knownPlugins.map((p) => chip(p, "success-c")).join("")
        : `<div class="detect-empty">None</div>`}
    </div>
    ${report.unknownPlugins.length > 0 ? `
    <div class="detect-block">
      <div class="detect-block-title warn-c">
        <div class="detect-dot warn-c"></div>
        Theme Debt — Unknown Plugins (${report.unknownPlugins.length})
      </div>
      ${report.unknownPlugins.map((p) => chip(p, "warn-c")).join("")}
      <div style="font-size:11px;color:var(--text-dim);margin-top:6px">
        Add <code>@plugin "${report.unknownPlugins[0]}"</code> to <code>src/style.css</code> to resolve.
      </div>
    </div>` : ""}`;

  panel.innerHTML = archNote + compiledCssInfo + configSection + sheetsSection + pluginSection;
}

function updateStatusBar(report: PipelineReport): void {
  const el = (id: string, text: string) => {
    const e = document.getElementById(id);
    if (e) e.textContent = text;
  };
  el("status-sheets", `${report.allowedLinks.length} stylesheet${report.allowedLinks.length !== 1 ? "s" : ""} forwarded`);
  el("status-plugins", `${report.detectedPlugins.length} plugin${report.detectedPlugins.length !== 1 ? "s" : ""} detected`);
  el("status-config", Object.keys(report.sourceConfig).length > 0 ? "Source config extracted" : "No source config");
  el("status-text", "Pipeline complete — compiled CSS");

  const dot = document.getElementById("status-dot");
  if (dot) dot.className = "status-indicator";

  const badge = document.getElementById("fidelity-badge");
  if (badge) {
    if (report.unknownPlugins.length > 0) {
      badge.className = "fidelity-badge med";
      badge.textContent = `⚠ Theme Debt: ${report.unknownPlugins.length} unknown plugin(s)`;
    } else {
      badge.className = "fidelity-badge high";
      badge.textContent = "✦ Compiled CSS — No CDN";
    }
  }
}

// ---------------------------------------------------------------------------
// Example manifest types
// ---------------------------------------------------------------------------

interface ExampleManifestEntry {
  key: string;
  title: string;
  desc: string;
  tags: Array<{ label: string; cls: string }>;
}

// Populated async from /examples/manifest.json
let EXAMPLES: Record<string, string> = {};

// ---------------------------------------------------------------------------
// UI: dynamic example card rendering from manifest
// ---------------------------------------------------------------------------

function renderExampleCards(entries: ExampleManifestEntry[]): void {
  const container = document.getElementById("example-list");
  if (!container) return;

  container.innerHTML = entries
    .map((e) => {
      const tagsHtml = e.tags
        .map((t) => `<span class="tag ${t.cls}">${t.label}</span>`)
        .join("");
      return [
        `<button class="example-btn" onclick="loadExample('${e.key}')" id="btn-${e.key}">`,
        `  <span class="example-btn-title">${e.title}</span>`,
        `  <span class="example-btn-desc">${e.desc}</span>`,
        tagsHtml ? `  <div class="tags">${tagsHtml}</div>` : "",
        `</button>`
      ].join("");
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// UI: example loading
// ---------------------------------------------------------------------------

let currentExample: string | null = null;

export async function loadExample(key: string): Promise<void> {
  if (currentExample === key) return;
  currentExample = key;

  document.querySelectorAll(".example-btn").forEach((b) => b.classList.remove("active"));
  document.getElementById(`btn-${key}`)?.classList.add("active");

  setLoading(true);

  const path = EXAMPLES[key];
  if (!path) {
    document.getElementById("status-text")!.textContent = `Unknown example: ${key}`;
    setLoading(false);
    return;
  }

  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rawHtml = await res.text();
    processAndRender(rawHtml);
  } catch (err) {
    document.getElementById("status-text")!.textContent = `Error: ${String(err)}`;
    setLoading(false);
  }
}

export function loadCustom(): void {
  const el = document.getElementById("custom-html-input") as HTMLTextAreaElement | null;
  const rawHtml = el?.value.trim() ?? "";
  if (!rawHtml) return;
  currentExample = null;
  document.querySelectorAll(".example-btn").forEach((b) => b.classList.remove("active"));
  processAndRender(rawHtml);
}

function processAndRender(rawHtml: string): void {
  setLoading(true);
  requestAnimationFrame(() =>
    setTimeout(() => {
      const report = runPipeline(rawHtml);
      renderPreviews(rawHtml, report);
      renderDetectionPanel(report);
      updateStatusBar(report);
    }, 60)
  );
}

function setLoading(on: boolean): void {
  const display = on ? "flex" : "none";
  document.getElementById("source-loading")?.style.setProperty("display", display);
  document.getElementById("target-loading")?.style.setProperty("display", display);
  const dot = document.getElementById("status-dot");
  if (dot) dot.className = "status-indicator" + (on ? " processing" : "");
  if (on) {
    const t = document.getElementById("status-text");
    if (t) t.textContent = "Processing…";
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function trunc(s: string, n: number): string {
  return s.length > n ? "…" + s.slice(-n) : s;
}

function html(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  // Expose for inline onclick handlers in index.html
  (window as unknown as Record<string, unknown>)["loadExample"] = loadExample;
  (window as unknown as Record<string, unknown>)["loadCustom"] = loadCustom;

  // Dynamically fetch manifest and render example cards
  try {
    const res = await fetch("/examples/manifest.json");
    const entries = (await res.json()) as ExampleManifestEntry[];

    // Populate the URL map from the manifest
    EXAMPLES = Object.fromEntries(
      entries.map((e) => [e.key, `/examples/${e.key}.html`])
    );

    renderExampleCards(entries);
  } catch {
    // Fallback: hardcoded basics so demo still works if manifest fails
    EXAMPLES = {
      "basic-hero":     "/examples/basic-hero.html",
      "typography-plugin": "/examples/typography-plugin.html",
      "pricing-dark":   "/examples/pricing-dark.html"
    };
    const container = document.getElementById("example-list");
    if (container) {
      container.innerHTML = `<div style="color:var(--text-dim);font-size:12px;padding:8px">
        Could not load manifest — using defaults.
      </div>`;
    }
  }

  // Auto-load the first example
  const firstKey = Object.keys(EXAMPLES)[0] ?? "basic-hero";
  void loadExample(firstKey);
}

window.addEventListener("DOMContentLoaded", () => { void boot(); });
