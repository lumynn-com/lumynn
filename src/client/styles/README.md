# CSS Structure

`../styles.css` is the public entrypoint. It declares the app's CSS cascade layers and imports every partial into a named layer. Keep that layer order stable; it is the current theme contract.

## Import Order

The partials are split by historical layer and behavior area. Their cascade order is now explicit in `../styles.css`:

- `00-legacy-base.css`: original root defaults, global element reset, base controls, login shell/card, typography helpers, and error state rules.
- `00b-legacy-workspace.css`: legacy app shell, sidebar, workspace grid, vault tree, editor tabs, preview, and Q&A answer rules.
- `00c-legacy-settings-indexing.css`: legacy settings, indexing, import/export, form, message, hero, ask-row, and citation grid rules.
- `00d-legacy-responsive-light.css`: legacy responsive layout rules and early light-mode compatibility overrides.
- `01-redesign-workspace.css`: first redesign layer baseline, global app shell, sidebar, generic panels, legacy workspace grid, and responsive base rules.
- `01b-task-ia.css`: task-first settings, indexing, Q&A view, and early document/editor/preview panel refinements.
- `01c-workbench-shell.css`: Obsidian-style topbar, signed-in user/admin chrome, workspace shell, vault/editor toolbar, mode switch, and pane sizing rules.
- `01d-preview-reading.css`: redesign-layer preview surface and rendered Markdown rules for code, blockquotes, tasks, tables, KaTeX, and images.
- `01e-qa-modal-search.css`: redesign-layer Q&A panel, citations, modal shell, prompt dialog, search form/results, and related responsive rules.
- `02-visual-material.css`: original visual polish baseline for desktop editor, vault, preview, and Q&A surfaces.
- `02b-material-comfort.css`: historical material comfort pass for flatter surfaces, relaxed spacing, core app controls, and modal/search foundations.
- `02c-font-utility-controls.css`: historical font clarity, spinner, language switcher, editor FAB, back-to-top, and mobile input/toolbar utility rules.
- `02d-mobile-workbench.css`: historical mobile workbench refinements, segmented view controls, undo toast, tactile press feedback, and modal entrance motion.
- `03-mobile-chrome.css`: mobile section headers, icon buttons, pane chrome, overflow menu, bottom action sheet, and desktop hide guard.
- `03b-mobile-draft-tabs.css`: quick-note draft tab, tab-strip add button, image logo reset, selected folder cue, and draft pill rules.
- `03c-editor-first-mobile.css`: editor-first mobile app bar, workspace viewport lock, editor main pane, vault drawer, ask sheet, and mobile overlay backdrop.
- `04-print-surface.css`: hidden print surface and print media rules.
- `04b-file-management.css`: folder picker, path picker, tree context menu, drop target, and vault toolbar rules.
- `04c-focus-mode.css`: zen/focus mode layout and exit button rules.
- `04d-syntax-highlighting.css`: highlight.js token colors for dark and light themes.
- `05-flat-ui.css`: desktop toolbar, tab strip, command menu, desktop sheet, and local flat editor cleanup.
- `05b-flat-site-cleanup.css`: site-wide flat UI cleanup, anti-glass reset, primary actions, light-mode interaction states, and anchor scroll margins. It stays in the same `flat-ui` layer as `05` so the split does not change cascade priority.
- `06-minimalist-theme.css`: minimalist compatibility rules, desktop pane collapse, vault tree rendering optimization, and early flat state cleanup.
- `06b-minimalist-surface-rules.css`: current minimalist surface, button, row, modal, input, and status rules. It stays in the same `minimalist` layer as `06` so the split does not change cascade priority.
- `07-typography-mobile-polish.css`: shared type-size normalization and mobile input zoom prevention.
- `07b-mobile-minimalist-controls.css`: mobile tab strip, sheet, app-bar, and FAB polish. It stays in the same `type-mobile-polish` layer as `07` so the split does not change cascade priority.
- `08-current-theme-tokens.css`: canonical current palette, legacy token aliases, shape tokens, state tokens, and document tokens.
- `09-current-theme-overrides.css`: final app chrome, radius, command menu, mobile containment, focus exit, and Muya loading rules.
- `09b-markdown-heading-scale.css`: final rendered Markdown heading scale for preview and Q&A.
- `09c-tonal-state-rules.css`: final hover, focus, selected, and active tonal state rules.
- `09d-document-theme.css`: final rendered Markdown document theme and light-mode reading cleanup.
- `10-copilot-panel.css`: Copilot panel shell, toolbar, history, and context chip rules.
- `10b-copilot-chat-messages.css`: Copilot chat log, messages, sources, tool cards, and proposal rules.
- `10c-copilot-composer.css`: Copilot note picker, composer, input shell, and save modal rules.
- `10d-copilot-mobile.css`: Copilot mobile full-screen panel and responsive overrides. All Copilot partials import into the same final layer as `09` so their cascade position stays equivalent to the old monolithic override file.

## Layer Contract

The current layer order is:

`vendor -> legacy-base -> redesign-workspace -> material -> mobile-chrome -> feature-rules -> flat-ui -> minimalist -> type-mobile-polish -> theme-tokens -> current-theme-overrides`

Rules in later layers win over earlier layers at the same origin and importance. This replaces the old implicit "file name order" dependency with an explicit browser cascade contract.

