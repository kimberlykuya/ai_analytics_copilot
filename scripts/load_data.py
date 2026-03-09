import os
import pandas as pd
from sqlalchemy import create_engine, text
from pathlib import Path, PurePosixPath

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

# Create raw schema
with engine.connect() as conn:
    conn.execute(text("CREATE SCHEMA IF NOT EXISTS raw"))
    conn.commit()


BASE_DIR = Path(__file__).parent / "data"

files = {
    "raw_orders": "olist_orders_dataset.csv",
    "raw_order_items": "olist_order_items_dataset.csv",
    "raw_customers": "olist_customers_dataset.csv",
    "raw_products": "olist_products_dataset.csv",
    "raw_payments": "olist_order_payments_dataset.csv",
}

for table, filename in files.items():
    csv_path = BASE_DIR / filename
    if not csv_path.exists():
        raise FileNotFoundError(f"expected {csv_path} to exist")

    df = pd.read_csv(csv_path, parse_dates=True)
    df.to_sql(table, engine, schema="raw", if_exists="replace", index=False)
    print(f"✓ {table}: {len(df):,} rows")
