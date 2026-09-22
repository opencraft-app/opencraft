#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CTL_SEED="$REPO_ROOT/deploy/localstack/seed-data/cn/030-ctl-bundles.sql"
TRADE_SEED="$REPO_ROOT/deploy/localstack/seed-data/cn/040-trade-bundles.sql"
PLAN_SEED="$REPO_ROOT/deploy/local/mysql/seed/025-ai-gateway-plans.sql"

for bundle_id in bundle_launch_ai_01 bundle_cruise_ai_01; do
  rg -Fq "'$bundle_id'" "$CTL_SEED"
  rg -Fq "'$bundle_id'" "$TRADE_SEED"
done

rg -Fq "'535ffe59-ddef-4a15-8033-8de4f7651a00'" "$PLAN_SEED"
rg -Fq "'62870d82-9311-4436-86ba-f95866d550e9'" "$PLAN_SEED"
rg -Fq "'sp_lighthouse_lightvela_ai_mc', 1060103" "$TRADE_SEED"
rg -Fq "JSON_OBJECT('scene', 'modify', 'category', 2025275)" "$TRADE_SEED"
