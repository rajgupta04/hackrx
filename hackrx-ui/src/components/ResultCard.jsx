function parseAnswer(answer) {
  if (typeof answer !== "string") {
    return { answer: String(answer), source_quote: "N/A", source_page_number: "N/A" };
  }

  try {
    const parsed = JSON.parse(answer);
    return {
      answer: parsed.answer || answer,
      source_quote: parsed.source_quote || "N/A",
      source_page_number: parsed.source_page_number || "N/A",
    };
  } catch {
    return { answer, source_quote: "N/A", source_page_number: "N/A" };
  }
}

export default function ResultCard({ question, answer, index }) {
  const parsed = parseAnswer(answer);

  return (
    <article className="result-card">
      <p className="result-label">Question {index + 1}</p>
      <h3>{question}</h3>
      <p className="answer">{parsed.answer}</p>
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
