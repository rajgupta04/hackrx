"""
logic.py cache logic

- Preprocess PDF -> build FAISS index (persisted to disk)
- Query endpoint uses existing FAISS index to retrieve context and call Gemini LLM
- Uses SQLite to track preprocessing status and optionally cache final answers
"""
# import gemini
import os
import hashlib
import json
import pickle
import requests
import time
from typing import List, Dict, Any, Optional

import numpy as np
import faiss
import fitz  # pymupdf

from dotenv import load_dotenv
from langchain_google_genai import ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings

import sqlite3
import threading

load_dotenv()

# -------------------------
# Configuration
# -------------------------
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if not GEMINI_API_KEY:
    print("WARNING: GEMINI_API_KEY not set. Set env var GEMINI_API_KEY to use Gemini.")

# Models
LLM_MODEL = os.getenv("LLM_MODEL", "gemini-2.5-pro")
LLM_FALLBACK_MODELS = [
    "gemini-2.5-pro",
    "models/gemini-2.5-pro",
    "gemini-2.5-flash",
    "models/gemini-2.5-flash",
]
EMBED_MODEL = os.getenv("EMBED_MODEL", "models/gemini-embedding-001")
EMBED_FALLBACK_MODELS = [
    "models/gemini-embedding-001",
    "gemini-embedding-001",
    "models/gemini-embedding-2-preview",
    "gemini-embedding-2-preview",
    "models/embedding-001",
    "embedding-001",
    "text-embedding-004",
    "models/text-embedding-004",
]

# Local persistence directories (customize via env)
FAISS_DIR = os.getenv("FAISS_DIR", "/tmp/faiss_cache")
PDF_DIR = os.getenv("PDF_DIR", "/tmp/pdf_cache")
META_DIR = os.getenv("META_DIR", "/tmp/faiss_meta")
os.makedirs(FAISS_DIR, exist_ok=True)
os.makedirs(PDF_DIR, exist_ok=True)
os.makedirs(META_DIR, exist_ok=True)

# sqlite DB for status & optional cache
SQLITE_DB = os.getenv("SQLITE_DB", "/tmp/faiss_status.db")
DOWNLOAD_TIMEOUT_SECONDS = int(os.getenv("DOWNLOAD_TIMEOUT_SECONDS", "90"))
RETRIEVAL_TOP_K = int(os.getenv("RETRIEVAL_TOP_K", "5"))

# instantiate Gemini models via langchain_google_genai adapter


def _llm_model_candidates() -> List[str]:
    ordered = [LLM_MODEL] + LLM_FALLBACK_MODELS
    seen = set()
    candidates = []
    for model in ordered:
        if model and model not in seen:
            seen.add(model)
            candidates.append(model)
    return candidates


def _invoke_llm(prompt: str):
    last_error = None
    for model_name in _llm_model_candidates():
        try:
            client = ChatGoogleGenerativeAI(model=model_name, google_api_key=GEMINI_API_KEY, temperature=0)
            response = client.invoke(prompt)
            if model_name != LLM_MODEL:
                print(f"[llm] fallback model selected: {model_name}")
            return response
        except Exception as e:
            last_error = e
            print(f"[llm] model failed ({model_name}): {e}")
    raise last_error


def _embedding_model_candidates() -> List[str]:
    # Keep configured model first, then try known alternatives for API/version differences.
    ordered = [EMBED_MODEL] + EMBED_FALLBACK_MODELS
    seen = set()
    candidates = []
    for model in ordered:
        if model and model not in seen:
            seen.add(model)
            candidates.append(model)
    return candidates


def _embed_documents(chunk_texts: List[str]) -> List[List[float]]:
    last_error = None
    for model_name in _embedding_model_candidates():
        try:
            client = GoogleGenerativeAIEmbeddings(model=model_name, google_api_key=GEMINI_API_KEY)
            vectors = client.embed_documents(chunk_texts)
            if model_name != EMBED_MODEL:
                print(f"[embedding] fallback model selected: {model_name}")
            return vectors
        except Exception as e:
            last_error = e
            print(f"[embedding] model failed ({model_name}): {e}")
    raise last_error


def _embed_query(query: str) -> List[float]:
    last_error = None
    for model_name in _embedding_model_candidates():
        try:
            client = GoogleGenerativeAIEmbeddings(model=model_name, google_api_key=GEMINI_API_KEY)
            vector = client.embed_query(query)
            if model_name != EMBED_MODEL:
                print(f"[embedding] fallback model selected: {model_name}")
            return vector
        except Exception as e:
            last_error = e
            print(f"[embedding] query model failed ({model_name}): {e}")
    raise last_error


