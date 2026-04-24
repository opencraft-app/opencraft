INSERT INTO subscriptions (user_id, tier, confirmed_at, created_at, updated_at)
SELECT
  s.user_id,
  s.plan_tier,
  COALESCE(s.plan_confirmed_at, s.updated_at, s.created_at),
  COALESCE(s.plan_confirmed_at, s.created_at, s.updated_at),
  COALESCE(s.updated_at, s.created_at, s.plan_confirmed_at)
FROM auth_sessions s
WHERE s.plan_tier IS NOT NULL
ON DUPLICATE KEY UPDATE
  tier = IF(VALUES(confirmed_at) >= subscriptions.confirmed_at, VALUES(tier), subscriptions.tier),
  confirmed_at = GREATEST(subscriptions.confirmed_at, VALUES(confirmed_at)),
  updated_at = IF(
    VALUES(confirmed_at) >= subscriptions.confirmed_at,
    VALUES(updated_at),
    subscriptions.updated_at
  );
