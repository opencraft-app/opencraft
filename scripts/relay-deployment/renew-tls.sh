#!/usr/bin/env bash
# Operator-installed renewal; no inbound port other than TLS-ALPN 443.
set -euo pipefail
root=/etc/opencraft-relay
endpoint=$(cat "$root/endpoint")
[[ $endpoint =~ ^https://([a-zA-Z0-9.-]+)$ ]] || exit 1
host=${BASH_REMATCH[1]}
if [[ -f "$root/public-server.pem" ]] && openssl x509 -checkend 259200 -noout -in "$root/public-server.pem" >/dev/null; then exit 0; fi
exec 9>/var/lib/opencraft-acme/renew.lock
flock -n 9 || exit 0
trap 'systemctl start opencraft-relay.service' EXIT
systemctl stop opencraft-relay.service
/usr/local/bin/opencraft-lego run --account-id opencraft-relay --http-timeout 30 --path /var/lib/opencraft-acme --server https://acme-v02.api.letsencrypt.org/directory \
 --domains "$host" --profile shortlived --accept-tos --tls --renew-days 3 --no-random-sleep
for pair in 'crt public-server.pem 0644' 'key public-server-key.pem 0600'; do
 read -r suffix name mode <<< "$pair"
 install -m "$mode" -o opencraft-relay -g opencraft-relay "/var/lib/opencraft-acme/certificates/$host.$suffix" "$root/$name.new"
 mv "$root/$name.new" "$root/$name"
done
systemctl start opencraft-relay.service
trap - EXIT