Treat `00` through `07` as frozen compatibility layers. Do not add new product styling there during normal feature work. Move active theme values to `08`, shared app component rules to `09`, and feature-owned final rules to a focused partial such as `10-copilot-panel.css` imported into the existing final layer.

## Where To Edit

- Current light/dark theme values belong in `08-current-theme-tokens.css`.
- Historical legacy-base rules are split across `00`, `00b`, `00c`, and `00d`. Prefer editing current equivalents in later layers; only touch these files when preserving or untangling the original app styling.
- Historical redesign workspace rules are split across `01`, `01b`, `01c`, `01d`, and `01e`. Prefer editing current equivalents in later layers; only touch these files when preserving or untangling the first redesign pass.
- Historical material-layer rules are split across `02`, `02b`, `02c`, and `02d`. Prefer editing current equivalents in later layers; only touch these files when preserving or untangling the old material pass.
- Current minimalist surface/component rules belong in `06b-minimalist-surface-rules.css`.
- Final app chrome rules belong in `09-current-theme-overrides.css`; Markdown heading scale belongs in `09b-markdown-heading-scale.css`; tonal state rules belong in `09c-tonal-state-rules.css`; rendered document theme rules belong in `09d-document-theme.css`.
- Copilot shell/history/context rules belong in `10-copilot-panel.css`; chat/message rules belong in `10b-copilot-chat-messages.css`; composer/note-picker rules belong in `10c-copilot-composer.css`; mobile overrides belong in `10d-copilot-mobile.css`.
- Mobile chrome rules should stay in `03-mobile-chrome.css` for structural layout, or `07b-mobile-minimalist-controls.css` for final mobile visual polish.
- Mobile draft tab and editor-first overlay rules belong in `03b-mobile-draft-tabs.css` and `03c-editor-first-mobile.css`; keep them in the `mobile-chrome` layer unless deliberately changing cascade order.
- Print rules belong in `04-print-surface.css`; file-management rules belong in `04b-file-management.css`; focus mode belongs in `04c-focus-mode.css`; syntax highlighting belongs in `04d-syntax-highlighting.css`.
- Desktop toolbar, tab strip, and desktop command sheet rules belong in `05-flat-ui.css`; site-wide anti-glass and flat interaction cleanup belongs in `05b-flat-site-cleanup.css`.
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
- Keep the original legacy base split by concern. Root defaults and base controls stay in `00-legacy-base.css`; old workspace/editor/preview rules stay in `00b-legacy-workspace.css`; settings/indexing/forms/messages stay in `00c-legacy-settings-indexing.css`; old responsive and light-mode overrides stay in `00d-legacy-responsive-light.css`.
- Keep the first redesign pass split by ownership. Global shell and legacy grid rules stay in `01-redesign-workspace.css`; settings/indexing task IA stays in `01b-task-ia.css`; Obsidian workbench shell and pane sizing stay in `01c-workbench-shell.css`; rendered preview rules stay in `01d-preview-reading.css`; Q&A, modal, prompt, and search rules stay in `01e-qa-modal-search.css`.
- Keep the material compatibility pass split by concern. Baseline desktop visuals stay in `02-visual-material.css`; material comfort surfaces stay in `02b-material-comfort.css`; font and utility controls stay in `02c-font-utility-controls.css`; mobile workbench feedback stays in `02d-mobile-workbench.css`.
- Continue splitting the final override layer by feature ownership while keeping those files in the existing `current-theme-overrides` layer unless a deliberate cascade change is required.
- Keep final override partials scoped by ownership. Avoid putting app chrome, tonal states, rendered Markdown, and Copilot panel rules back into one shared override file. Keep Copilot shell, chat messages, composer, and mobile rules separate.
- Keep feature-rules partials scoped by behavior. Avoid putting print, file-management, focus mode, or syntax highlighting back into one shared patch file.
- Keep mobile chrome split by model. Section-header and action-sheet rules stay in `03-mobile-chrome.css`; quick-note/draft affordances stay in `03b-mobile-draft-tabs.css`; editor-first app-bar/drawer/sheet rules stay in `03c-editor-first-mobile.css`.
- Keep desktop flat UI mechanics and site-wide flat cleanup separate. Toolbar/tab/menu work belongs in `05-flat-ui.css`; global anti-glass, primary action, and light-mode cleanup belongs in `05b-flat-site-cleanup.css`.
- Keep typography and mobile visual cleanup separate. Type-size changes belong in `07-typography-mobile-polish.css`; mobile tabs, sheets, app-bar, and FAB rules belong in `07b-mobile-minimalist-controls.css`.
- Keep minimalist compatibility and current surface rules separate. Layout/performance compatibility remains in `06-minimalist-theme.css`; active minimalist surface rules belong in `06b-minimalist-surface-rules.css`.
- Keep third-party/editor isolation out of global app rules. Muya selectors should stay under `.muya-editor-shell` or its known floating wrappers.
- Any new z-index value should first become a token in `08-current-theme-tokens.css` unless it is isolated inside third-party editor CSS.

## Before Commit

- Run `npm run lint:css` after CSS structure changes.
- Run `git diff --check`.
- Run `npm run build` for CSS import or selector changes.
- Restart with `./server.sh restart` when the production preview should reflect the latest build.
- Check `https://127.0.0.1:4177/` after restart.
