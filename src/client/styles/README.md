# CSS Structure

`../styles.css` is the public entrypoint. Keep its `@import` order stable because the cascade order is currently part of the theme contract.

The partials are split by historical layer and behavior area:

- `00-legacy-base.css`: original base styles and early light-mode overrides.
- `01-redesign-workspace.css`: first redesign layer and workspace layout.
- `02-visual-material.css`: visual polish, material comfort, font clarity, and early mobile refinements.
- `03-mobile-chrome.css`: mobile section headers, overflow menu, and action sheet chrome.
- `04-print-file-management.css`: print surface, file-management UI, focus mode, and syntax highlighting.
- `05-flat-ui.css`: flat UI refactor and anti-glass component cleanup.
- `06-minimalist-theme.css`: minimalist theme unification and token-driven component surface rules.
- `07-typography-mobile-polish.css`: type scale plus mobile tab/menu/FAB refinements.
- `08-current-theme-overrides.css`: current palette, radius, editor focus, document reading, and final overrides.

Guidelines:

- Add new theme tokens in `08-current-theme-overrides.css` unless a token clearly belongs to an older compatibility layer.
- Prefer token changes over adding more raw color values.
- Avoid adding new `!important` rules unless they are overriding an existing compatibility layer.
- Keep Muya-specific rules in `../MuyaMarkdownEditor.css` when they only target the embedded editor.
