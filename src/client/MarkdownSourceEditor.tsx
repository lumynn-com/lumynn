import { useEffect, useMemo, useRef } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { bracketMatching, defaultHighlightStyle, foldGutter, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers
} from "@codemirror/view";
import "./MarkdownSourceEditor.css";

interface MarkdownSourceEditorProps {
  value: string;
  ariaLabel: string;
  autoFocus?: boolean;
  onChange: (value: string) => void;
}

const sourceEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    minHeight: "0",
    backgroundColor: "transparent",
    color: "var(--text)"
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
    lineHeight: "1.62"
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "1rem 0",
    caretColor: "var(--accent-2)"
  },
  ".cm-line": {
    padding: "0 1.35rem"
  },
  ".cm-gutters": {
    borderRight: "1px solid var(--owd-flat-divider, var(--border))",
    backgroundColor: "color-mix(in srgb, var(--panel) 72%, transparent)",
    color: "var(--muted)"
  },
  ".cm-activeLine": {
    backgroundColor: "var(--surface-hover)"
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--surface-hover)",
    color: "var(--text)"
  },
  ".cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--accent-2) 24%, transparent) !important"
  },
  "&.cm-focused": {
    outline: "none"
  },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "var(--accent-2)"
  }
});

const sourceEditorSetup = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  foldGutter(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  keymap.of([indentWithTab, ...defaultKeymap, ...searchKeymap, ...historyKeymap])
];

export function MarkdownSourceEditor(props: MarkdownSourceEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(props.value);
  const onChangeRef = useRef(props.onChange);
  const applyingExternalValueRef = useRef(false);

  useEffect(() => {
    onChangeRef.current = props.onChange;
  }, [props.onChange]);

  const extensions = useMemo(
    () => [
      sourceEditorSetup,
      markdown(),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        "aria-label": props.ariaLabel,
        spellcheck: "true"
      }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const nextValue = update.state.doc.toString();
        valueRef.current = nextValue;
        if (!applyingExternalValueRef.current) {
          onChangeRef.current(nextValue);
        }
      }),
      sourceEditorTheme
    ],
    [props.ariaLabel]
  );

  useEffect(() => {
    if (!hostRef.current) return;

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: valueRef.current,
        extensions
      })
    });
    viewRef.current = view;

    if (props.autoFocus) {
      window.setTimeout(() => view.focus(), 0);
    }

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [extensions, props.autoFocus]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentValue = view.state.doc.toString();
    if (props.value === currentValue) return;

    valueRef.current = props.value;
    applyingExternalValueRef.current = true;
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: props.value
      }
    });
    applyingExternalValueRef.current = false;
  }, [props.value]);

  useEffect(() => {
    if (props.autoFocus) viewRef.current?.focus();
  }, [props.autoFocus]);

  return <div ref={hostRef} className="markdown-source-editor" />;
}
