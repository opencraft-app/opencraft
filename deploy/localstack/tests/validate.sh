#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LOCALSTACK_ROOT="$REPO_ROOT/deploy/localstack"
KUSTOMIZE="${KUSTOMIZE:-kustomize}"

components=(
  infrastructure
  auth
  payment
  subscription
  ai-gateway
  sandbox
  cloudladdergateway
  shadow
  trade
  ctl
  service-gateway
  frontend
  migrations
  seed
)

rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT

for component in "${components[@]}"; do
  path="$LOCALSTACK_ROOT/$component"
  test -f "$path/kustomization.yaml"
  "$KUSTOMIZE" build --load-restrictor LoadRestrictionsNone "$path" >>"$rendered"
  printf '\n---\n' >>"$rendered"
done

if rg -n 'REPLACE_[A-Z0-9_]+' "$rendered"; then
  echo "localstack render contains unresolved placeholders" >&2
  exit 1
fi

if rg -n '^kind: (TkeServiceConfig|LogConfig|ServiceMonitor|PodMonitor|Ingress|ServiceAccount)$' "$rendered"; then
  echo "localstack render contains cluster-specific resources" >&2
  exit 1
fi

for image in \
  lightclaw-local/lightclaw-auth:dev \
  lightclaw-local/payment:dev \
  lightclaw-local/subscription:dev \
  lightclaw-local/ai-gateway:dev \
  lightclaw-local/sandbox-api:dev \
  lightclaw-local/cloudladdergateway:dev \
  lightclaw-local/shadow:dev \
  lightclaw-local/trade:dev \
  lightclaw-local/ctl:dev \
  lightclaw-local/fake-envd:dev \
  lightclaw-local/mock-control:dev \
  lightclaw-local/service-gateway:dev \
  lightclaw-local/frontend:dev; do
  rg -q "image: $image" "$rendered"
done

for secret in \
  lightclaw-auth-secrets \
  payment-runtime-secrets \
  subscription-runtime-secrets \
  ai-gateway-runtime-secrets \
  sandbox-runtime-secrets \
  cloudladdergateway-runtime-secrets \
  shadow-runtime-secrets \
  trade-runtime-secrets \
  ctl-runtime-secrets \
  ctl-migrate-runtime-secrets \
  service-gateway-runtime-secrets; do
  rg -q "name: $secret" "$rendered"
done

ruby -ryaml -e '
  workloads = %w[Deployment StatefulSet Job]
  rendered_host_ports = []
  YAML.load_stream(File.read(ARGV.fetch(0))).compact.each do |resource|
    next unless workloads.include?(resource["kind"])
    labels = resource.dig("spec", "template", "metadata", "labels") || {}
    unless labels["app.kubernetes.io/part-of"] == "lightclaw-localstack"
      abort "workload template is missing localstack label: #{resource.dig("metadata", "namespace")}/#{resource.dig("metadata", "name")}"
    end
    Array(resource.dig("spec", "template", "spec", "containers")).each do |container|
      Array(container["ports"]).each do |port|
        rendered_host_ports << port["hostPort"] if port["hostPort"]
      end
    end
  end
  abort "localstack workloads must not bind VM-only hostPort values" unless rendered_host_ports.empty?
' "$rendered"

ruby -ryaml -e '
  config = YAML.load_file(ARGV.fetch(0))
  route = Array(config["routes"]).find { |item| item["prefix"] == "/subscriptions" }
  abort "localstack subscription route must require an authenticated session" unless route &&
    route["access"] == "authenticated" &&
    route["auth_strategy"] == "session"
' "$LOCALSTACK_ROOT/service-gateway/config.yaml"

ruby -ryaml -e '
  config = YAML.load_file(ARGV.fetch(0))
  routes = Array(config["routes"])
  expected = {
    "/v1/instances" => %w[GET POST PUT DELETE OPTIONS],
    "/v1/me" => %w[GET OPTIONS],
    "/v1/soul-templates" => %w[GET OPTIONS],
    "/v1/bundles" => %w[GET OPTIONS],
    "/v1/passes" => %w[GET POST OPTIONS],
  }
  expected.each do |prefix, methods|
    route = routes.find { |item| item["prefix"] == prefix }
    abort "missing localstack route #{prefix}" unless route
    abort "#{prefix} must use the formal ctl-api upstream" unless
      route["upstream"] == "http://ctl-api.ctl.svc.cluster.local"
    allowed_strategies = prefix == "/v1/instances" ?
      %w[session shadow_api_key_or_session] : %w[session]
    abort "#{prefix} must accept the formal session contract" unless
      route["access"] == "authenticated" && allowed_strategies.include?(route["auth_strategy"])
    abort "#{prefix} method contract drifted" unless Array(route["methods"]) == methods
  end
