-- metric: revenue_by_category
-- description: Delivered revenue by product_category_name.
--   Use THIS instead of total_revenue when question involves product segments.
-- grain: month, product_category

SELECT
    DATE_TRUNC('month', o.order_purchase_timestamp::timestamp) AS month,
    p.product_category_name   AS product_category,
    SUM(pay.payment_value)    AS category_revenue,
    COUNT(DISTINCT o.order_id) AS order_count
FROM raw.raw_orders o
JOIN raw.raw_payments   pay ON o.order_id    = pay.order_id
JOIN raw.raw_order_items oi ON o.order_id    = oi.order_id
JOIN raw.raw_products     p ON oi.product_id = p.product_id
WHERE o.order_status = 'delivered'
GROUP BY 1,2
