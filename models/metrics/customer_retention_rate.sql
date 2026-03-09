-- metric: customer_retention_rate
-- description: % of month-N customers who also ordered in month N+1.
--   Cohort base = distinct buyers in month N.
--   Retained = same customer_unique_id appears in month N+1.
-- grain: monthly cohort

WITH monthly AS (
    SELECT DATE_TRUNC('month', o.order_purchase_timestamp::timestamp) AS month,
           c.customer_unique_id
    FROM raw.raw_orders o
    JOIN raw.raw_customers c ON o.customer_id = c.customer_id
    WHERE o.order_status = 'delivered'
    GROUP BY 1,2
)
SELECT
    m1.month,
    COUNT(DISTINCT m1.customer_unique_id) AS cohort_size,
    COUNT(DISTINCT m2.customer_unique_id) AS retained_next_month,
    ROUND(COUNT(DISTINCT m2.customer_unique_id) * 100.0 /
          NULLIF(COUNT(DISTINCT m1.customer_unique_id),0), 2) AS retention_rate_pct
FROM monthly m1
LEFT JOIN monthly m2
       ON m1.customer_unique_id = m2.customer_unique_id
      AND m2.month = m1.month + INTERVAL '1 month'
GROUP BY 1