' "$LOCALSTACK_ROOT/service-gateway/config.yaml"

ruby -ryaml -e '
  config = YAML.load_file(ARGV.fetch(0))
  routes = Array(config["routes"])
  expected = {
    "/v1/shadow" => ["public", nil],
    "/v1/shadow-preflight" => ["authenticated", "session"],
  }
  expected.each do |prefix, contract|
    route = routes.find { |item| item["prefix"] == prefix }
    abort "missing localstack route #{prefix}" unless route
    abort "#{prefix} must use the real Shadow service" unless
      route["upstream"] == "http://shadow.shadow.svc.cluster.local"
    abort "#{prefix} access contract drifted" unless
      route["access"] == contract[0] && route["auth_strategy"] == contract[1]
  end
' "$LOCALSTACK_ROOT/service-gateway/config.yaml"

ruby -ryaml -e '
  config = YAML.load_file(ARGV.fetch(0))
  aliases = Array(config["backends"]).to_h { |item| [item["alias"], item] }
  routes = Array(config["routes"]).to_h { |item| [item["id"], item] }
  abort "jifei must terminate at fake-jifei" unless
    aliases.dig("jifei-local", "upstream", "base_url")&.include?("fake-jifei")
  %w[tcapi-account-local tcapi-cam-local tcapi-sts-local].each do |name|
    abort "#{name} must terminate at fake-tencentcloud" unless
      aliases.dig(name, "upstream", "base_url")&.include?("fake-tencentcloud")
  end
  %w[tcapi-account-cn-test tcapi-cam-cn-test tcapi-sts-cn-test].each do |name|
    abort "#{name} must remain a signed tunnel" unless
      routes.dig(name, "mode") == "signed_http_tunnel"
  end
' "$LOCALSTACK_ROOT/cloudladdergateway/config.yaml"

