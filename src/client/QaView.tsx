import { useEffect, useState } from "react";
import type { MouseEvent } from "react";
import { api } from "./api";
import { BusyLabel } from "./icons";
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
  const t = useT();
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
    <aside className={`qa-view ${props.compact ? "qa-panel panel" : ""}`} aria-label={t("qa.eyebrow")}>
      <section className={props.compact ? "qa-hero" : "panel hero"}>
        <p className="eyebrow">{t("qa.eyebrow")}</p>
        {props.compact ? <h2>{t("qa.title")}</h2> : <h1>{t("qa.title")}</h1>}
        <p className="muted">{t("qa.description")}</p>
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
            autoComplete="off"
            value={state.question}
            onChange={(event) => setRuntimeState({ question: event.target.value })}
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
          <div className="panel-header">
            <div>
              <p className="eyebrow">{t("qa.answerEyebrow")}</p>
              <h2>{t("qa.answerTitle")}</h2>
            </div>
            {state.indexNamespace ? <span className="status-pill">{t("qa.sourceLabel", { name: state.indexNamespace })}</span> : null}
          </div>
          {state.retrievalWarning ? <div className="error">{t("qa.retrievalWarning", { message: state.retrievalWarning })}</div> : null}
          {state.providerError ? <div className="error">{t("qa.providerWarning", { message: state.providerError })}</div> : null}
          {state.answerHtml ? <article className="qa-answer" onClick={openAnswerReference} dangerouslySetInnerHTML={{ __html: state.answerHtml }} /> : <p>{state.answer}</p>}
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
              <strong>{citation.title}</strong>
              <span>{citation.path}</span>
            </button>
          </article>
        ))}
      </section>
    </aside>
  );
}
