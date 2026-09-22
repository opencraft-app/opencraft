#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CTL_SEED="$REPO_ROOT/deploy/localstack/seed-data/intl/030-ctl-bundles.sql"
TRADE_SEED="$REPO_ROOT/deploy/localstack/seed-data/intl/040-trade-bundles.sql"
PLAN_SEED="$REPO_ROOT/deploy/local/mysql/seed/025-ai-gateway-plans.sql"

for bundle_id in bundle_launch_ai_01 bundle_cruise_ai_01; do
  rg -Fq "'$bundle_id'" "$CTL_SEED"
  rg -Fq "'$bundle_id'" "$TRADE_SEED"
done

rg -Fq "'00000000-0000-4000-8000-000000000004'" "$PLAN_SEED"
rg -Fq "'00000000-0000-4000-8000-000000000005'" "$PLAN_SEED"
rg -Fq "'sp_lighthouse_lightvela_ai_intl'," "$TRADE_SEED"
rg -Fq '1060119,' "$TRADE_SEED"
rg -Fq "JSON_OBJECT('scene', 'modify', 'category', 2025272)" "$TRADE_SEED"
rg -Fq "'sv_lighthouse_lv_ai_compute_intl_launch_med4_01', 1" "$TRADE_SEED"
rg -Fq "'sv_lighthouse_lv_ai_compute_intl_cruise_lg8_01', 1" "$TRADE_SEED"
