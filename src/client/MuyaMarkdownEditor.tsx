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
    preferLooseListItem: false,
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

const MUYA_FLOAT_TOOLTIP_SELECTOR = [
  ".mu-float-wrapper [title]",
  ".mu-float-wrapper [data-tooltip]",
  ".mu-front-button-wrapper [title]",
  ".mu-front-button-wrapper [data-tooltip]"
].join(", ");

function closestMuyaFloatTooltipTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest(MUYA_FLOAT_TOOLTIP_SELECTOR) as HTMLElement | null;
}

function installMuyaFloatTooltips(): () => void {
  let activeTarget: HTMLElement | null = null;
  let tooltipElement: HTMLDivElement | null = null;
  let restoreTitle: string | null = null;
  let frameId = 0;

  function positionTooltip() {
    if (!activeTarget || !tooltipElement) return;

    const rect = activeTarget.getBoundingClientRect();
    const gap = 8;
    const margin = 8;
    const width = tooltipElement.offsetWidth;
    const height = tooltipElement.offsetHeight;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    let left = rect.left + rect.width / 2 - width / 2;
    let top = rect.top - height - gap;

    if (top < margin) {
      top = rect.bottom + gap;
    }
    if (top + height > viewportHeight - margin) {
      top = Math.max(margin, viewportHeight - height - margin);
    }

    left = Math.max(margin, Math.min(left, viewportWidth - width - margin));
    tooltipElement.style.left = `${Math.round(left)}px`;
    tooltipElement.style.top = `${Math.round(top)}px`;
  }

  function hideTooltip() {
    if (frameId) {
      window.cancelAnimationFrame(frameId);
      frameId = 0;
    }
    if (activeTarget && restoreTitle !== null && activeTarget.isConnected) {
      activeTarget.setAttribute("title", restoreTitle);
    }
    restoreTitle = null;
    activeTarget = null;
    tooltipElement?.remove();
    tooltipElement = null;
  }

  function showTooltip(target: HTMLElement) {
    const text = target.dataset.tooltip || target.getAttribute("title") || "";
    if (!text.trim()) return;
    if (target === activeTarget) {
      positionTooltip();
      return;
    }

    hideTooltip();
    activeTarget = target;
    restoreTitle = target.getAttribute("title");
    if (restoreTitle !== null) {
      target.removeAttribute("title");
    }

    tooltipElement = document.createElement("div");
    tooltipElement.className = "owd-muya-tooltip";
    tooltipElement.textContent = text;
    document.body.appendChild(tooltipElement);

    frameId = window.requestAnimationFrame(() => {
      frameId = 0;
      positionTooltip();
      tooltipElement?.classList.add("active");
    });
  }

  function handleMouseOver(event: MouseEvent) {
    const target = closestMuyaFloatTooltipTarget(event.target);
    if (target) showTooltip(target);
  }

  function handleMouseOut(event: MouseEvent) {
    if (!activeTarget) return;
    if (event.relatedTarget instanceof Node && activeTarget.contains(event.relatedTarget)) return;
    if (event.target instanceof Node && activeTarget.contains(event.target)) {
      hideTooltip();
      return;
    }
    if (!activeTarget.isConnected) hideTooltip();
  }

  function handleFocusIn(event: FocusEvent) {
    const target = closestMuyaFloatTooltipTarget(event.target);
    if (target) showTooltip(target);
  }

  function handleFocusOut(event: FocusEvent) {
    if (activeTarget && event.target instanceof Node && activeTarget.contains(event.target)) {
      hideTooltip();
    }
  }

  function handleMouseMove() {
    if (activeTarget && activeTarget.isConnected) {
      positionTooltip();
    } else {
      hideTooltip();
    }
  }

  document.addEventListener("mouseover", handleMouseOver, true);
  document.addEventListener("mouseout", handleMouseOut, true);
  document.addEventListener("focusin", handleFocusIn, true);
  document.addEventListener("focusout", handleFocusOut, true);
  document.addEventListener("mousemove", handleMouseMove, true);
  document.addEventListener("click", hideTooltip, true);
  window.addEventListener("scroll", hideTooltip, true);
  window.addEventListener("resize", hideTooltip);

  return () => {
    document.removeEventListener("mouseover", handleMouseOver, true);
    document.removeEventListener("mouseout", handleMouseOut, true);
    document.removeEventListener("focusin", handleFocusIn, true);
    document.removeEventListener("focusout", handleFocusOut, true);
    document.removeEventListener("mousemove", handleMouseMove, true);
    document.removeEventListener("click", hideTooltip, true);
    window.removeEventListener("scroll", hideTooltip, true);
    window.removeEventListener("resize", hideTooltip);
    hideTooltip();
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

  useEffect(() => installMuyaFloatTooltips(), []);

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
    // Diagnostic guard: file switches remount this component via
    // `key={active.path}`, so skip in-place Muya rehydration for
    // external value updates while we verify whether setContent()
    // is causing scroll/caret jumps during autosave.
    lastEmittedValueRef.current = value;
  }, [value]);

  return <div ref={hostRef} className="muya-editor-shell" />;
});
