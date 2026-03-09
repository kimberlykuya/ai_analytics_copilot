-- metric: total_revenue
-- description: Total payment value from DELIVERED orders only.
--   Excludes cancelled/unavailable/in-transit orders.
--   Uses payment_value which captures installment totals.
-- grain: month, customer_state, product_category

SELECT
    DATE_TRUNC('month', o.order_purchase_timestamp::timestamp) AS month,
    c.customer_state,
    p.product_category_name AS product_category,
    SUM(pay.payment_value)  AS total_revenue
FROM raw.raw_orders o
JOIN raw.raw_payments    pay ON o.order_id    = pay.order_id
JOIN raw.raw_customers     c ON o.customer_id = c.customer_id
JOIN raw.raw_order_items  oi ON o.order_id    = oi.order_id
JOIN raw.raw_products      p ON oi.product_id = p.product_id
WHERE o.order_status = 'delivered'
GROUP BY 1,2,3
