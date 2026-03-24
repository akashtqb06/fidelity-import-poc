# Component Import Fidelity POC — LMNAs Studio

A proof-of-concept for the **Component Import pipeline** in LMNAs Studio. It demonstrates how to render imported HTML components inside a design platform canvas at high fidelity — without relying on the Tailwind CDN in the target preview.

---

## The Problem

When a user imports a self-contained HTML component, it typically includes:

- `<script src="https://cdn.tailwindcss.com">` — the Tailwind JIT CDN
- A `tailwind.config` block (inline JS or `window.tailwind.config = {...}`)
- `<link rel="stylesheet">` tags for fonts, resets, CSS variable sheets
- Custom plugins, arbitrary values, dark mode class toggles

The platform needs to render this component **twice** — side by side:

| Pane | Goal |
|------|------|
| **Source** (left) | 100% fidelity — raw markup, CDN Tailwind OK |
| **Target** (right) | Rendered inside the LMNAs canvas against the canonical StudioTheme — **no CDN** |

The naive approach (strip all `<link>` tags, overwrite `window.tailwind.config`) causes visible fidelity drops.

---

## Architecture

### CSS Cascade in the Target Iframe

```
[forwarded source <link>s]       → fonts, source CSS vars, resets
[compiled platform CSS]          → all Tailwind utilities + default @theme vars
<style id="lmnas-canonical-vars"> at END of <body>  → canonical tokens ALWAYS WIN
```

The canonical token override block is injected **last in document order** (end of `<body>`), so it overrides any source `:root` declarations regardless of specificity.

### Three Pipeline Steps

**Step 1 — Selective Stylesheet Forwarding**  
`classifyStylesheetHref()` classifies each `<link rel="stylesheet">` as `allow` or `block` using a URL blocklist. CDN Tailwind URLs are stripped; fonts and custom CSS vars are forwarded.

**Step 2 — Source Config Extraction + Canonical Override**  
`extractSourceTailwindConfig()` parses the source HTML for any `tailwind.config` (multiple strategies: script IDs, `window.tailwind.config = {...}`). `buildCanonicalCssVarsBlock()` produces a `<style id="lmnas-canonical-vars">` block from the StudioTheme tokens, mapped to the Tailwind v4 `--color-*` namespace.

**Step 3 — Target Document Builder**  
`buildPlatformTargetDocument()` assembles the final target HTML:
- Links to the **compiled platform CSS** (Tailwind v4, no CDN)
- Injects forwarded source stylesheets before the platform CSS
- Detects unknown plugins → logs them as **theme debt**
- Appends the canonical CSS vars block at end of `<body>`

---

## Worst-Case Test Suite

Nine examples are loaded dynamically from [`public/examples/manifest.json`](public/examples/manifest.json):

| Example | Tests |
|---------|-------|
| **Basic Hero** | Custom brand colors, Google Fonts, `tailwind.config` |
| **Editorial Blog** | `@tailwindcss/typography` plugin, inline `:root` CSS vars |
| **Dark Pricing** | Custom screens, animations, known + unknown plugins |
| **Compiled CSS Only** | No CDN, no config — Next.js export simulation |
| **TransformerCorp** | `@tailwindcss/browser@4` runtime, dark class, Material Icons |
| **CSS Var Battle ⚔** | Source redefines all canonical vars in head, mid-body, `@media` — canonical must win |
| **Arbitrary Values Hell** | 100% arbitrary values (`bg-[#hex]`, `h-[calc(...)]`) — surfaces CDN JIT fidelity gap |
| **Plugin Overload 🔥** | 3 known + 2 unknown plugins, 8 custom screens, 15+ color tokens, dashboard UI |
| **Dark Mode Toggle 🌙** | JS class strategy, `localStorage`, `@tailwindcss/browser@4` — iframe isolation test |

---

## Project Structure

```
poc-import/
├── index.html                      # Vite app entry (demo shell — plain CSS, no Tailwind)
├── vite.config.ts                  # Vite + @tailwindcss/vite plugin
├── src/
│   ├── style.css                   # Tailwind v4 CSS-first config (canonical @theme tokens)
│   ├── main.ts                     # Demo app — fetches manifest, renders cards, runs pipeline
│   ├── platform-preview-shared.ts  # ← Core library (production code path)
│   ├── import-page-helpers.ts      # Client-side helpers (manifest reader, stylesheet filter)
│   ├── types.ts                    # Shared types (StudioTheme, PlatformPreviewAssets, …)
│   └── platform-preview-shared.test.ts  # 42 unit tests
└── public/
    └── examples/
        ├── manifest.json           # Drives the sidebar cards dynamically
        ├── basic-hero.html
        ├── css-var-conflict.html   # Worst case: CSS var battle
        ├── arbitrary-values.html   # Worst case: CDN-only JIT fidelity gap
        ├── everything-at-once.html # Worst case: 5 plugins, 8 screens
        ├── dark-mode-toggle.html   # Worst case: JS dark mode, iframe isolation
        └── …
```

> **Adding a new example**: create the HTML file in `public/examples/` and add an entry to `manifest.json`. No code changes needed.

---

## Key Types

```ts
type PlatformPreviewAssets = {
  platformCssSrc: string;  // URL to compiled platform CSS (no CDN)
  headMarkup: string;      // Extra <head> markup, if any
};

type StudioTheme = {
  tokens: Array<{ key, value, cssVariable, category, mapped }>;
  darkMode: boolean;
  // …
};
```

---

## Running

```bash
npm install
npm run dev       # → http://localhost:5173
npm test          # 42 unit tests (Vitest)
npm run typecheck # TypeScript check
```

---

## Known Fidelity Gaps (By Design)

| Gap | Cause | Status |
|-----|-------|--------|
| Tailwind **arbitrary values** not rendered in target | CDN JIT compiles `bg-[#hex]` on demand; compiled CSS cannot | ✅ Surfaced visually — expected |
| Unknown **plugins** missing from target | Not pre-compiled into `src/style.css` | ✅ Detected as theme debt, logged |
| Source `:root` vars **overridden** by canonical | By design — canonical StudioTheme always wins in target | ✅ Intended |
| Source **dark mode JS** toggle affects iframe only | iframes have isolated DOMs | ✅ Expected isolation |

---

## Theme Debt

When a source component uses an **unknown plugin** (not in `KNOWN_TAILWIND_PLUGINS`), the pipeline:
1. Logs a `console.warn` with the plugin name
2. Shows a `⚠ Theme Debt` badge in the demo UI
3. Does **not** inject a CDN script for it

To resolve: add `@plugin "my-plugin"` to `src/style.css` and list the plugin name in `KNOWN_TAILWIND_PLUGINS` in `platform-preview-shared.ts`.
