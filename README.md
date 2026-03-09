# AI Analytics Copilot - Python ETL Pipeline

**Replaces dbt with Python + SQL for data transformation**

## Setup

1. **Create `.env` file** (copy from `.env.example`):
   ```bash
   cp .env.example .env
   ```

2. **Install dependencies** (already done):
   ```bash
   pip install -r requirements.txt
   ```

3. **Start PostgreSQL** (if not running):
   ```bash
   docker compose up -d
   ```

## Running the Pipeline

**Equivalent to `dbt run`:**
```bash
python scripts/load_data.py
```

Or use the convenience runner:
```bash
python run_pipeline.py
```

## Pipeline Phases

### Phase 1: Load Raw Data
Loads all CSV files into PostgreSQL `raw` schema:
- `raw_orders`
- `raw_order_items`
- `raw_customers`
- `raw_products`
- `raw_payments`
- `raw_sellers`
- `raw_order_reviews`
- `raw_geolocation`

### Phase 2: Build Analytics Views
Creates computed views in `analytics` schema:

**7 Metric Views** (models/metrics/):
1. `total_revenue` - Revenue by month, state, category
2. `active_customers` - Unique customers per month & state
3. `conversion_rate` - % orders delivered (monthly)
4. `average_order_value` - AOV by month & category
5. `order_fulfillment_time` - Delivery days by month & state
6. `revenue_by_category` - Revenue breakdown by product category
7. `customer_retention_rate` - Month-over-month retention cohorts

**2 Intermediate Models** (models/):
1. `sellers` - Seller aggregates (orders, sales, reviews)
2. `products` - Product engagement metrics

## Query Examples

All views are in the `analytics` schema:

```sql
-- Total revenue by month
SELECT * FROM analytics.total_revenue ORDER BY month DESC LIMIT 12;

-- Active customers trend
SELECT * FROM analytics.active_customers ORDER BY month DESC;

-- Conversion by month
SELECT * FROM analytics.conversion_rate ORDER BY month DESC;

-- Seller performance rankings
SELECT * FROM analytics.sellers ORDER BY total_sales DESC LIMIT 10;

-- Product metrics
SELECT * FROM analytics.products ORDER BY order_count DESC;
```

## Configuration

### Environment Variables (.env)
- `POSTGRES_USER`: Database user (default: analytics)
- `POSTGRES_PASSWORD`: Database password (default: analytics)
- `POSTGRES_HOST`: Host (default: 127.0.0.1)
- `POSTGRES_PORT`: Port (default: 5433)
- `POSTGRES_DB`: Database name (default: olist)

### Data Files
CSV files should be placed in `scripts/data/`:
```
scripts/data/
├── olist_orders_dataset.csv
├── olist_order_items_dataset.csv
├── olist_customers_dataset.csv
├── olist_products_dataset.csv
├── olist_payments_dataset.csv
├── olist_sellers_dataset.csv
├── olist_order_reviews_dataset.csv
└── olist_geolocation_dataset.csv
```

## View Structure

```
PostgreSQL
├── raw (schema)
│   ├── raw_orders
│   ├── raw_order_items
│   ├── raw_customers
│   ├── raw_products
│   ├── raw_payments
│   ├── raw_sellers
│   ├── raw_order_reviews
│   └── raw_geolocation
│
└── analytics (schema)
    ├── total_revenue (metric)
    ├── active_customers (metric)
    ├── conversion_rate (metric)
    ├── average_order_value (metric)
    ├── order_fulfillment_time (metric)
    ├── revenue_by_category (metric)
    ├── customer_retention_rate (metric)
    ├── sellers (intermediate)
    └── products (intermediate)
```

## Advantages over dbt

✓ **Works with Python 3.14** (no compatibility issues)
✓ **Simpler setup** (no profiles.yml, no dbt CLI issues)
✓ **Full Python control** (can add custom transformations)
✓ **Easier debugging** (standard Python stack traces)
✓ **Can call from other Python code** (notebooks, APIs, etc.)

## Next Steps

1. Add Great Expectations for data quality tests
2. Create orchestration with Airflow/Prefect
3. Add more intermediate models
4. Create business metric calculations
