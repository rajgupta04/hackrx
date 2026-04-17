export default function PdfInput({
  inputMode,
  setInputMode,
  pdfUrl,
  setPdfUrl,
  selectedFile,
  setSelectedFile,
  disabled,
}) {
  return (
    <section className="card">
      <div className="section-title-row">
        <h2>1. Choose Source</h2>
        <div className="mode-toggle" role="tablist" aria-label="PDF input mode">
          <button
            type="button"
            className={inputMode === "url" ? "active" : ""}
            onClick={() => setInputMode("url")}
            disabled={disabled}
          >
            URL
          </button>
          <button
            type="button"
            className={inputMode === "upload" ? "active" : ""}
            onClick={() => setInputMode("upload")}
            disabled={disabled}
          >
            Upload
          </button>
        </div>
      </div>

      {inputMode === "url" ? (
        <label className="field-block">
          <span>Public PDF URL</span>
          <input
            type="url"
            placeholder="https://example.com/doc.pdf"
            value={pdfUrl}
            onChange={(event) => setPdfUrl(event.target.value)}
            disabled={disabled}
          />
        </label>
      ) : (
        <label className="field-block">
          <span>Upload PDF File</span>
          <input
            type="file"
            accept="application/pdf"
            onChange={(event) => {
              const file = event.target.files?.[0] || null;
              setSelectedFile(file);
            }}
            disabled={disabled}
          />
          <small>{selectedFile ? `Selected: ${selectedFile.name}` : "No file selected"}</small>
        </label>
      )}
    </section>
  );
}
