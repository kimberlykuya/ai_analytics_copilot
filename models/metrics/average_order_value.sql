-- metric: average_order_value (AOV)
-- description: Avg revenue per delivered order.
--   Formula: SUM(payment_value) / COUNT(delivered_orders)
--   Excludes cancelled orders entirely.
-- grain: month, product_category

SELECT
    DATE_TRUNC('month', o.order_purchase_timestamp::timestamp) AS month,
    p.product_category_name                          AS product_category,
    ROUND(AVG(pay.payment_value)::numeric, 2)        AS avg_order_value
FROM raw.raw_orders o
JOIN raw.raw_payments   pay ON o.order_id    = pay.order_id
JOIN raw.raw_order_items oi ON o.order_id    = oi.order_id
JOIN raw.raw_products     p ON oi.product_id = p.product_id
WHERE o.order_status = 'delivered'
GROUP BY 1,2
