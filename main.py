import os
import uvicorn
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any, Optional

from logic import (
    answer_pdf_questions,
    answer_pdf_questions_by_hash,
    preprocess_pdf,
    preprocess_uploaded_pdf,
    process_document_and_questions,
)

app = FastAPI(title="HackRx PDF Q&A (Gemini)")

class QueryRequest(BaseModel):
    documents: str
    questions: List[str]


class PreprocessRequest(BaseModel):
    documents: str


class AskRequest(BaseModel):
    questions: List[str]
    pdf_hash: Optional[str] = None
    documents: Optional[str] = None


raw_origins = os.getenv("CORS_ORIGINS", "*")
allowed_origins = [origin.strip() for origin in raw_origins.split(",") if origin.strip()]
if not allowed_origins:
    allowed_origins = ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/hackrx/preprocess")
async def preprocess_submission(request_data: PreprocessRequest) -> Dict[str, Any]:
    try:
        result = preprocess_pdf(request_data.documents, background=False)
        if result.get("status") == "failed":
            raise HTTPException(status_code=400, detail=f"Preprocessing failed: {result.get('reason', 'unknown')}")
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/hackrx/preprocess-upload")
async def preprocess_upload(file: UploadFile = File(...)) -> Dict[str, Any]:
    try:
        if not file.filename or not file.filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="Only .pdf uploads are supported")

        file_bytes = await file.read()
        if not file_bytes:
            raise HTTPException(status_code=400, detail="Uploaded file is empty")

        result = preprocess_uploaded_pdf(file_bytes=file_bytes, source_name=file.filename)
        if result.get("status") == "failed":
            raise HTTPException(status_code=400, detail=f"Preprocessing failed: {result.get('reason', 'unknown')}")
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/hackrx/ask")
async def ask_questions(request_data: AskRequest) -> Dict[str, Any]:
    try:
        if not request_data.questions:
            raise HTTPException(status_code=400, detail="questions must not be empty")

        if request_data.pdf_hash:
            result = answer_pdf_questions_by_hash(request_data.pdf_hash, request_data.questions)
        elif request_data.documents:
            result = answer_pdf_questions(request_data.documents, request_data.questions)
        else:
            raise HTTPException(status_code=400, detail="Provide either pdf_hash or documents")

        if "error" in result:
            raise HTTPException(status_code=400, detail=result["error"])
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/hackrx/run")
async def run_submission(request_data: QueryRequest) -> Dict[str, Any]:
    try:
        result = process_document_and_questions(
            pdf_url=request_data.documents,
            questions=request_data.questions
        )
        if "error" in result:
            raise HTTPException(status_code=400, detail=result["error"])
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/")
def read_root():
    return {"status": "API is running."}

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
