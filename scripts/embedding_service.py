"""
Embedding microservice used by the Next.js API route.

Security hardening:
- Optional service-to-service API key via EMBEDDING_API_KEY
- Input length bounds to reduce abuse risk
"""

import os
from typing import Annotated

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

app = FastAPI(title="Embedding Service")

EMBEDDING_API_KEY = os.getenv("EMBEDDING_API_KEY", "").strip()

# Load once at startup – same model used in embed_semantic_layer.py
_model = SentenceTransformer("all-MiniLM-L6-v2")


class EmbedRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


@app.post("/embed", responses={401: {"description": "Unauthorized"}})
def embed(
    req: EmbedRequest,
    x_embedding_api_key: Annotated[str | None, Header(default=None)] = None,
) -> dict:
    if EMBEDDING_API_KEY and x_embedding_api_key != EMBEDDING_API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized")

    vector = _model.encode(req.text).tolist()
    return {"embedding": vector}


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8001)
