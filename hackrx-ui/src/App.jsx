import { useEffect, useMemo, useState } from "react";
import PdfInput from "./components/PdfInput";
import QuestionBuilder from "./components/QuestionBuilder";
import ResultCard from "./components/ResultCard";
import RunHistory from "./components/RunHistory";
import { ApiError, askByHash, healthCheck, preprocessFromUpload, preprocessFromUrl, runCombined } from "./lib/api";

const HISTORY_KEY = "hackrx_showcase_history";
const SAMPLE_POLICY_URL =
  "https://hackrx.blob.core.windows.net/assets/policy.pdf?sv=2023-01-03&st=2025-07-04T09%3A11%3A24Z&se=2027-07-05T09%3A11%3A00Z&sr=b&sp=r&sig=N4a9OU0w0QXO6AOIBiu4bpl7AXvEZogeT%2FjUHNO7HzQ%3D";
const SAMPLE_QUESTIONS = [
  "What is the grace period for premium payment under the National Parivar Mediclaim Plus Policy?",
  "What is the waiting period for pre-existing diseases (PED) to be covered?",
  "Does this policy cover maternity expenses, and what are the conditions?",
  "What is the waiting period for cataract surgery?",
  "Are the medical expenses for an organ donor covered under this policy?",
  "What is the No Claim Discount (NCD) offered in this policy?",
  "Is there a benefit for preventive health check-ups?",
  "How does the policy define a 'Hospital'?",
  "What is the extent of coverage for AYUSH treatments?",
  "Are there any sub-limits on room rent and ICU charges for Plan A?",
];

function timestampNow() {
  return new Date().toLocaleString();
}

function normalizeQuestions(questions) {
  return questions.map((question) => question.trim()).filter(Boolean);
}

function normalizeUrl(raw) {
  return (raw || "").trim().replace(/\/+$/, "");
}

