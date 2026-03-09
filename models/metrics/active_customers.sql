-- metric: active_customers
-- description: Unique customers (by customer_unique_id) with at least one
--   delivered order. Uses unique_id to avoid address-change double-counting.
-- grain: month, customer_state

SELECT
    DATE_TRUNC('month', o.order_purchase_timestamp::timestamp) AS month,
    c.customer_state,
    COUNT(DISTINCT c.customer_unique_id)            AS active_customers
FROM raw.raw_orders o
JOIN raw.raw_customers c ON o.customer_id = c.customer_id
WHERE o.order_status = 'delivered'
GROUP BY 1,2
