import os, json, hashlib
import chromadb

# ChromaDB Docker container is mapped to host port 9000 (see docker-compose.yml: "9000:8000")
client = chromadb.HttpClient(host="127.0.0.1", port=9000)

# Re-create collection cleanly (delete if exists so embedding config is consistent)
existing = [c.name for c in client.list_collections()]
if "semantic_layer" in existing:
    client.delete_collection("semantic_layer")

collection = client.get_or_create_collection(
    name="semantic_layer",
    metadata={"hnsw:space": "cosine"},
)

metrics = [
    {
        "id": "total_revenue",
        "text": """Metric: total_revenue
Definition: Total payment value from delivered orders only.
Excludes cancelled, unavailable, or in-transit orders.
SQL view: analytics.total_revenue
Dimensions: month, customer_state, product_category
Use for: revenue, sales, income, earnings, money made, how much did we earn""",
    },
    {
        "id": "active_customers",
        "text": """Metric: active_customers
Definition: Unique customers (customer_unique_id) with at least one delivered order.
SQL view: analytics.active_customers
Dimensions: month, customer_state
Use for: active users, customer count, how many customers, user base""",
    },
    {
        "id": "conversion_rate",
        "text": """Metric: conversion_rate
Definition: % of created orders reaching delivered status.
Formula: delivered_orders / total_orders * 100
SQL view: analytics.conversion_rate
Dimensions: month
Use for: conversion, order success rate, fulfilment rate, drop-off""",
    },
    {
        "id": "average_order_value",
        "text": """Metric: average_order_value (AOV)
Definition: Average revenue per delivered order.
Formula: SUM(payment_value) / COUNT(delivered_orders)
SQL view: analytics.average_order_value
Dimensions: month, product_category
Use for: AOV, basket size, average purchase, order value""",
    },
    {
        "id": "order_fulfillment_time",
        "text": """Metric: order_fulfillment_time
Definition: Avg calendar days from purchase to delivery. Delivered orders only.
SQL view: analytics.order_fulfillment_time
Dimensions: month, customer_state
Use for: delivery speed, shipping time, fulfillment, how long, logistics""",
    },
    {
        "id": "revenue_by_category",
        "text": """Metric: revenue_by_category
Definition: Delivered revenue segmented by product_category_name.
Use this INSTEAD of total_revenue when question involves product types.
SQL view: analytics.revenue_by_category
Dimensions: month, product_category
Use for: best category, top products, category performance, segment revenue""",
    },
    {
        "id": "customer_retention_rate",
        "text": """Metric: customer_retention_rate
Definition: % of month-N buyers who also bought in month N+1.
SQL view: analytics.customer_retention_rate
Dimensions: month (cohort)
Use for: retention, repeat customers, loyalty, churn, returning buyers""",
    },
]

# Compute embeddings — use disk cache to avoid reloading the model on every run
CACHE_PATH = os.path.join(os.path.dirname(__file__), ".embedding_cache.json")
texts = [m["text"] for m in metrics]
text_hash = hashlib.sha256("".join(texts).encode()).hexdigest()

cache_hit = False
if os.path.exists(CACHE_PATH):
    with open(CACHE_PATH, "r") as f:
        cache = json.load(f)
    if cache.get("hash") == text_hash:
        embeddings = cache["embeddings"]
        cache_hit = True

if not cache_hit:
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer("all-MiniLM-L6-v2")
    embeddings = model.encode(texts).tolist()
    with open(CACHE_PATH, "w") as f:
        json.dump({"hash": text_hash, "embeddings": embeddings}, f)

collection.upsert(
    documents=texts,
    embeddings=embeddings,
    ids=[m["id"] for m in metrics],
)
print(f"OK  Embedded {len(metrics)} metrics into ChromaDB collection 'semantic_layer'")
