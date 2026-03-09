-- metric: conversion_rate
-- description: % of created orders that reach 'delivered'.
--   Formula: delivered / total_created * 100
--   In-transit orders do NOT count as converted.
-- grain: month

SELECT
    DATE_TRUNC('month', order_purchase_timestamp::timestamp) AS month,
    COUNT(*)                                       AS total_orders,
    COUNT(*) FILTER (WHERE order_status='delivered') AS delivered_orders,
    ROUND(COUNT(*) FILTER (WHERE order_status='delivered') * 100.0 / COUNT(*), 2)
        AS conversion_rate_pct
FROM raw.raw_orders
GROUP BY 1
