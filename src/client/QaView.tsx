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
        <p className="eyebrow">RAG Q&A</p>
        <h1>Ask your Markdown vault</h1>
        <p className="muted">Answers are grounded in retrieved snippets from your plain-text documents.</p>
        <div className="ask-row">
          <input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="What did I write about this project?" />
          <button className="primary" onClick={ask} disabled={!question || loading}>
            {loading ? "Asking..." : "Ask"}
          </button>
        </div>
        {error ? <div className="error">{error}</div> : null}
      </section>
      {answer ? (
        <section className="panel">
          <h2>Answer</h2>
          {indexNamespace ? <p className="muted">Source index: {indexNamespace}</p> : null}
          {retrievalWarning ? <div className="error">Retrieval warning: {retrievalWarning}</div> : null}
          {providerError ? <div className="error">Provider warning: {providerError}</div> : null}
          {answerHtml ? <article className="qa-answer" dangerouslySetInnerHTML={{ __html: answerHtml }} /> : <p>{answer}</p>}
        </section>
      ) : null}
      <section className="citation-grid">
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
