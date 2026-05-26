import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { api } from "./api";
import { AskIcon, BusyLabel, ChevronLeftIcon, ChevronRightIcon } from "./icons";
import { useT } from "./i18n";

type Citation = { path: string; title: string; snippet: string };

interface SavedQaState {
  question: string;
  answer: string;
  answerHtml: string;
  citations: Citation[];
  indexNamespace: string;
  retrievalWarning: string;
  providerError: string;
}

interface QaState extends SavedQaState {
  loading: boolean;
  error: string;
}

// Q&A state used to live under a single localStorage key, but in
// the multi-user world that bled the previous user's last
// question/answer/citations into the next user's session on the
// same browser. Now the key is namespaced by username and the
// module-level cache is keyed by the same name; switching to a
// different account starts from a clean slate but switching back
// rehydrates the same person's last view.
const QA_STATE_KEY_PREFIX = "owd_qa_state:";

function qaStateKey(username: string): string {
  return `${QA_STATE_KEY_PREFIX}${username}`;
}

const emptyQaState: SavedQaState = {
  question: "",
  answer: "",
  answerHtml: "",
  citations: [],
  indexNamespace: "",
  retrievalWarning: "",
  providerError: ""
};

function readSavedQaState(username: string): SavedQaState {
  try {
    if (typeof localStorage === "undefined") {
      return emptyQaState;
    }
    return { ...emptyQaState, ...JSON.parse(localStorage.getItem(qaStateKey(username)) ?? "{}") };
  } catch {
    return emptyQaState;
  }
}

function writeSavedQaState(username: string, state: SavedQaState): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.setItem(qaStateKey(username), JSON.stringify(state));
}

const emptyRuntimeState: QaState = {
  ...emptyQaState,
  loading: false,
  error: ""
};
// Module-level cache so the QA panel can stay populated across
// remounts (e.g. switching between Workspace and Settings tabs).
// We tag it with the username it belongs to; if a different user
// shows up we throw it away and reload.
let runtimeState: QaState | null = null;
let runtimeStateUsername: string | null = null;
const stateListeners = new Set<(state: QaState) => void>();

function pickSavedState(state: QaState): SavedQaState {
  return {
    question: state.question,
    answer: state.answer,
    answerHtml: state.answerHtml,
    citations: state.citations,
    indexNamespace: state.indexNamespace,
    retrievalWarning: state.retrievalWarning,
    providerError: state.providerError
  };
}

function getRuntimeState(username: string): QaState {
  if (!runtimeState || runtimeStateUsername !== username) {
    // First mount, or the active username changed (logout +
    // login as somebody else). Throw away whatever was cached
    // for the old user and seed from the new user's saved state.
    runtimeState = {
      ...emptyRuntimeState,
      ...readSavedQaState(username)
    };
    runtimeStateUsername = username;
  }
  return runtimeState;
}

function setRuntimeState(username: string, patch: Partial<QaState>): QaState {
  runtimeState = {
    ...getRuntimeState(username),
    ...patch
  };
  runtimeStateUsername = username;
  writeSavedQaState(username, pickSavedState(runtimeState));
  stateListeners.forEach((listener) => listener(runtimeState!));
  return runtimeState;
}

function subscribeQaState(username: string, listener: (state: QaState) => void): () => void {
  stateListeners.add(listener);
  listener(getRuntimeState(username));
  return () => {
    stateListeners.delete(listener);
  };
}

