import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { Muya } from "./vendor/muya/muya";
import { en, zhCN } from "./vendor/muya/locales";
import type { IMuyaOptions } from "./vendor/muya/types";

import "./MuyaMarkdownEditor.css";

type MuyaLocale = "en" | "zh-CN";

export interface MuyaMarkdownEditorHandle {
  focus: () => void;
}

interface MuyaMarkdownEditorProps {
  value: string;
  language: MuyaLocale;
  autoFocus?: boolean;
  onChange: (nextMarkdown: string) => void;
}

const LOCALES = {
  en,
  "zh-CN": zhCN
} as const;

function exposeDebugMarkdown(key: string, markdown: string): void {
  (window as unknown as Record<string, unknown>)[key] = markdown;
  console.debug(`${key}:`, JSON.stringify(markdown));
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
    preferLooseListItem: false,
    hideQuickInsertHint: true,
    hideLinkPopup: false,
    trimUnnecessaryCodeBlockEmptyLines: false,
    bulletListMarker: "-",
    orderListDelimiter: ".",
    frontmatterType: "-",
    mermaidTheme: "default",
    vegaTheme: "latimes",
    fontSize: 16,
    lineHeight: 1.65,
    tabSize: 4,
    listIndentation: 1
  };
}

export const MuyaMarkdownEditor = forwardRef<MuyaMarkdownEditorHandle, MuyaMarkdownEditorProps>(function MuyaMarkdownEditor(
  { value, language, autoFocus = false, onChange },
  ref
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const muyaRef = useRef<Muya | null>(null);
  const onChangeRef = useRef(onChange);
  const lastEmittedValueRef = useRef<string | null>(null);
  const initialValue = useMemo(() => value, []);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useImperativeHandle(ref, () => ({
    focus: () => {
      muyaRef.current?.focus();
    }
  }), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const mount = document.createElement("div");
    mount.className = "muya-editor-host";
    host.replaceChildren(mount);

    const muya = new Muya(mount, createMuyaOptions(initialValue));
    muya.locale(LOCALES[language]);
    muya.init();
    muyaRef.current = muya;
    lastEmittedValueRef.current = initialValue;

    const handleChange = () => {
      const next = muya.getMarkdown();
      if (next === lastEmittedValueRef.current) return;
      lastEmittedValueRef.current = next;
      exposeDebugMarkdown("__OWD_LAST_MUYA_MARKDOWN__", next);
      onChangeRef.current(next);
    };

    muya.on("json-change", handleChange);

    if (autoFocus) {
      window.setTimeout(() => muya.focus(), 50);
    }

    return () => {
      muya.off("json-change", handleChange);
      muya.destroy();
      muyaRef.current = null;
    };
  }, [autoFocus, initialValue, language]);

  return <div ref={hostRef} className="muya-editor-shell" />;
});
