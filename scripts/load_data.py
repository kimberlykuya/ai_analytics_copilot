import os
import pandas as pd
from sqlalchemy import create_engine, text
from pathlib import Path

# credentials/configuration come from environment variables so they can be
# kept out of source control.  Use a .env file locally (added to .gitignore)
# and python-dotenv to load it when debugging interactively.
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    # python-dotenv isn't required at runtime; env variables will still be
    # read from the operating system.
    pass

# match the variables defined in the compose/.env file
PG_USER = os.getenv("POSTGRES_USER", "analytics")
PG_PASSWORD = os.getenv("POSTGRES_PASSWORD", "analytics")
PG_HOST = os.getenv("POSTGRES_HOST", "127.0.0.1")
PG_PORT = os.getenv("POSTGRES_PORT", "5433")
PG_DB = os.getenv("POSTGRES_DB", "olist")

engine = create_engine(
    f"postgresql://{PG_USER}:{PG_PASSWORD}@{PG_HOST}:{PG_PORT}/{PG_DB}"
)

print("[ETL] Starting Olist Semantic Data Pipeline")
print(f"[ETL] Connecting to {PG_HOST}:{PG_PORT}/{PG_DB}")

# Create raw and analytics schemas
with engine.connect() as conn:
    conn.execute(text("CREATE SCHEMA IF NOT EXISTS raw"))
    conn.execute(text("CREATE SCHEMA IF NOT EXISTS analytics"))
    conn.commit()
    print("[ETL] Schemas created: raw, analytics")


BASE_DIR = Path(__file__).parent.parent / "data"

# Phase 0: Clean up dependent views before reloading raw data
print("\n[ETL Phase 0] Cleaning up dependent views...")
with engine.connect() as conn:
    conn.execute(text("DROP VIEW IF EXISTS analytics.sellers CASCADE"))
    conn.execute(text("DROP VIEW IF EXISTS analytics.products CASCADE"))
    conn.execute(text("DROP VIEW IF EXISTS analytics.total_revenue CASCADE"))
    conn.execute(text("DROP VIEW IF EXISTS analytics.active_customers CASCADE"))
    conn.execute(text("DROP VIEW IF EXISTS analytics.conversion_rate CASCADE"))
    conn.execute(text("DROP VIEW IF EXISTS analytics.average_order_value CASCADE"))
    conn.execute(text("DROP VIEW IF EXISTS analytics.order_fulfillment_time CASCADE"))
    conn.execute(text("DROP VIEW IF EXISTS analytics.revenue_by_category CASCADE"))
    conn.execute(text("DROP VIEW IF EXISTS analytics.customer_retention_rate CASCADE"))
    conn.commit()
print("[ETL] -- Old views cleaned up")

# Phase 1: Load raw data tables
print("\n[ETL Phase 1] Loading raw data tables...")

files = {
    "raw_orders": "olist_orders_dataset.csv",
    "raw_order_items": "olist_order_items_dataset.csv",
    "raw_customers": "olist_customers_dataset.csv",
    "raw_products": "olist_products_dataset.csv",
    "raw_payments": "olist_order_payments_dataset.csv",
    "raw_sellers": "olist_sellers_dataset.csv",
    "raw_order_reviews": "olist_order_reviews_dataset.csv",
    "raw_geolocation": "olist_geolocation_dataset.csv",
}

for table, filename in files.items():
    csv_path = BASE_DIR / filename
    if not csv_path.exists():
        print(f"[ETL] -- Skipping {filename} (not found)")
        continue

    df = pd.read_csv(csv_path, parse_dates=True)
    df.to_sql(table, engine, schema="raw", if_exists="replace", index=False)
    print(f"[ETL] OK  Loaded {table} ({len(df)} rows)")


# Phase 2: Build analytics views (metrics + intermediate models)
print("\n[ETL Phase 2] Building analytics views...")

# Helper function to execute SQL file and create view
def build_view(view_name, sql_file_path):
    try:
        with open(sql_file_path, 'r') as f:
            sql_query = f.read()
        
        create_view_sql = f"DROP VIEW IF EXISTS analytics.{view_name} CASCADE; CREATE VIEW analytics.{view_name} AS\n{sql_query}"
        
        with engine.connect() as conn:
            conn.execute(text(create_view_sql))
            conn.commit()
        print(f"[ETL] OK  Created view: analytics.{view_name}")
    except Exception as e:
        print(f"[ETL] !! Failed to create {view_name}: {e}")

# Build metric views
metrics_dir = Path(__file__).parent.parent / "models" / "metrics"
metric_files = [
    ("total_revenue", "total_revenue.sql"),
    ("active_customers", "active_customers.sql"),
    ("conversion_rate", "conversion_rate.sql"),
    ("average_order_value", "average_order_value.sql"),
    ("order_fulfillment_time", "order_fulfillment_time.sql"),
    ("revenue_by_category", "revenue_by_category.sql"),
    ("customer_retention_rate", "customer_retention_rate.sql"),
]

for view_name, filename in metric_files:
    sql_path = metrics_dir / filename
    if sql_path.exists():
        build_view(view_name, sql_path)
    else:
        print(f"[ETL] -- Missing metric file: {filename}")

# Build intermediate model views
models_dir = Path(__file__).parent.parent / "models" / "intermediate"
intermediate_models = [
    ("sellers", "sellers.sql"),
    ("products", "products.sql"),
]

for view_name, filename in intermediate_models:
    sql_path = models_dir / filename
    if sql_path.exists():
        build_view(view_name, sql_path)
    else:
        print(f"[ETL] -- Missing model file: {filename}")

print("\n[ETL] OK  Pipeline complete! All views created in analytics schema.")