async function runAsk(username: string, question: string): Promise<void> {
  const trimmedQuestion = question.trim();
  if (!trimmedQuestion || getRuntimeState(username).loading) {
    return;
  }

  setRuntimeState(username, {
    question,
    loading: true,
    error: "",
    retrievalWarning: "",
    providerError: ""
  });

  try {
    const result = await api<{
      answer: string;
      answerHtml?: string;
      indexNamespace?: string;
      retrievalWarning?: string;
      providerError?: string;
      citations: Citation[];
    }>("/api/rag/query", {
      method: "POST",
      body: JSON.stringify({ question: trimmedQuestion })
    });
    setRuntimeState(username, {
      answer: result.answer,
      answerHtml: result.answerHtml ?? "",
      indexNamespace: result.indexNamespace ?? "",
      retrievalWarning: result.retrievalWarning ?? "",
      providerError: result.providerError ?? "",
      citations: result.citations,
      loading: false
    });
  } catch (err) {
    setRuntimeState(username, {
      error: err instanceof Error ? err.message : "Unable to answer",
      loading: false
    });
  }
}

export function QaView(props: {
  compact?: boolean;
  username?: string;
  onOpenSource?: (path: string) => void;
  // Desktop side-panel collapse. When `collapsed` is true the
  // panel CSS shrinks the qa-panel to a 44px rail; the rail
  // surfaces an expand button so the user can bring the full
  // panel back. The toggle is only meaningful when this view is
  // mounted inside the workspace (compact mode).
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const t = useT();
  // The username is required for state isolation. Default to a
  // sentinel so QA still works during the brief moment between
  // auth resolution and the prop arriving (and so the type stays
  // optional for any callers that haven't been threaded yet).
  const username = props.username || "__anonymous__";
  const [state, setState] = useState(() => getRuntimeState(username));
  const answerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    return subscribeQaState(username, setState);
  }, [username]);

  async function ask() {
    await runAsk(username, state.question);
  }

  function dispatchCitationFromTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element) || !props.onOpenSource) return false;
    const link = target.closest<HTMLAnchorElement>("a[href^='#source-']");
    if (!link) return false;
    const sourceIndex = Number.parseInt(link.getAttribute("href")?.replace("#source-", "") ?? "", 10) - 1;
    const citation = state.citations[sourceIndex];
    if (!citation) return false;
    props.onOpenSource(citation.path);
    return true;
  }

  function openAnswerReference(event: MouseEvent<HTMLElement>) {
    if (dispatchCitationFromTarget(event.target)) {
      event.preventDefault();
    }
  }

  // Belt-and-braces: attach a native click listener on the rendered
  // answer in addition to the React onClick. Some mobile Chromium
  // builds drop synthetic clicks that travel through
  // dangerouslySetInnerHTML content with anchor children, which
  // breaks the citation links inside the AI answer on phones. The
  // native listener runs in the capture phase and does the same
  // open + preventDefault.
  useEffect(() => {
    const node = answerRef.current;
    if (!node) return;
    function handleClick(event: Event) {
      if (dispatchCitationFromTarget(event.target)) {
        event.preventDefault();
      }
    }
    node.addEventListener("click", handleClick, { capture: true });
    return () => node.removeEventListener("click", handleClick, { capture: true } as EventListenerOptions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.answerHtml, state.citations]);

  return (
    <aside
      className={`qa-view ${props.compact ? "qa-panel panel" : ""}`}
      aria-label={t("qa.eyebrow")}
      data-collapsed={props.compact && props.collapsed ? "true" : undefined}
    >
      {props.compact && props.onToggleCollapsed ? (
        // Collapsed rail (desktop only) - 44px wide column with
        // just an expand button + an icon hint. CSS swaps which
        // of these is visible based on the data-collapsed
        // attribute on the <aside>. inert keeps the rail out of
        // the keyboard tab order and the a11y tree whenever the
        // panel is expanded, so the active toolbar / form is the
        // only thing reachable via Tab.
        <div
          className="pane-collapsed-rail desktop-only"
          inert={!props.collapsed}
          aria-hidden={!props.collapsed || undefined}
        >
          <button
            type="button"
            className="icon-button pane-expand-toggle"
            aria-label={t("qa.expand")}
            title={t("qa.expand")}
            onClick={props.onToggleCollapsed}
          >
            <ChevronLeftIcon />
          </button>
          <span className="pane-collapsed-icon" aria-hidden="true">
            <AskIcon />
          </span>
        </div>
      ) : null}
      <section className={props.compact ? "qa-hero" : "panel hero"}>
        {/* Top row: collapse toggle + eyebrow. The button shares
            a flex row with the small eyebrow label so it doesn't
            push the title / ask-row to the right (regression we
            had when the button was absolutely positioned). When
            the collapse toggle isn't applicable (full-page Q&A
            or mobile) we just render the eyebrow alone. */}
        {props.compact && props.onToggleCollapsed ? (
          <div className="qa-hero-top desktop-only">
            <button
              type="button"
              className="icon-button pane-collapse-toggle qa-collapse-toggle"
              aria-label={t("qa.collapse")}
              title={t("qa.collapse")}
              onClick={props.onToggleCollapsed}
            >
              <ChevronRightIcon />
            </button>
            <p className="eyebrow">{t("qa.eyebrow")}</p>
          </div>
        ) : (
          <p className="eyebrow desktop-only">{t("qa.eyebrow")}</p>
        )}
        {props.compact ? <h2 className="desktop-only">{t("qa.title")}</h2> : <h1>{t("qa.title")}</h1>}
        <p className="muted desktop-only">{t("qa.description")}</p>
        <form
          className="ask-row"
          onSubmit={(event) => {
            event.preventDefault();
            ask();
          }}
        >
          <label className="sr-only" htmlFor="qa-question">{t("qa.question")}</label>
          <input
            id="qa-question"
            name="question"
            type="search"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            value={state.question}
            onChange={(event) => setRuntimeState(username, { question: event.target.value })}
            placeholder={t("qa.placeholder")}
          />
          <button
            className={state.loading ? "query-button query-loading" : "primary query-button"}
            type="submit"
            disabled={!state.question || state.loading}
            aria-busy={state.loading}
          >
            <BusyLabel busy={state.loading} busyText={t("qa.submitBusy")}>{t("qa.submit")}</BusyLabel>
          </button>
        </form>
        {state.loading ? <div className="status-pill qa-query-state" aria-live="polite">{t("qa.runningHint")}</div> : null}
        {state.error ? <div className="error" aria-live="polite">{state.error}</div> : null}
      </section>
      {state.answer ? (
        <section className={props.compact ? "qa-response" : "panel"}>
          {/* The eyebrow + h2 ("Answer / Response") panel-header was
              removed: it duplicated the Q&A pane label at the top
              and pushed the actual answer below the fold on the
              compact sidebar. The source/namespace tag, when
              present, now sits as a single inline pill. */}
          {state.indexNamespace ? (
            <div className="qa-response-meta">
              <span className="status-pill">{t("qa.sourceLabel", { name: state.indexNamespace })}</span>
            </div>
          ) : null}
          {state.retrievalWarning ? <div className="error">{t("qa.retrievalWarning", { message: state.retrievalWarning })}</div> : null}
          {state.providerError ? <div className="error">{t("qa.providerWarning", { message: state.providerError })}</div> : null}
          {state.answerHtml ? (
            <article
              ref={answerRef}
              className="qa-answer"
              onClick={openAnswerReference}
              dangerouslySetInnerHTML={{ __html: state.answerHtml }}
            />
          ) : (
            <p>{state.answer}</p>
          )}
        </section>
      ) : null}
      <section className="citation-grid">
        {state.answer && state.citations.length === 0 ? <div className="empty-state">{t("qa.noCitations")}</div> : null}
        {state.citations.map((citation, index) => (
          <article className={`${props.compact ? "" : "panel"} citation`} key={`${citation.path}-${index}`}>
            <button
              className="citation-source"
              type="button"
              onClick={() => props.onOpenSource?.(citation.path)}
              disabled={!props.onOpenSource}
            >
              <strong translate="no">{citation.title}</strong>
              <span translate="no">{citation.path}</span>
            </button>
          </article>
        ))}
      </section>
    </aside>
  );
}
