import { useEffect, useMemo, useState } from "react";
import PdfInput from "./components/PdfInput";
import QuestionBuilder from "./components/QuestionBuilder";
import ResultCard from "./components/ResultCard";
import RunHistory from "./components/RunHistory";
import { ApiError, askByHash, healthCheck, preprocessFromUpload, preprocessFromUrl, runCombined } from "./lib/api";

const HISTORY_KEY = "hackrx_showcase_history";

function timestampNow() {
  return new Date().toLocaleString();
}

function normalizeQuestions(questions) {
  return questions.map((question) => question.trim()).filter(Boolean);
}

export default function App() {
  const [theme, setTheme] = useState("dark");
  const [apiStatus, setApiStatus] = useState("checking");
  const [inputMode, setInputMode] = useState("url");
  const [pdfUrl, setPdfUrl] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [questions, setQuestions] = useState(["What does this document contain?"]);
  const [loading, setLoading] = useState(false);
  const [stepText, setStepText] = useState("Idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 8)));
  }, [history]);

  useEffect(() => {
    async function checkApi() {
      try {
        await healthCheck();
        setApiStatus("online");
      } catch {
        setApiStatus("offline");
      }
    }
    checkApi();
  }, []);

  const canSubmit = useMemo(() => {
    const hasQuestions = normalizeQuestions(questions).length > 0;
    if (!hasQuestions) {
      return false;
    }
    if (inputMode === "url") {
      return Boolean(pdfUrl.trim());
    }
    return Boolean(selectedFile);
  }, [inputMode, pdfUrl, selectedFile, questions]);

  function clearForm() {
    setError("");
    setResult(null);
    setQuestions(["What does this document contain?"]);
    setPdfUrl("");
    setSelectedFile(null);
    setStepText("Idle");
  }

  function addHistoryEntry(entry) {
    setHistory((prev) => [entry, ...prev].slice(0, 8));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setResult(null);

    const cleanedQuestions = normalizeQuestions(questions);
    if (cleanedQuestions.length === 0) {
      setError("Add at least one question.");
      return;
    }

    if (inputMode === "url" && !pdfUrl.trim()) {
      setError("Enter a PDF URL.");
      return;
    }

    if (inputMode === "upload" && !selectedFile) {
      setError("Upload a PDF file.");
      return;
    }

    setLoading(true);
    try {
      setStepText("Preprocessing PDF");

      let preprocessResult;
      let sourceLabel;
      if (inputMode === "url") {
        sourceLabel = pdfUrl.trim();
        try {
          preprocessResult = await preprocessFromUrl(sourceLabel);
        } catch (firstError) {
          // Support older deployed backends that only expose `/hackrx/run`.
          if (firstError instanceof ApiError && firstError.status === 404) {
            setStepText("Using legacy run endpoint");
            const legacyResult = await runCombined(sourceLabel, cleanedQuestions);
            const snapshot = {
              id: `${Date.now()}`,
              title: sourceLabel,
              timestamp: timestampNow(),
              inputMode,
              sourceLabel,
              questions: cleanedQuestions,
              answers: legacyResult.answers || [],
              pdfHash: "legacy-run",
            };

            setResult(snapshot);
            addHistoryEntry(snapshot);
            setStepText("Completed");
            return;
          }
          throw firstError;
        }
      } else {
        preprocessResult = await preprocessFromUpload(selectedFile);
        sourceLabel = selectedFile.name;
      }

      if (!preprocessResult?.pdf_hash) {
        throw new Error("Preprocess did not return pdf_hash.");
      }

      setStepText("Generating grounded answers");
      const askResult = await askByHash(preprocessResult.pdf_hash, cleanedQuestions);

      const snapshot = {
        id: `${Date.now()}`,
        title: sourceLabel,
        timestamp: timestampNow(),
        inputMode,
        sourceLabel,
        questions: cleanedQuestions,
        answers: askResult.answers || [],
        pdfHash: preprocessResult.pdf_hash,
      };

      setResult(snapshot);
      addHistoryEntry(snapshot);
      setStepText("Completed");
    } catch (apiError) {
      setError(apiError.message || "Unknown API error");
      setStepText("Failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <div className="bg-orb bg-orb-1" />
      <div className="bg-orb bg-orb-2" />

      <header className="topbar">
        <div>
          <p className="kicker">Interview Showcase</p>
          <h1>HackRx PDF Intelligence Console</h1>
          <p className="muted">A browser-first demo for your RAG API: URL/upload, multi-question grounding, and replayable runs.</p>
        </div>
        <div className="top-actions">
          <span className={`status-pill ${apiStatus}`}>API: {apiStatus}</span>
          <button type="button" className="ghost" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            Theme: {theme}
          </button>
        </div>
      </header>

      <main className="layout-grid">
        <form className="stack" onSubmit={handleSubmit}>
          <PdfInput
            inputMode={inputMode}
            setInputMode={setInputMode}
            pdfUrl={pdfUrl}
            setPdfUrl={setPdfUrl}
            selectedFile={selectedFile}
            setSelectedFile={setSelectedFile}
            disabled={loading}
          />

          <QuestionBuilder questions={questions} setQuestions={setQuestions} disabled={loading} />

          <section className="card">
            <div className="section-title-row">
              <h2>3. Run Pipeline</h2>
              <p className="muted">Status: {stepText}</p>
            </div>
            <div className="actions">
              <button type="submit" className="primary" disabled={!canSubmit || loading}>
                {loading ? "Running..." : "Preprocess + Ask"}
              </button>
              <button type="button" className="ghost" onClick={clearForm} disabled={loading}>
                Clear
              </button>
            </div>
            {error ? <p className="error">{error}</p> : null}
          </section>

          {result ? (
            <section className="card">
              <div className="section-title-row">
                <h2>Results</h2>
                <p className="muted">Source hash: {result.pdfHash}</p>
              </div>
              <div className="stack">
                {result.questions.map((question, idx) => (
                  <ResultCard key={`${question}-${idx}`} question={question} answer={result.answers[idx]} index={idx} />
                ))}
              </div>
            </section>
          ) : null}
        </form>

        <aside className="stack">
          <RunHistory history={history} onReplay={setResult} />
          <section className="card">
            <h2>Quick Demo Script</h2>
            <ol className="demo-list">
              <li>Paste a policy PDF URL or upload a sample PDF.</li>
              <li>Add 2-3 focused questions with business impact.</li>
              <li>Run preprocessing and show grounded answers.</li>
              <li>Open history and replay prior runs instantly.</li>
            </ol>
          </section>
        </aside>
      </main>
    </div>
  );
}
