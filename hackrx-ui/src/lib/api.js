const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";

function makeUrl(path) {
  return `${API_BASE_URL}${path}`;
}

async function parseError(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const body = await response.json();
    return body?.detail || body?.message || JSON.stringify(body);
  }
  return response.statusText || `HTTP ${response.status}`;
}

export async function preprocessFromUrl(documents) {
  const response = await fetch(makeUrl("/hackrx/preprocess"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documents }),
  });

  if (!response.ok) {
    throw new Error(await parseError(response));
  }

  return response.json();
}

export async function preprocessFromUpload(file) {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(makeUrl("/hackrx/preprocess-upload"), {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(await parseError(response));
  }

  return response.json();
}

export async function askByHash(pdfHash, questions) {
  const response = await fetch(makeUrl("/hackrx/ask"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pdf_hash: pdfHash, questions }),
  });

  if (!response.ok) {
    throw new Error(await parseError(response));
  }

  return response.json();
}

export async function healthCheck() {
  const response = await fetch(makeUrl("/"));
  if (!response.ok) {
    throw new Error(`Health check failed: ${response.status}`);
  }
  return response.json();
}
