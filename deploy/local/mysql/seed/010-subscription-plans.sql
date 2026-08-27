USE subscription;

INSERT INTO subscription_plans (code, description, max_bot_count)
VALUES
  ('free', 'Local free plan', 1),
  ('lite', 'Local lite plan', 3),
  ('pro', 'Local pro plan', 10)
ON DUPLICATE KEY UPDATE
  description = VALUES(description),
  max_bot_count = VALUES(max_bot_count),
  updated_at = CURRENT_TIMESTAMP(6);
