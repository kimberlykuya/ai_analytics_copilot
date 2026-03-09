-- Intermediate model: products with engagement metrics
-- Materialized as view for semantic layer

SELECT
    p.product_id,
    p.product_category_name,
    COUNT(DISTINCT oi.order_id) AS order_count,
    SUM(oi.price) AS total_revenue,
    AVG(r.review_score) AS avg_review_score,
    COUNT(r.review_id) AS review_count
FROM raw.raw_products p
LEFT JOIN raw.raw_order_items oi ON p.product_id = oi.product_id
LEFT JOIN raw.raw_order_reviews r ON oi.order_id = r.order_id
GROUP BY 1,2
