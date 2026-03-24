// Minimal type stubs needed for the POC.
// In the real codebase these come from studio-types.ts and @lmnas/contracts.

export type StudioThemeTokenCategory = "color" | "typography" | "spacing" | "radius" | "shadow";
export type StudioThemeStatus = "active" | "inactive" | "draft";

export interface StudioThemeToken {
  key: string;
  label: string;
  category: StudioThemeTokenCategory;
  value: string;
  cssVariable: string;
  mapped: boolean;
}

export interface StudioTheme {
  id: string;
  themeKey: string;
  name: string;
  status: StudioThemeStatus;
  sourceRef: string;
  themeScopeClass?: string;
  createdAt: string;
  updatedAt: string;
  tokenCoverage: number;
  themeDebt: string;
  darkMode: boolean;
  tokens: StudioThemeToken[];
}

export interface StudioImportMaster {
  id: string;
  importKey: string;
  sourceType: string;
  sourceRef: string;
  sourceTitle?: string;
  sourceHtml?: string;
  sourceBaseUrl?: string;
  sourceAssetManifest?: Record<string, unknown>;
  referencePreviewHtml: string;
  targetPreviewHtml: string;
  selectedThemeKey: string;
  selectedShellKey: string;
  importMode: "blocks" | "page";
  status: "processed" | "imported_blocks" | "imported_page" | "failed";
  lifecycle: "draft" | "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export type PlatformPreviewAssets = {
  /**
   * URL of the app's compiled platform CSS (Tailwind v4 output).
   * This is served by the Vite dev server in development
   * (e.g. "http://localhost:5173/src/style.css") and by the CDN/app
   * origin in production. The target preview iframe links to this URL
   * instead of cdn.tailwindcss.com.
   */
  platformCssSrc: string;
  /** Any extra markup to inject into the target document <head>. */
  headMarkup: string;
};
