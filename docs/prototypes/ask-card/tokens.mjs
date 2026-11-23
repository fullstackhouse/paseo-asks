// tokens.css for a storyboard of an app that is not Open Mercato.
//
// The engine (components.css, screens.css, prototype.css, prototype.js) reads a fixed set of
// CSS variables. This file maps the app's own design tokens onto that contract and also exposes
// the ramps under an app prefix (--app-*) for the surface styles at the end of screens.css.
//
// Fill the source: import the app's token module directly when it is TypeScript (Node strips
// types: `await import('../../src/theme/tokens.ts')`), or parse its CSS. Never re-type values.
// Then: node tokens.mjs && node <skill>/scripts/sync-tokens.mjs --verify .
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// ── 1. The app's tokens ─────────────────────────────────────────────────
// Example for a TypeScript token module:
//   const { colors, radius, shadow } = await import(path.resolve(here, '../../../src/ui/tokens.ts'))
const app = {
  // Paseo DARK theme (packages/app/src/styles/theme.ts): zinc ramp, zincDark surfaces, paseoDark accent,
  // dark status colors (statusSuccess/Danger/Warning + 16% tints). `gray` is the zinc ramp.
  white: '#ffffff',
  gray: { 50: '#fafafa', 100: '#f4f4f5', 200: '#e4e4e7', 300: '#d4d4d8', 500: '#71717a', 600: '#52525b', 700: '#3f3f46', 900: '#18181b' },
  // accent #20744A (primary buttons), accentBright #239956 / #7ccba0 (hover, text); 50-100 are the success tint.
  brand: { 50: '#6cb17b29', 100: '#6cb17b29', 200: '#6cb17b66', 500: '#239956', 600: '#20744A', 700: '#239956', 900: '#181B1A' },
  error: { 50: '#d8847b29', 100: '#d8847b29', 200: '#d8847b66', 500: '#c64f43', 600: '#c64f43', 700: '#d8847b' },
  warning: { 50: '#c0966429', 100: '#c0966429', 200: '#c0966466', 500: '#c09664', 600: '#c09664', 700: '#c09664' },
  success: { 50: '#6cb17b29', 100: '#6cb17b29', 200: '#6cb17b66', 500: '#6cb17b', 600: '#6cb17b', 700: '#6cb17b' },
  font: '"Inter", ui-sans-serif, system-ui, sans-serif',
  radius: { sm: '6px', md: '8px', lg: '10px', xl: '12px' },
  shadow: { xs: '0 1px 2px rgb(0 0 0 / 0.3)', md: '0 4px 6px -1px rgb(0 0 0 / 0.4)', lg: '0 12px 16px -4px rgb(0 0 0 / 0.4)', xl: '0 20px 24px -4px rgb(0 0 0 / 0.4)' },
  // zincDark: surface0 #18181b, surface1 #1f1f22, surface2 #27272a, surface3 #3f3f46, border #27272a, borderAccent #303036,
  // foregroundMuted #a1a1aa, foregroundExtraMuted #71717a, foreground #fafafa.
  extra: { surface0: '#18181b', surface1: '#1f1f22', surface2: '#27272a', surface3: '#3f3f46', border: '#27272a', 'border-accent': '#303036', 'fg-muted': '#a1a1aa', 'fg-extra-muted': '#71717a', 'fg-hover': '#fafafa', 'status-dot-success': '#35c264', 'status-merged': '#a890d5' },
}

const ramp = (name) => Object.entries(app[name]).map(([step, value]) => `  --app-${name}-${step}: ${value};`).join('\n')

