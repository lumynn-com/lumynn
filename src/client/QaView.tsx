import { useState } from "react";
import { api } from "./api";

export function QaView() {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [answerHtml, setAnswerHtml] = useState("");
  const [citations, setCitations] = useState<Array<{ path: string; title: string; snippet: string }>>([]);
  const [indexNamespace, setIndexNamespace] = useState("");
  const [retrievalWarning, setRetrievalWarning] = useState("");
  const [providerError, setProviderError] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function ask() {
    if (!question.trim() || loading) {
      return;
    }
    setLoading(true);
    setError("");
    setRetrievalWarning("");
    setProviderError("");
    try {
      const result = await api<{
        answer: string;
        answerHtml?: string;
        indexNamespace?: string;
        retrievalWarning?: string;
        providerError?: string;
        citations: Array<{ path: string; title: string; snippet: string }>;
      }>("/api/rag/query", {
        method: "POST",
        body: JSON.stringify({ question })
      });
      setAnswer(result.answer);
      setAnswerHtml(result.answerHtml ?? "");
      setIndexNamespace(result.indexNamespace ?? "");
      setRetrievalWarning(result.retrievalWarning ?? "");
      setProviderError(result.providerError ?? "");
      setCitations(result.citations);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to answer");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="qa-view">
      <section className="panel hero">
        <p className="eyebrow">Ask AI</p>
        <h1>Ask your vault</h1>
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
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Example: What did I write about this project?"
          />
          <button className="primary" type="submit" disabled={!question || loading}>
            {loading ? "Asking..." : "Ask Vault"}
          </button>
        </form>
        {error ? <div className="error" aria-live="polite">{error}</div> : null}
      </section>
      {answer ? (
        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Answer</p>
              <h2>Response</h2>
            </div>
            {indexNamespace ? <span className="status-pill">Source: {indexNamespace}</span> : null}
          </div>
          {retrievalWarning ? <div className="error">Retrieval warning: {retrievalWarning}</div> : null}
          {providerError ? <div className="error">Provider warning: {providerError}</div> : null}
          {answerHtml ? <article className="qa-answer" dangerouslySetInnerHTML={{ __html: answerHtml }} /> : <p>{answer}</p>}
        </section>
      ) : null}
      <section className="citation-grid">
        {answer && citations.length === 0 ? <div className="empty-state">No citations returned. Rebuild or resume the index, then ask again.</div> : null}
        {citations.map((citation) => (
          <article className="panel citation" key={`${citation.path}-${citation.snippet}`}>
            <strong>{citation.title}</strong>
            <span>{citation.path}</span>
            <p>{citation.snippet}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
