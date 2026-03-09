"""
Embedding microservice — must use the SAME model as embed_semantic_layer.py
so that query vectors are in the same space as the stored ChromaDB embeddings.

Model: all-MiniLM-L6-v2  (sentence-transformers)

Start with:
    python scripts/embedding_service.py

Listens on http://localhost:8001
"""
from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

app = FastAPI(title="Embedding Service")

# Load once at startup – same model used in embed_semantic_layer.py
_model = SentenceTransformer("all-MiniLM-L6-v2")


class EmbedRequest(BaseModel):
    text: str


@app.post("/embed")
def embed(req: EmbedRequest) -> dict:
    vector = _model.encode(req.text).tolist()
    return {"embedding": vector}


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
