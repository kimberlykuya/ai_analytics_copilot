-- metric: order_fulfillment_time
-- description: Avg calendar days from purchase to customer delivery.
--   Only delivered orders. High values = logistics problems.
-- grain: month, customer_state

SELECT
    DATE_TRUNC('month', o.order_purchase_timestamp::timestamp) AS month,
    c.customer_state,
    ROUND(AVG(
        EXTRACT(EPOCH FROM (
            o.order_delivered_customer_date::timestamp - o.order_purchase_timestamp::timestamp
        )) / 86400
    )::numeric, 1) AS avg_fulfillment_days
FROM raw.raw_orders o
JOIN raw.raw_customers c ON o.customer_id = c.customer_id
WHERE o.order_status = 'delivered'
  AND o.order_delivered_customer_date IS NOT NULL
GROUP BY 1,2