# -------------------------
# SQLite helper (status + simple cache)
# -------------------------
def init_sqlite():
    conn = sqlite3.connect(SQLITE_DB, check_same_thread=False)
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS pdf_status (
            pdf_hash TEXT PRIMARY KEY,
            pdf_url TEXT,
            status TEXT,         -- pending | processing | done | failed
            updated_at REAL
        );
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS answer_cache (
            key TEXT PRIMARY KEY,   -- md5(pdf_hash + question)
            pdf_hash TEXT,
            question TEXT,
            answer TEXT,
            created_at REAL
        );
        """
    )
    conn.commit()
    cur.close()
    conn.close()


init_sqlite()


def set_pdf_status(pdf_hash: str, pdf_source: str, status: str):
    conn = sqlite3.connect(SQLITE_DB)
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO pdf_status (pdf_hash, pdf_url, status, updated_at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(pdf_hash) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, pdf_url = excluded.pdf_url",
        (pdf_hash, pdf_source, status, time.time()),
    )
    conn.commit()
    cur.close()
    conn.close()


def get_pdf_status(pdf_hash: str) -> Optional[str]:
    conn = sqlite3.connect(SQLITE_DB)
    cur = conn.cursor()
    cur.execute("SELECT status FROM pdf_status WHERE pdf_hash = ?", (pdf_hash,))
    row = cur.fetchone()
    cur.close()
    conn.close()
    return row[0] if row else None


def cache_answer(pdf_hash: str, question: str, answer: str):
    key = hashlib.md5((pdf_hash + question).encode("utf-8")).hexdigest()
    conn = sqlite3.connect(SQLITE_DB)
    cur = conn.cursor()
    cur.execute(
        "INSERT OR REPLACE INTO answer_cache (key, pdf_hash, question, answer, created_at) VALUES (?, ?, ?, ?, ?)",
        (key, pdf_hash, question, answer, time.time())
    )
    conn.commit()
    cur.close()
    conn.close()


def get_cached_answer(pdf_hash: str, question: str) -> Optional[str]:
    key = hashlib.md5((pdf_hash + question).encode("utf-8")).hexdigest()
    conn = sqlite3.connect(SQLITE_DB)
    cur = conn.cursor()
    cur.execute("SELECT answer FROM answer_cache WHERE key = ?", (key,))
    row = cur.fetchone()
    cur.close()
    conn.close()
    return row[0] if row else None


# -------------------------
# Utilities: file naming / hashing
# -------------------------
def md5_hex(s: str) -> str:
    return hashlib.md5(s.encode("utf-8")).hexdigest()


def pdf_hash_for_url(pdf_url: str) -> str:
    # normalize by dropping query params (so same PDF path with signed URLs maps to same hash)
    from urllib.parse import urlparse
    p = urlparse(pdf_url)
    normalized = f"{p.scheme}://{p.netloc}{p.path}"
    return md5_hex(normalized)


def pdf_hash_for_bytes(file_bytes: bytes) -> str:
    return hashlib.md5(file_bytes).hexdigest()


def local_pdf_path(pdf_hash: str) -> str:
    return os.path.join(PDF_DIR, f"{pdf_hash}.pdf")


def faiss_index_paths(pdf_hash: str):
    index_path = os.path.join(FAISS_DIR, f"{pdf_hash}.index")
    meta_path = os.path.join(META_DIR, f"{pdf_hash}.meta.pkl")
    return index_path, meta_path


# -------------------------
# PDF download & parse
# -------------------------
def download_pdf(pdf_url: str, pdf_hash: str) -> Optional[str]:
    local_path = local_pdf_path(pdf_hash)
    if os.path.exists(local_path):
        return local_path
    try:
        resp = requests.get(pdf_url, timeout=DOWNLOAD_TIMEOUT_SECONDS, stream=True)
        resp.raise_for_status()
        with open(local_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
        return local_path
    except Exception as e:
        print("download_pdf error:", e)
        if os.path.exists(local_path):
            os.remove(local_path)
        return None


def extract_text_chunks_from_pdf(local_pdf: str, chunk_size: int = 1200, chunk_overlap: int = 200) -> List[Dict[str, Any]]:
    """
    Returns list of dicts: {"text": "...", "page": page_no}
    Uses PyMuPDF (fitz) which is robust.
    """
    res = []
    try:
        doc = fitz.open(local_pdf)
        for i, page in enumerate(doc):
            text = page.get_text().strip()
            if not text:
                continue
            # naive chunking by characters using CharacterTextSplitter style
            # but we'll do simple sliding windows on the page text (could be improved)
            start = 0
            while start < len(text):
                piece = text[start:start + chunk_size]
                res.append({"text": piece, "page": i + 1})
                start += (chunk_size - chunk_overlap)
        doc.close()
    except Exception as e:
        print("extract_text_chunks_from_pdf error:", e)
    return res


# -------------------------
# FAISS build/load/save
# -------------------------
def build_faiss_for_pdf(pdf_hash: str, chunk_texts: List[str]) -> Optional[faiss.Index]:
    """
    Takes list of raw chunk strings and returns a FAISS Index (IP over normalized vectors).
    Also returns metadata saved to meta_path.
    """
    try:
        # compute embeddings via Google embedding model
        print(f"[embedding] computing {len(chunk_texts)} embeddings...")
        emb_list = _embed_documents(chunk_texts)
        arr = np.array(emb_list).astype("float32")
        # normalize vectors
        norms = np.linalg.norm(arr, axis=1, keepdims=True)
        norms[norms == 0] = 1e-9
        arr_norm = arr / norms
        d = arr_norm.shape[1]
        index = faiss.IndexFlatIP(d)
        index.add(arr_norm)
        return index, arr_norm
    except Exception as e:
        print("build_faiss_for_pdf embedding/index error:", e)
        return None, None


def save_faiss_index_and_meta(index: faiss.Index, meta: List[dict], pdf_hash: str):
    index_path, meta_path = faiss_index_paths(pdf_hash)
    faiss.write_index(index, index_path)
    with open(meta_path, "wb") as f:
        pickle.dump(meta, f)
    print(f"[faiss] saved index: {index_path}, meta: {meta_path}")


def load_faiss_index_and_meta(pdf_hash: str):
    index_path, meta_path = faiss_index_paths(pdf_hash)
    if not (os.path.exists(index_path) and os.path.exists(meta_path)):
        return None, None
    try:
        index = faiss.read_index(index_path)
        with open(meta_path, "rb") as f:
            meta = pickle.load(f)
        return index, meta
    except Exception as e:
        print("load_faiss_index_and_meta error:", e)
        return None, None


def save_uploaded_pdf(pdf_hash: str, file_bytes: bytes) -> str:
    local_path = local_pdf_path(pdf_hash)
    if not os.path.exists(local_path):
        with open(local_path, "wb") as f:
            f.write(file_bytes)
    return local_path


# -------------------------
# Preprocessing pipeline (blocking)
# -------------------------
def preprocess_local_pdf_blocking(local_pdf: str, pdf_hash: str, pdf_source: str):
    set_pdf_status(pdf_hash, pdf_source, "processing")
    print(f"[preprocess] starting for {pdf_source} (hash={pdf_hash})")

    # extract text chunks
    chunks_meta = extract_text_chunks_from_pdf(local_pdf)
    if not chunks_meta:
        set_pdf_status(pdf_hash, pdf_source, "failed")
        return {"status": "failed", "reason": "no_text_extracted", "pdf_hash": pdf_hash}

    chunk_texts = [c["text"] for c in chunks_meta]

    index, arr_norm = build_faiss_for_pdf(pdf_hash, chunk_texts)
    if index is None:
        set_pdf_status(pdf_hash, pdf_source, "failed")
        return {"status": "failed", "reason": "embedding_error", "pdf_hash": pdf_hash}

    meta_list = []
    for i, c in enumerate(chunks_meta):
        meta = {"page": c["page"], "text": c["text"]}
        meta_list.append(meta)

    save_faiss_index_and_meta(index, meta_list, pdf_hash)
    set_pdf_status(pdf_hash, pdf_source, "done")
    return {"status": "done", "pdf_hash": pdf_hash}


def preprocess_pdf_blocking(pdf_url: str):
    """
    Full preprocessing pipeline:
      - set status processing
      - download PDF
      - extract chunks
      - embed and build FAISS
      - save index + meta
      - set status done
    This function is BLOCKING and may take time for large PDFs.
    Call it in a worker or manually via /preprocess.
    """
    pdf_hash = pdf_hash_for_url(pdf_url)

    local_pdf = download_pdf(pdf_url, pdf_hash)
    if not local_pdf:
        set_pdf_status(pdf_hash, pdf_url, "failed")
        return {"status": "failed", "reason": "download_failed", "pdf_hash": pdf_hash}

    return preprocess_local_pdf_blocking(local_pdf, pdf_hash, pdf_url)


def preprocess_pdf_bytes_blocking(file_bytes: bytes, source_name: str = "uploaded.pdf"):
    pdf_hash = pdf_hash_for_bytes(file_bytes)
    local_pdf = save_uploaded_pdf(pdf_hash, file_bytes)
    return preprocess_local_pdf_blocking(local_pdf, pdf_hash, f"upload://{source_name}")


# -------------------------
# Retrieval + LLM answering
# -------------------------
def retrieve_top_k_for_query(pdf_hash: str, query: str, top_k: int = 5):
    index, meta = load_faiss_index_and_meta(pdf_hash)
    if not index or not meta:
        return []

    # embed query
    try:
        q_emb = _embed_query(query)
    except Exception as e:
        print("retrieve_top_k_for_query embed error:", e)
        q_emb = _embed_query(query)

    q = np.array(q_emb).astype("float32")
    q = q / (np.linalg.norm(q) + 1e-9)
    D, I = index.search(q.reshape(1, -1), top_k)
    ids = I[0].tolist()
    scores = D[0].tolist()
    results = []
    for idx, score in zip(ids, scores):
        if idx < 0 or idx >= len(meta):
            continue
        results.append({"score": float(score), "page": meta[idx].get("page"), "text": meta[idx].get("text")})
    return results


def prompt_for_gemini_with_context(context_items: List[dict], question: str) -> str:
    """
    Build a prompt containing the top-k contexts (with page numbers) and the user's question.
    """
    ctx_parts = []
    for i, it in enumerate(context_items):
        ctx_parts.append(f"--- Context {i+1} (page {it.get('page', 'Unknown')}) ---\n{it.get('text','')}\n")
    ctx_text = "\n".join(ctx_parts)
    prompt = f"""
