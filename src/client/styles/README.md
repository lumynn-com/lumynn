# CSS Structure

`../styles.css` is the public entrypoint. It declares the app's CSS cascade layers and imports every partial into a named layer. Keep that layer order stable; it is the current theme contract.

## Import Order

The partials are split by historical layer and behavior area. Their cascade order is now explicit in `../styles.css`:

- `00-legacy-base.css`: original base styles and early light-mode overrides.
- `01-redesign-workspace.css`: first redesign layer and workspace layout.
- `02-visual-material.css`: visual polish, material comfort, font clarity, and early mobile refinements.
- `03-mobile-chrome.css`: mobile section headers, overflow menu, and action sheet chrome.
- `04-print-file-management.css`: print surface, file-management UI, focus mode, and syntax highlighting.
- `05-flat-ui.css`: flat UI refactor and anti-glass component cleanup.
- `06-minimalist-theme.css`: minimalist theme unification and token-driven component surface rules.
- `07-typography-mobile-polish.css`: shared type-size normalization and mobile input zoom prevention.
- `07b-mobile-minimalist-controls.css`: mobile tab strip, sheet, app-bar, and FAB polish. It stays in the same `type-mobile-polish` layer as `07` so the split does not change cascade priority.
- `08-current-theme-tokens.css`: canonical current palette, legacy token aliases, shape tokens, state tokens, and document tokens.
- `09-current-theme-overrides.css`: final shared component rules that consume the current theme tokens.
- `10-copilot-panel.css`: Copilot panel, composer, history, source, and mobile panel rules. It imports into the same final layer as `09` so its cascade position stays equivalent to the old monolithic override file.

## Layer Contract

The current layer order is:

`vendor -> legacy-base -> redesign-workspace -> material -> mobile-chrome -> feature-rules -> flat-ui -> minimalist -> type-mobile-polish -> theme-tokens -> current-theme-overrides`

Rules in later layers win over earlier layers at the same origin and importance. This replaces the old implicit "file name order" dependency with an explicit browser cascade contract.

Treat `00` through `07` as frozen compatibility layers. Do not add new product styling there during normal feature work. Move active theme values to `08`, shared app component rules to `09`, and feature-owned final rules to a focused partial such as `10-copilot-panel.css` imported into the existing final layer.

## Where To Edit

- Current light/dark theme values belong in `08-current-theme-tokens.css`.
- New shared final app-level component rules belong in `09-current-theme-overrides.css`.
- Copilot-specific panel rules belong in `10-copilot-panel.css`.
- Mobile chrome rules should stay in `03-mobile-chrome.css` for structural layout, or `07b-mobile-minimalist-controls.css` for final mobile visual polish.
- File tree, print, focus mode, and file-management rules should stay in `04-print-file-management.css`.
- Muya-specific rules should stay in `../MuyaMarkdownEditor.css` when they only target the embedded editor.
- Legacy partials `00` through `07` are compatibility layers. Avoid adding new theme direction there unless the change is explicitly local to that historical layer.

## Token Model

- `--owd-theme-*` tokens are the canonical raw theme values.
- Legacy aliases such as `--bg`, `--panel`, `--md-bg`, and `--md-primary` map to `--owd-theme-*` in `08-current-theme-tokens.css`.
- Document reading tokens such as `--owd-doc-*` are shared by preview and Q&A Markdown output.
- State tokens such as `--owd-tonal-*` control flat hover, selected, and focus surfaces.
- Shape tokens such as `--owd-radius-*` control the current flat corner system.
- Stack tokens such as `--owd-z-*` control app z-index values.

## Guidelines

- Add new current-theme tokens in `08-current-theme-tokens.css` unless a token clearly belongs to an older compatibility layer.
- Prefer token changes over adding more raw color values.
- Do not add new `:root[data-theme="light"]` token blocks to legacy partials; put active theme values in `08-current-theme-tokens.css`.
- Avoid adding new `!important` rules unless they override an existing compatibility layer, protect mobile chrome, or isolate Muya/editor third-party styles.
- Prefer the correct layer plus stronger, component-scoped selectors before reaching for `!important`.
- Do not reorder layers or imports without checking desktop, mobile, light mode, dark mode, preview, editor, Q&A, and Copilot views.

## Refactor Direction

- Collapse duplicate token definitions into `08-current-theme-tokens.css`.
- Continue splitting the final override layer by feature ownership while keeping those files in the existing `current-theme-overrides` layer unless a deliberate cascade change is required.
- Keep typography and mobile visual cleanup separate. Type-size changes belong in `07-typography-mobile-polish.css`; mobile tabs, sheets, app-bar, and FAB rules belong in `07b-mobile-minimalist-controls.css`.
- Keep third-party/editor isolation out of global app rules. Muya selectors should stay under `.muya-editor-shell` or its known floating wrappers.
- Any new z-index value should first become a token in `08-current-theme-tokens.css` unless it is isolated inside third-party editor CSS.

## Before Commit

- Run `npm run lint:css` after CSS structure changes.
- Run `git diff --check`.
- Run `npm run build` for CSS import or selector changes.
- Restart with `./server.sh restart` when the production preview should reflect the latest build.
- Check `https://127.0.0.1:4177/` after restart.