rg -q '../../../ctl/k8s/base' "$LOCALSTACK_ROOT/ctl/kustomization.yaml"
rg -q 'manifests.yaml' "$LOCALSTACK_ROOT/shadow/kustomization.yaml"
rg -q '../../../trade/k8s/base' "$LOCALSTACK_ROOT/trade/kustomization.yaml"
for spec_id in spec-2c4g50g spec-4c8g80g; do
  ruby -e '
    config = File.read(ARGV.fetch(0))
    spec_id = ARGV.fetch(1)
    stanza = config.scan(/\[\[api\.instance\.spec_pools\]\]\s*(.*?)(?=\[\[|\z)/m).flatten.find do |body|
      body.match?(/^\s*spec_id\s*=\s*"#{Regexp.escape(spec_id)}"\s*$/)
    end
    abort "missing localstack CTL mapping for #{spec_id}" unless stanza
    expected = {
      "template_class_id" => "openclaw-default",
      "sku_id" => "sku-local-default",
      "default_template_id" => "pool-local-default",
    }
    expected.each do |key, value|
      abort "#{spec_id} has invalid #{key}" unless
        stanza.match?(/^\s*#{Regexp.escape(key)}\s*=\s*"#{Regexp.escape(value)}"\s*$/)
    end
    abort "#{spec_id} must include pool-local-default as a candidate" unless
      stanza.match?(/^\s*candidate_template_ids\s*=\s*\[[^\]]*"pool-local-default"[^\]]*\]\s*$/)
  ' "$LOCALSTACK_ROOT/ctl/server_conf_rewrite.toml" "$spec_id"
done
for sandbox_seed_id in openclaw-default sku-local-default pool-local-default; do
  rg -q "'$sandbox_seed_id'" "$REPO_ROOT/deploy/local/mysql/seed/020-sandbox-mock-pool.sql"
done
for spec_id in spec-2c4g50g spec-4c8g80g; do
  rg -q "'$spec_id'" "$REPO_ROOT/deploy/local/mysql/seed/030-ctl-bundles.sql"
done
rg -q '020-sandbox-mock-pool.sql=../../local/mysql/seed/020-sandbox-mock-pool.sql' \
  "$LOCALSTACK_ROOT/seed/kustomization.yaml"
rg -q '030-ctl-bundles.sql=../../local/mysql/seed/030-ctl-bundles.sql' \
  "$LOCALSTACK_ROOT/seed/kustomization.yaml"
rg -q 'apply_component seed' "$LOCALSTACK_ROOT/localstack.sh"
rg -q 'wait_job localstack-system localstack-seed' "$LOCALSTACK_ROOT/localstack.sh"
for deployment in mock-control fake-qq-oauth fake-jifei fake-tencentcloud fake-wechat-pay-bridge fake-envd; do
  rg -q "rollout status -n localstack-system deployment/$deployment" \
    "$LOCALSTACK_ROOT/localstack.sh"
done
rg -q 'base_url = "http://trade.trade.svc.cluster.local"' "$LOCALSTACK_ROOT/ctl/server_conf_rewrite.toml"
rg -q 'base_url = "http://shadow.shadow.svc.cluster.local"' "$LOCALSTACK_ROOT/ctl/server_conf_rewrite.toml"
rg -q 'JIFEI_CGW_GATEWAY_URL=http://cloudladdergateway.cloudladdergateway.svc.cluster.local' "$LOCALSTACK_ROOT/trade/kustomization.yaml"
rg -q 'SHADOW_INTERNAL_BASE_URL=http://shadow-trade-adapter.shadow.svc.cluster.local' "$LOCALSTACK_ROOT/trade/kustomization.yaml"
rg -q 'SHADOW_PROVIDER=tencent' "$LOCALSTACK_ROOT/shadow/kustomization.yaml"
rg -q 'SHADOW_CLOUDLADDER_GATEWAY_BASE_URL=http://cloudladdergateway.cloudladdergateway.svc.cluster.local' "$LOCALSTACK_ROOT/shadow/kustomization.yaml"
ctl_ai_gateway_token="$(sed -n 's/^CTL_AIGATEWAY_INTERNAL_SERVICE_TOKEN=//p' "$LOCALSTACK_ROOT/ctl/secrets.defaults.env")"
ai_gateway_token="$(sed -n 's/^LIGHTCLAW_INTERNAL_SERVICE_TOKEN=//p' "$LOCALSTACK_ROOT/ai-gateway/secrets.defaults.env")"
test -n "$ctl_ai_gateway_token"
test "$ctl_ai_gateway_token" = "$ai_gateway_token"
test -f "$REPO_ROOT/deploy/local/mysql/seed/025-ai-gateway-plans.sql"
local_ai_gateway_plan_id="$(sed -n "s/.*'\\([0-9a-f-]\\{36\\}\\)'.*-- local paid plan.*/\\1/p" "$REPO_ROOT/deploy/local/mysql/seed/025-ai-gateway-plans.sql")"
test -n "$local_ai_gateway_plan_id"
rg -q "'$local_ai_gateway_plan_id'" "$REPO_ROOT/deploy/local/mysql/seed/030-ctl-bundles.sql"
rg -q 'name: SHADOW_BASE_URL' "$LOCALSTACK_ROOT/shadow/adapter.yaml"
rg -q 'value: http://shadow.shadow.svc.cluster.local' "$LOCALSTACK_ROOT/shadow/adapter.yaml"
rg -q 'INTERNAL_SERVICE_TOKEN' "$LOCALSTACK_ROOT/shadow/adapter.yaml"
rg -q 'claimName: shadow-data' "$rendered"
if [[ -e "$REPO_ROOT/deploy/local/mockservers/trade" ]] ||
  rg -n 'fake-trade' "$rendered"; then
  echo "Trade must remain a real localstack service" >&2
  exit 1
fi
node --check "$REPO_ROOT/deploy/local/mockservers/jifei/server.mjs"
node --test "$REPO_ROOT/deploy/local/mockservers/jifei/server.test.mjs"
(
  cd "$REPO_ROOT/deploy/local/mockservers/control"
  npm ci --ignore-scripts --no-audit --no-fund
  npm test
)
node --check "$REPO_ROOT/deploy/local/mockservers/qq-oauth/server.mjs"
node --test "$REPO_ROOT/deploy/local/mockservers/qq-oauth/server.test.mjs"
node --check "$REPO_ROOT/deploy/local/mockservers/tencentcloud/server.mjs"
node --test "$REPO_ROOT/deploy/local/mockservers/tencentcloud/server.test.mjs"
openssl verify \
  -CAfile "$REPO_ROOT/deploy/local/mockservers/tencentcloud/tls/ca.crt" \
  "$REPO_ROOT/deploy/local/mockservers/tencentcloud/tls/server.crt"
rg -q 'TENCENT_REALNAME_ENDPOINT=fake-tencentcloud.localstack-system.svc.cluster.local:19443' \
  "$LOCALSTACK_ROOT/auth/kustomization.yaml"
rg -q 'SSL_CERT_FILE=/etc/lightclaw/localstack-ca/ca.crt' \
  "$LOCALSTACK_ROOT/auth/kustomization.yaml"
for key in TENCENT_REALNAME_SECRET_ID TENCENT_REALNAME_SECRET_KEY REALNAME_ENCRYPTION_KEY; do
  rg -q "^${key}=.+" "$LOCALSTACK_ROOT/auth/secrets.defaults.env"
done
realname_key="$(sed -n 's/^REALNAME_ENCRYPTION_KEY=//p' "$LOCALSTACK_ROOT/auth/secrets.defaults.env")"
test "$(printf '%s' "$realname_key" | base64 --decode | wc -c | tr -d ' ')" = "32"
rg -q 'name: fake-tencentcloud-tls' "$rendered"
rg -q 'name: localstack-tencentcloud-ca' "$rendered"
rg -q 'name: mock-control' "$rendered"
rg -q 'MOCK_CONTROL_BASE_URL' "$LOCALSTACK_ROOT/infrastructure/manifests.yaml"
rg -q 'CREATE DATABASE IF NOT EXISTS mock_control' \
  "$REPO_ROOT/deploy/local/mysql/init/001-databases.sql"
node --check "$REPO_ROOT/deploy/local/mockservers/wechat-pay-bridge/server.mjs"
rg -q 'FAKE_JIFEI_CALLBACK_URL' "$LOCALSTACK_ROOT/infrastructure/manifests.yaml"
rg -q 'trade.trade.svc.cluster.local/trade/jifei/callback' "$LOCALSTACK_ROOT/infrastructure/manifests.yaml"
rg -q 'FAKE_JIFEI_DATABASE_PATH' "$LOCALSTACK_ROOT/infrastructure/manifests.yaml"
rg -q 'claimName: fake-jifei-data' "$rendered"
ruby -ryaml -e '
  documents = YAML.load_stream(File.read(ARGV.fetch(0)))
  deployment = documents.find do |item|
    item&.dig("kind") == "Deployment" &&
      item.dig("metadata", "name") == "fake-jifei"
  end
  abort "fake-jifei must use Recreate for its single-writer SQLite database" unless
    deployment&.dig("spec", "strategy", "type") == "Recreate"
' "$rendered"
node --check "$LOCALSTACK_ROOT/shadow/adapter.mjs"
(
  cd "$REPO_ROOT/deploy/local/mockservers/envd"
  GOWORK=off GOTOOLCHAIN=auto go test ./...
)
rg -q 'location = /auth/wechat-pay' "$LOCALSTACK_ROOT/frontend/nginx.conf"
rg -q 'localhost:19040/auth/wechat-pay' "$LOCALSTACK_ROOT/frontend/nginx.conf"
rg -q 'name: frontend-nginx' "$rendered"
rg -q 'name: fake-wechat-pay-bridge' "$rendered"
for dockerfile in \
  auth \
  payment \
  subscription \
  ai-gateway \
  sandbox-api \
  sandbox-migrate \
  cloudladdergateway \
  ctl \
  fake-envd \
  shadow \
  trade \
  service-gateway; do
  test -f "$LOCALSTACK_ROOT/images/$dockerfile.Dockerfile"
  rg -q 'GOARCH=(arm64|"\$\{TARGETARCH\}")' \
    "$LOCALSTACK_ROOT/images/$dockerfile.Dockerfile"
done
test -f "$LOCALSTACK_ROOT/images/frontend.Dockerfile"
for dockerfile in \
  auth \
  payment \
  subscription \
  ai-gateway \
  sandbox-api \
  sandbox-migrate \
  cloudladdergateway \
  shadow \
  trade \
  ctl \
  fake-envd \
  service-gateway \
  frontend; do
  rg -q "images/$dockerfile.Dockerfile" "$LOCALSTACK_ROOT/localstack.sh"
done
rg -q 'processBaseUrl = "http://fake-envd.localstack-system.svc.cluster.local:19050"' \
  "$LOCALSTACK_ROOT/ctl/server_conf_rewrite.toml"
rg -q 'launchctl bootstrap' "$LOCALSTACK_ROOT/localstack.sh"
rg -q 'wait_for_namespaces_deleted' "$LOCALSTACK_ROOT/localstack.sh"
bash -n "$LOCALSTACK_ROOT/localstack.sh"
