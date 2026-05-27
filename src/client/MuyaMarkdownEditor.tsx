import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import {
  CodeBlockLanguageSelector,
  EmojiSelector,
  en,
  FootnoteTool,
  ImageEditTool,
  ImageResizeBar,
  ImageToolBar,
  InlineFormatToolbar,
  LinkTools,
  Muya,
  ParagraphFrontButton,
  ParagraphFrontMenu,
  ParagraphQuickInsertMenu,
  PreviewToolBar,
  TableColumnToolbar,
  TableDragBar,
  TableRowColumMenu,
  zhCN
} from "./vendor/muya";
import type { IMuyaOptions } from "./vendor/muya";
import { muyaToObsidianMarkdown, obsidianToMuyaMarkdown } from "./obsidianEmbeds";

import "./MuyaMarkdownEditor.css";

type MuyaLocale = "en" | "zh-CN";

export interface MuyaMarkdownEditorHandle {
  focus: () => void;
}

interface MuyaMarkdownEditorProps {
  value: string;
  documentPath?: string;
  language: MuyaLocale;
  autoFocus?: boolean;
  onChange: (nextMarkdown: string) => void;
  onPasteImage: (file: File) => Promise<string>;
}

type MuyaWithInsert = Muya & {
  insertMarkdownAtSelection?: (markdown: string) => void;
};

const LOCALES = {
  en,
  "zh-CN": zhCN
} as const;

let pluginsRegistered = false;

function ensureMuyaPlugins(): void {
  if (pluginsRegistered) return;
  pluginsRegistered = true;
  const usePlugin = Muya.use.bind(Muya) as (plugin: unknown, options?: Record<string, unknown>) => void;

  usePlugin(EmojiSelector);
  usePlugin(FootnoteTool);
  usePlugin(InlineFormatToolbar);
  usePlugin(ImageEditTool);
  usePlugin(ImageToolBar);
  usePlugin(ImageResizeBar);
  usePlugin(CodeBlockLanguageSelector);
  usePlugin(LinkTools, {
    jumpClick: (linkInfo: { href?: string } | null) => {
      const href = linkInfo?.href;
      if (href && /^https?:\/\//.test(href)) {
        window.open(href, "_blank", "noopener,noreferrer");
      }
    }
  });
  usePlugin(ParagraphFrontButton);
  usePlugin(ParagraphFrontMenu);
  usePlugin(ParagraphQuickInsertMenu);
  usePlugin(TableColumnToolbar);
  usePlugin(TableDragBar);
  usePlugin(TableRowColumMenu);
  usePlugin(PreviewToolBar);
}

function createMuyaOptions(markdown: string): Partial<IMuyaOptions> {
  return {
    markdown,
    frontMatter: true,
    footnote: true,
    math: true,
    superSubScript: true,
    isGitlabCompatibilityEnabled: true,
    codeBlockLineNumbers: true,
    focusMode: false,
    spellcheckEnabled: false,
    disableHtml: false,
    autoPairBracket: true,
    autoPairMarkdownSyntax: true,
    autoPairQuote: true,
    autoCheck: false,
    autoMoveCheckedToEnd: false,
    preferLooseListItem: true,
    hideQuickInsertHint: false,
    hideLinkPopup: false,
    trimUnnecessaryCodeBlockEmptyLines: false,
    bulletListMarker: "-",
    orderListDelimiter: ".",
    frontmatterType: "-",
    mermaidTheme: "default",
    vegaTheme: "latimes",
    fontSize: 16,
    lineHeight: 1.6,
    tabSize: 4,
    listIndentation: 1
  };
}

export const MuyaMarkdownEditor = forwardRef<MuyaMarkdownEditorHandle, MuyaMarkdownEditorProps>(function MuyaMarkdownEditor(
  { value, documentPath, language, autoFocus = false, onChange, onPasteImage },
  ref
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const muyaRef = useRef<MuyaWithInsert | null>(null);
  const onChangeRef = useRef(onChange);
  const onPasteImageRef = useRef(onPasteImage);
  const suppressChangeRef = useRef(false);
  const lastEmittedValueRef = useRef<string | null>(null);
  const renderedValue = useMemo(() => obsidianToMuyaMarkdown(value, documentPath), [documentPath, value]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onPasteImageRef.current = onPasteImage;
  }, [onPasteImage]);

  useImperativeHandle(ref, () => ({
    focus: () => {
      muyaRef.current?.focus();
    }
  }), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    ensureMuyaPlugins();
    const mount = document.createElement("div");
    mount.className = "muya-editor-host";
    host.replaceChildren(mount);

    const muya = new Muya(mount, createMuyaOptions(renderedValue)) as MuyaWithInsert;
    muya.locale(LOCALES[language]);
    muya.init();
    muyaRef.current = muya;
    lastEmittedValueRef.current = value;

    const handleChange = () => {
      if (suppressChangeRef.current) return;
      const next = muyaToObsidianMarkdown(muya.getMarkdown());
      lastEmittedValueRef.current = next;
      onChangeRef.current(next);
    };

    const handlePasteCapture = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
      if (files.length === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      files.forEach((file) => {
        void onPasteImageRef.current(file).then((snippet) => {
          const editor = muyaRef.current;
          if (!editor) return;
          if (typeof editor.insertMarkdownAtSelection === "function") {
            editor.insertMarkdownAtSelection(snippet);
          } else {
            editor.setContent(`${editor.getMarkdown()}${snippet}`, true);
          }
          handleChange();
        });
      });
    };

    muya.on("json-change", handleChange);
    muya.domNode.addEventListener("paste", handlePasteCapture, true);

    if (autoFocus) {
      window.setTimeout(() => muya.focus(), 50);
    }

    return () => {
      muya.domNode.removeEventListener("paste", handlePasteCapture, true);
      muya.off("json-change", handleChange);
      muya.destroy();
      muyaRef.current = null;
    };
  }, [autoFocus, language]);

  useEffect(() => {
    const muya = muyaRef.current;
    if (!muya) return;
    if (value === lastEmittedValueRef.current) return;
    suppressChangeRef.current = true;
    muya.setContent(renderedValue, false);
    suppressChangeRef.current = false;
  }, [renderedValue, value]);

  return <div ref={hostRef} className="muya-editor-shell" />;
});
