import { useEffect, useState } from "react";
import type { MouseEvent } from "react";
import { api } from "./api";
import { BusyLabel } from "./icons";

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

const qaStateStorageKey = "owd_qa_state";
const emptyQaState: SavedQaState = {
  question: "",
  answer: "",
  answerHtml: "",
  citations: [],
  indexNamespace: "",
  retrievalWarning: "",
  providerError: ""
};

function readSavedQaState(): SavedQaState {
  try {
    if (typeof localStorage === "undefined") {
      return emptyQaState;
    }
    return { ...emptyQaState, ...JSON.parse(localStorage.getItem(qaStateStorageKey) ?? "{}") };
  } catch {
    return emptyQaState;
  }
}

function writeSavedQaState(state: SavedQaState): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.setItem(qaStateStorageKey, JSON.stringify(state));
}

const emptyRuntimeState: QaState = {
  ...emptyQaState,
  loading: false,
  error: ""
};
let runtimeState: QaState | null = null;
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

function getRuntimeState(): QaState {
  if (!runtimeState) {
    runtimeState = {
      ...emptyRuntimeState,
      ...readSavedQaState()
    };
  }
  return runtimeState;
}

function setRuntimeState(patch: Partial<QaState>): QaState {
  runtimeState = {
    ...getRuntimeState(),
    ...patch
  };
  writeSavedQaState(pickSavedState(runtimeState));
  stateListeners.forEach((listener) => listener(runtimeState!));
  return runtimeState;
}

function subscribeQaState(listener: (state: QaState) => void): () => void {
  stateListeners.add(listener);
  listener(getRuntimeState());
  return () => stateListeners.delete(listener);
}

async function runAsk(question: string): Promise<void> {
  const trimmedQuestion = question.trim();
  if (!trimmedQuestion || getRuntimeState().loading) {
    return;
  }

  setRuntimeState({
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
    setRuntimeState({
      answer: result.answer,
      answerHtml: result.answerHtml ?? "",
      indexNamespace: result.indexNamespace ?? "",
      retrievalWarning: result.retrievalWarning ?? "",
      providerError: result.providerError ?? "",
      citations: result.citations,
      loading: false
    });
  } catch (err) {
    setRuntimeState({
      error: err instanceof Error ? err.message : "Unable to answer",
      loading: false
    });
  }
}

export function QaView(props: { compact?: boolean; onOpenSource?: (path: string) => void }) {
  const [state, setState] = useState(getRuntimeState);

  useEffect(() => {
    return subscribeQaState(setState);
  }, []);

  async function ask() {
    await runAsk(state.question);
  }

  function openAnswerReference(event: MouseEvent<HTMLElement>) {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href^='#source-']");
    if (!link) {
      return;
    }
    const sourceIndex = Number.parseInt(link.getAttribute("href")?.replace("#source-", "") ?? "", 10) - 1;
    const citation = state.citations[sourceIndex];
    if (!citation || !props.onOpenSource) {
      return;
    }
    event.preventDefault();
    props.onOpenSource(citation.path);
  }

  return (
    <aside className={`qa-view ${props.compact ? "qa-panel panel" : ""}`} aria-label="Ask AI">
      <section className={props.compact ? "qa-hero" : "panel hero"}>
        <p className="eyebrow">Ask AI</p>
        {props.compact ? <h2>Ask your vault</h2> : <h1>Ask your vault</h1>}
        <p className="muted">Get answers grounded in indexed Markdown notes, with citations you can inspect.</p>
        <form
          className="ask-row"
          onSubmit={(event) => {
            event.preventDefault();
            ask();
          }}
        >
          <label className="sr-only" htmlFor="qa-question">Question</label>
          <input
            id="qa-question"
            name="question"
            autoComplete="off"
            value={state.question}
            onChange={(event) => setRuntimeState({ question: event.target.value })}
            placeholder="Example: What did I write about this project?"
          />
          <button
            className={state.loading ? "query-button query-loading" : "primary query-button"}
            type="submit"
            disabled={!state.question || state.loading}
            aria-busy={state.loading}
          >
            <BusyLabel busy={state.loading} busyText={"Querying\u2026"}>Ask Vault</BusyLabel>
          </button>
        </form>
        {state.loading ? <div className="status-pill qa-query-state" aria-live="polite">Query is running. You can switch pages and come back.</div> : null}
        {state.error ? <div className="error" aria-live="polite">{state.error}</div> : null}
      </section>
      {state.answer ? (
        <section className={props.compact ? "qa-response" : "panel"}>
          <div className="panel-header">
            <div>
              <p className="eyebrow">Answer</p>
              <h2>Response</h2>
            </div>
            {state.indexNamespace ? <span className="status-pill">Source: {state.indexNamespace}</span> : null}
          </div>
          {state.retrievalWarning ? <div className="error">Retrieval warning: {state.retrievalWarning}</div> : null}
          {state.providerError ? <div className="error">Provider warning: {state.providerError}</div> : null}
          {state.answerHtml ? <article className="qa-answer" onClick={openAnswerReference} dangerouslySetInnerHTML={{ __html: state.answerHtml }} /> : <p>{state.answer}</p>}
        </section>
      ) : null}
      <section className="citation-grid">
        {state.answer && state.citations.length === 0 ? <div className="empty-state">No citations returned. Rebuild or resume the index, then ask again.</div> : null}
        {state.citations.map((citation, index) => (
          <article className={`${props.compact ? "" : "panel"} citation`} key={`${citation.path}-${index}`}>
            <button
              className="citation-source"
              type="button"
              onClick={() => props.onOpenSource?.(citation.path)}
              disabled={!props.onOpenSource}
            >
              <strong>{citation.title}</strong>
              <span>{citation.path}</span>
            </button>
          </article>
        ))}
      </section>
    </aside>
  );
}
