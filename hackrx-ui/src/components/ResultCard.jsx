function parseAnswer(answer) {
  if (typeof answer !== "string") {
    return { answer: String(answer), source_quote: "N/A", source_page_number: "N/A", ai_used: false };
  }

  try {
    const parsed = JSON.parse(answer);
    return {
      answer: parsed.answer || answer,
      source_quote: parsed.source_quote || "N/A",
      source_page_number: parsed.source_page_number || "N/A",
      ai_used: Boolean(parsed.ai_used),
    };
  } catch {
    return { answer, source_quote: "N/A", source_page_number: "N/A", ai_used: false };
  }
}

export default function ResultCard({ question, answer, index, onClose, compact = false }) {
  const parsed = parseAnswer(answer);

  return (
    <article className="result-card">
      <div className="result-top-row">
        <p className="result-label">Question {index + 1}</p>
        <div className="result-top-actions">
          {parsed.ai_used ? <span className="ai-badge">AI Fallback</span> : null}
          {onClose ? (
            <button type="button" className="tile-close" onClick={onClose} aria-label={`Close question ${index + 1}`}>
              X
            </button>
          ) : null}
        </div>
      </div>
      <h3>{question}</h3>
      <p className={`answer ${compact ? "compact" : ""}`}>{parsed.answer}</p>
      <div className="meta-grid">
        <div>
          <p className="result-label">Source Page</p>
          <p>{parsed.source_page_number}</p>
        </div>
        <div>
          <p className="result-label">Supporting Quote</p>
          <p>{parsed.source_quote}</p>
        </div>
      </div>
    </article>
  );
}