// ── 2. The engine contract ──────────────────────────────────────────────
const css = `/* GENERATED — do not edit by hand. Regenerate with: node tokens.mjs (this directory). */

:root {
  color-scheme: dark;

${['gray', 'brand', 'error', 'warning', 'success'].map(ramp).join('\n')}
  --app-white: ${app.white};
${Object.entries(app.extra).map(([k, v]) => `  --app-${k}: ${v};`).join('\n')}

  --font-geist-sans: ${app.font};
  --font-geist-mono: ui-monospace, "SFMono-Regular", Menlo, monospace;
  --radius: ${app.radius.lg};
  --radius-sm: ${app.radius.sm};
  --radius-md: ${app.radius.md};
  --radius-lg: ${app.radius.lg};
  --radius-xl: ${app.radius.xl};
  --background: var(--app-surface0);
  --foreground: var(--app-gray-50);
  --card: var(--app-surface1);
  --card-foreground: var(--app-gray-50);
  --popover: var(--app-surface2);
  --popover-foreground: var(--app-gray-50);
  --primary: var(--app-brand-600);
  --primary-foreground: var(--app-white);
  --primary-hover: var(--app-brand-700);
  --accent-indigo: var(--app-brand-600);
  --accent-indigo-foreground: var(--app-white);
  --secondary: var(--app-surface2);
  --secondary-foreground: var(--app-gray-50);
  --muted: var(--app-surface2);
  --muted-foreground: var(--app-fg-muted);
  --accent: var(--app-surface2);
  --accent-foreground: var(--app-gray-50);
  --destructive: var(--app-error-600);
  --border: var(--app-border);
  --input: var(--app-border-accent);
  --ring: var(--app-brand-500);
  --bg-disabled: var(--app-surface2);
  --text-disabled: var(--app-fg-extra-muted);
  --border-disabled: var(--app-border);
  --sidebar: var(--app-brand-900);
  --sidebar-foreground: var(--app-white);
  --sidebar-border: var(--app-brand-700);
  --chart-blue: var(--app-brand-600);
  --status-error-bg: var(--app-error-50);
  --status-error-text: var(--app-error-700);
  --status-error-border: var(--app-error-200);
  --status-error-icon: var(--app-error-500);
  --status-success-bg: var(--app-success-50);
  --status-success-text: var(--app-success-700);
  --status-success-border: var(--app-success-200);
  --status-success-icon: var(--app-success-500);
  --status-warning-bg: var(--app-warning-50);
  --status-warning-text: var(--app-warning-700);
  --status-warning-border: var(--app-warning-200);
  --status-warning-icon: var(--app-warning-500);
  --status-info-bg: var(--app-brand-50);
  --status-info-text: #7ccba0;
  --status-info-border: var(--app-brand-200);
  --status-info-icon: var(--app-brand-500);
  --status-neutral-bg: var(--app-surface2);
  --status-neutral-text: var(--app-fg-muted);
  --status-neutral-border: var(--app-border-accent);
  --status-neutral-icon: var(--app-gray-500);
  --status-pink-bg: var(--app-brand-50);
  --status-pink-text: var(--app-brand-700);
  --status-pink-border: var(--app-brand-200);
  --status-pink-icon: var(--app-brand-500);
  --brand-lime: var(--app-brand-500);
  --brand-violet: var(--app-brand-600);
  --font-size-overline: 0.6875rem;
  --font-size-overline--line-height: 1rem;
  --z-index-base: 0;
  --z-index-sticky: 10;
  --z-index-dropdown: 20;
  --z-index-overlay: 30;
  --z-index-modal: 40;
  --z-index-popover: 45;
  --z-index-toast: 50;
  --z-index-tooltip: 60;
  --z-index-top: 100;
  --shadow-xs: ${app.shadow.xs};
  --shadow-sm: ${app.shadow.xs};
  --shadow-md: ${app.shadow.md};
  --shadow-lg: ${app.shadow.lg};
  --shadow-xl: ${app.shadow.xl};
  --shadow-2xl: ${app.shadow.xl};
  --shadow-focus: 0 0 0 2px var(--app-surface0), 0 0 0 4px var(--app-brand-500);
}

/* Dark only: Paseo's dark theme is the single theme drawn here. */
`

const unfilled = JSON.stringify(app).includes('"TODO"')
if (unfilled) {
  console.error('tokens.mjs still has placeholder values; fill them from the app\'s design tokens.')
  process.exitCode = 2
} else {
  fs.writeFileSync(path.join(here, 'tokens.css'), css)
  console.log('wrote tokens.css')
}
