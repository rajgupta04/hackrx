const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function makeUrl(path) {
  return `${API_BASE_URL}${path}`;
}

async function parseError(response) {
  const contentType = response.headers.get("content-type") || "";
  if (response.status === 404) {
    return "Endpoint not found on backend (404). Check backend URL and route compatibility.";
  }
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
    throw new ApiError(await parseError(response), response.status);
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
    throw new ApiError(await parseError(response), response.status);
  }

  return response.json();
}

export async function askByHash(pdfHash, questions, useAIFallback = false) {
  const response = await fetch(makeUrl("/hackrx/ask"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pdf_hash: pdfHash, questions, use_ai_fallback: useAIFallback }),
  });

  if (!response.ok) {
    throw new ApiError(await parseError(response), response.status);
  }

  return response.json();
}

export async function runCombined(documents, questions, useAIFallback = false) {
  const response = await fetch(makeUrl("/hackrx/run"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documents, questions, use_ai_fallback: useAIFallback }),
  });

  if (!response.ok) {
    throw new ApiError(await parseError(response), response.status);
  }

  return response.json();
}

export async function healthCheck() {
  // Some deployed APIs don't expose `/`; any HTTP response means the host is reachable.
  const response = await fetch(makeUrl("/"));
  return { reachable: Boolean(response) };
}

export { ApiError };
