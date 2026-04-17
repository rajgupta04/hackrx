export default function QuestionBuilder({ questions, setQuestions, disabled }) {
  function updateQuestion(index, value) {
    const next = [...questions];
    next[index] = value;
    setQuestions(next);
  }

  function addQuestion() {
    setQuestions([...questions, ""]);
  }

  function removeQuestion(index) {
    if (questions.length === 1) {
      return;
    }
    const next = questions.filter((_, idx) => idx !== index);
    setQuestions(next);
  }

  return (
    <section className="card">
      <div className="section-title-row">
        <h2>2. Ask Questions</h2>
        <button type="button" className="ghost" onClick={addQuestion} disabled={disabled}>
          + Add Question
        </button>
      </div>
      <div className="stack">
        {questions.map((question, index) => (
          <div className="question-row" key={`question-${index}`}>
            <input
              type="text"
              placeholder={`Question ${index + 1}`}
              value={question}
              onChange={(event) => updateQuestion(index, event.target.value)}
              disabled={disabled}
            />
            <button
              type="button"
              className="danger"
              onClick={() => removeQuestion(index)}
              disabled={disabled || questions.length === 1}
              aria-label={`Remove question ${index + 1}`}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