export default function App() {
  const [theme, setTheme] = useState("dark");
  const [apiStatus, setApiStatus] = useState("checking");
  const [inputMode, setInputMode] = useState("url");
  const [pdfUrl, setPdfUrl] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploadPreviewUrl, setUploadPreviewUrl] = useState("");
  const [questions, setQuestions] = useState(["What does this document contain?"]);
  const [useAIFallback, setUseAIFallback] = useState(true);
  const [loading, setLoading] = useState(false);
  const [stepText, setStepText] = useState("Idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [resultsPopupOpen, setResultsPopupOpen] = useState(false);
  const [tileMode, setTileMode] = useState("full");
  const [currentTileIndex, setCurrentTileIndex] = useState(0);
  const [closedTileIndices, setClosedTileIndices] = useState([]);
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
    if (!selectedFile) {
      setUploadPreviewUrl("");
      return;
    }

    const objectUrl = URL.createObjectURL(selectedFile);
    setUploadPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [selectedFile]);

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

  const activeDocumentUrl = inputMode === "url" ? pdfUrl.trim() : uploadPreviewUrl;

  const currentPayload = useMemo(() => {
    return {
      documents: inputMode === "url" ? pdfUrl.trim() : selectedFile?.name || "<uploaded_file>",
      questions: normalizeQuestions(questions),
      use_ai_fallback: useAIFallback,
    };
  }, [inputMode, pdfUrl, selectedFile, questions, useAIFallback]);

  const samplePayload = useMemo(() => {
    return {
      documents: SAMPLE_POLICY_URL,
      questions: SAMPLE_QUESTIONS,
    };
  }, []);

  function clearForm() {
    setError("");
    setResult(null);
    setQuestions(["What does this document contain?"]);
    setPdfUrl("");
    setSelectedFile(null);
    setStepText("Idle");
    setResultsPopupOpen(false);
    setClosedTileIndices([]);
    setCurrentTileIndex(0);
  }

  function addHistoryEntry(entry) {
    setHistory((prev) => [entry, ...prev].slice(0, 8));
  }

  function openResultPopup(snapshot) {
    setResult(snapshot);
    setClosedTileIndices([]);
    setCurrentTileIndex(0);
    setTileMode("full");
    setResultsPopupOpen(true);
  }

  function closeSingleTile(index) {
    setClosedTileIndices((prev) => {
      const next = prev.includes(index) ? prev : [...prev, index];
      const visible = result?.questions
        ?.map((_, idx) => idx)
        .filter((idx) => !next.includes(idx));
      if (visible && visible.length > 0 && !visible.includes(currentTileIndex)) {
        setCurrentTileIndex(visible[0]);
      }
      return next;
    });
  }

  function closeAllTiles() {
    setResultsPopupOpen(false);
    setClosedTileIndices([]);
    setCurrentTileIndex(0);
  }

  function loadPolicySample() {
    setInputMode("url");
    setSelectedFile(null);
    setPdfUrl(SAMPLE_POLICY_URL);
    setQuestions([...SAMPLE_QUESTIONS]);
    setError("");
    setStepText("Sample payload loaded");
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

    if (inputMode === "url") {
      const sourceUrl = normalizeUrl(pdfUrl);
      const apiUrl = normalizeUrl(import.meta.env.VITE_API_BASE_URL || "");
      if (sourceUrl && apiUrl && sourceUrl === apiUrl) {
        setError("You entered the backend API URL in the PDF field. Paste a public PDF link (for example, a direct .pdf file URL).");
        return;
      }
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
            const legacyResult = await runCombined(sourceLabel, cleanedQuestions, useAIFallback);
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

            openResultPopup(snapshot);
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
      const askResult = await askByHash(preprocessResult.pdf_hash, cleanedQuestions, useAIFallback);

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

      openResultPopup(snapshot);
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
          <section className="card">
            <div className="section-title-row">
              <h2>Quick Start Payload</h2>
              <button type="button" className="primary" onClick={loadPolicySample} disabled={loading}>
                Load Policy Sample
              </button>
            </div>
            <pre className="json-panel">{JSON.stringify(samplePayload, null, 2)}</pre>
          </section>

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
              <h2>Current Payload</h2>
              <p className="muted">Questions can be added/removed before submit.</p>
            </div>
            <pre className="json-panel">{JSON.stringify(currentPayload, null, 2)}</pre>
          </section>

          <section className="card">
            <div className="section-title-row">
              <h2>3. Run Pipeline</h2>
              <p className="muted">Status: {stepText}</p>
            </div>
            <label className="switch-row">
              <input type="checkbox" checked={useAIFallback} onChange={(event) => setUseAIFallback(event.target.checked)} disabled={loading} />
              <span>Use AI fallback when grounded search cannot find answer</span>
            </label>
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
        </form>

        <aside className="stack">
          <section className="card viewer-card">
            <div className="section-title-row">
              <h2>PDF Viewer</h2>
              {activeDocumentUrl ? (
                <a className="ghost viewer-link" href={activeDocumentUrl} target="_blank" rel="noreferrer">
                  Open in New Tab
                </a>
              ) : null}
            </div>
            {activeDocumentUrl ? (
              <iframe title="Policy PDF Viewer" src={activeDocumentUrl} className="pdf-frame" />
            ) : (
              <p className="muted">Enter a PDF URL or upload a PDF to preview it here.</p>
            )}
          </section>

          <RunHistory
            history={history}
            onReplay={(item) => {
              openResultPopup(item);
            }}
          />
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

      {resultsPopupOpen && result ? (
        <section className="result-overlay" role="dialog" aria-modal="true" aria-label="Query results popup">
          <div className="result-modal">
            <div className="section-title-row">
              <h2>Results Tiles</h2>
              <div className="result-top-actions">
                <div className="mode-toggle" role="tablist" aria-label="tile mode">
                  <button type="button" className={tileMode === "single" ? "active" : ""} onClick={() => setTileMode("single")}>
                    Single
                  </button>
                  <button type="button" className={tileMode === "full" ? "active" : ""} onClick={() => setTileMode("full")}>
                    Full
                  </button>
                </div>
                <button type="button" className="ghost" onClick={closeAllTiles}>
                  X/X Close All
                </button>
              </div>
            </div>

            <p className="muted">Source hash: {result.pdfHash}</p>

            {tileMode === "single" ? (
              <div className="stack">
                {result.questions
                  .map((question, idx) => ({ question, idx }))
                  .filter((item) => !closedTileIndices.includes(item.idx) && item.idx === currentTileIndex)
                  .map((item) => (
                    <ResultCard
                      key={`${item.question}-${item.idx}`}
                      question={item.question}
                      answer={result.answers[item.idx]}
                      index={item.idx}
                      onClose={() => closeSingleTile(item.idx)}
                    />
                  ))}

                <div className="actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setCurrentTileIndex((prev) => Math.max(prev - 1, 0))}
                    disabled={currentTileIndex <= 0}
                  >
                    Prev
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setCurrentTileIndex((prev) => Math.min(prev + 1, result.questions.length - 1))}
                    disabled={currentTileIndex >= result.questions.length - 1}
                  >
                    Next
                  </button>
                </div>
              </div>
            ) : (
              <div className="stack popup-scroll">
                {result.questions
                  .map((question, idx) => ({ question, idx }))
                  .filter((item) => !closedTileIndices.includes(item.idx))
                  .map((item) => (
                    <ResultCard
                      key={`${item.question}-${item.idx}`}
                      question={item.question}
                      answer={result.answers[item.idx]}
                      index={item.idx}
                      onClose={() => closeSingleTile(item.idx)}
                      compact
                    />
                  ))}
              </div>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