You are a precise assistant. Answer the user's question strictly using the provided document context below.
Do not invent facts outside the context. If the answer is not present in context, say "Information not found in the document".

Context:
{ctx_text}

Question:
{question}

Provide a JSON object with keys: "question", "answer", "source_quote", "source_page_number"
- "answer" should be concise.
- "source_quote" should be the single sentence from the context that supports the answer (or "N/A").
- "source_page_number" should be the page number (or "N/A").
Return ONLY the JSON object.
"""
    return prompt


def build_answer_payload(question: str, answer: str, source_quote: str = "N/A", source_page_number: Any = "N/A") -> Dict[str, Any]:
    return {
        "question": question,
        "answer": answer,
        "source_quote": source_quote,
        "source_page_number": source_page_number,
    }


def fallback_source_from_context(context_items: List[dict]) -> Dict[str, Any]:
    if not context_items:
        return {"source_quote": "N/A", "source_page_number": "N/A"}

    best = context_items[0]
    raw_text = (best.get("text") or "").strip()
    if not raw_text:
        return {"source_quote": "N/A", "source_page_number": best.get("page", "N/A")}

    first_sentence = raw_text.split(". ")[0].strip()
    source_quote = first_sentence if first_sentence.endswith(".") else f"{first_sentence}."
    return {
        "source_quote": source_quote,
        "source_page_number": best.get("page", "N/A"),
    }


def answer_questions_using_hash(pdf_hash: str, questions: List[str]) -> Dict[str, Any]:
    status = get_pdf_status(pdf_hash)

    if status != "done":
        return {
            "processing": True,
            "status": status or "not_started",
            "message": "Preprocess the PDF first via /hackrx/preprocess"
        }

    answers = []

    for q in questions:
        # Try cache first
        cached = get_cached_answer(pdf_hash, q)
        if cached:
            try:
                parsed_cached = json.loads(cached)
                if isinstance(parsed_cached, dict):
                    cached = json.dumps(parsed_cached)
            except Exception:
                cached = json.dumps(build_answer_payload(question=q, answer=str(cached)))
            answers.append(cached)
            continue

        # Retrieve top-k chunks
        top = retrieve_top_k_for_query(pdf_hash, q, top_k=RETRIEVAL_TOP_K)
        if not top:
            no_context_payload = build_answer_payload(
                question=q,
                answer="No context found in document.",
                source_quote="N/A",
                source_page_number="N/A",
            )
            encoded = json.dumps(no_context_payload)
            cache_answer(pdf_hash, q, encoded)
            answers.append(encoded)
            continue

        # Build prompt and invoke Gemini
        prompt = prompt_for_gemini_with_context(top, q)
        try:
            r = _invoke_llm(prompt)
            json_text = r.content.strip().replace("```json", "").replace("```", "")
            parsed = json.loads(json_text)
            fallback_source = fallback_source_from_context(top)
            answer_payload = build_answer_payload(
                question=q,
                answer=parsed.get("answer") or parsed.get("Answer") or json_text,
                source_quote=parsed.get("source_quote") or fallback_source.get("source_quote", "N/A"),
                source_page_number=parsed.get("source_page_number") or fallback_source.get("source_page_number", "N/A"),
            )
        except Exception as e:
            print("LLM call error:", e)
            fallback_source = fallback_source_from_context(top)
            answer_payload = build_answer_payload(
                question=q,
                answer="LLM call failed; see logs.",
                source_quote=fallback_source.get("source_quote", "N/A"),
                source_page_number=fallback_source.get("source_page_number", "N/A"),
            )

        # Cache result and add to answers list
        encoded = json.dumps(answer_payload)
        cache_answer(pdf_hash, q, encoded)
        answers.append(encoded)

    return {"answers": answers}


def answer_questions_using_index(pdf_url: str, questions: List[str]) -> Dict[str, Any]:
    pdf_hash = pdf_hash_for_url(pdf_url)
    return answer_questions_using_hash(pdf_hash, questions)


# -------------------------
# Convenience wrapper for running preprocess in a thread (for local/developer use only)
# -------------------------
def start_preprocess_in_background(pdf_url: str) -> Dict[str, Any]:
    pdf_hash = pdf_hash_for_url(pdf_url)
    status = get_pdf_status(pdf_hash)
    if status == "processing":
        return {"status": "processing", "message": "Already processing"}

    # mark and spawn thread
    set_pdf_status(pdf_hash, pdf_url, "pending")

    def target():
        try:
            set_pdf_status(pdf_hash, pdf_url, "processing")
            preprocess_pdf_blocking(pdf_url)
        except Exception as e:
            print("Background preprocess error:", e)
            set_pdf_status(pdf_hash, pdf_url, "failed")

    t = threading.Thread(target=target, daemon=True)
    t.start()
    return {"status": "started", "pdf_hash": pdf_hash}


# -------------------------
# Public functions expected by main.py
# -------------------------
def preprocess_pdf(pdf_url: str, background: bool = False) -> Dict[str, Any]:
    """
    If background==False -> run blocking preprocess (callable from worker)
    If background==True  -> attempt to start background thread (may not persist in serverless)
    """
    if background:
        return start_preprocess_in_background(pdf_url)
    return preprocess_pdf_blocking(pdf_url)


def preprocess_uploaded_pdf(file_bytes: bytes, source_name: str = "uploaded.pdf") -> Dict[str, Any]:
    return preprocess_pdf_bytes_blocking(file_bytes=file_bytes, source_name=source_name)


def answer_pdf_questions(pdf_url: str, questions: List[str]) -> Dict[str, Any]:
    """
    Returns either "processing" status or the answers.
    """
    return answer_questions_using_index(pdf_url, questions)


def answer_pdf_questions_by_hash(pdf_hash: str, questions: List[str]) -> Dict[str, Any]:
    return answer_questions_using_hash(pdf_hash, questions)


# If run as script, quick CLI:
if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--preprocess", help="PDF URL to preprocess", default=None)
    p.add_argument("--ask", help="PDF URL to ask against", default=None)
    p.add_argument("--question", help="Question (for ask)", default=None)
    args = p.parse_args()
    if args.preprocess:
        print(preprocess_pdf(args.preprocess, background=False))
    elif args.ask and args.question:
        print(answer_pdf_questions(args.ask, [args.question]))
    else:
        print("Usage examples:\n  python logic.py --preprocess 'https://...' \n  python logic.py --ask 'https://...' --question 'Who wrote it?'")

def process_document_and_questions(pdf_url: str, questions: List[str]) -> Dict[str, Any]:
    """
    Combined function to preprocess and then answer questions.
    """
    preprocess_result = preprocess_pdf(pdf_url, background=False)

    # Check if preprocessing failed
    if preprocess_result.get("status") == "failed":
        return {"error": f"Preprocessing failed: {preprocess_result.get('reason', 'unknown')}"}

    return answer_pdf_questions(pdf_url, questions)
