-- Intermediate model: sellers with aggregated metrics
-- Materialized as view for semantic layer

SELECT
    s.seller_id,
    s.seller_zip_code_prefix,
    s.seller_city,
    s.seller_state,
    COUNT(DISTINCT oi.order_id) AS total_orders,
    SUM(oi.price) AS total_sales,
    COUNT(DISTINCT oi.product_id) AS unique_products,
    AVG(r.review_score) AS avg_review_score
FROM raw.raw_sellers s
LEFT JOIN raw.raw_order_items oi ON s.seller_id = oi.seller_id
LEFT JOIN raw.raw_order_reviews r ON oi.order_id = r.order_id
GROUP BY 1,2,3,4
