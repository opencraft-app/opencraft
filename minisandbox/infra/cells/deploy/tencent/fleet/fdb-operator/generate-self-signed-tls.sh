#!/bin/sh
set -eu

: "${FDB_TLS_OUTPUT_DIR:?set FDB_TLS_OUTPUT_DIR to a private, non-repository directory}"
: "${FDB_TLS_CELL_NAME:?set FDB_TLS_CELL_NAME to the FoundationDBCluster name}"

openssl_bin=${OPENSSL_BIN:-openssl}
ca_days=${FDB_TLS_CA_DAYS:-54800}
leaf_days=${FDB_TLS_LEAF_DAYS:-36900}
output_dir=$FDB_TLS_OUTPUT_DIR
blobstore_ca_file=${FDB_TLS_BLOBSTORE_CA_FILE:-}

if [ -z "$blobstore_ca_file" ]; then
  for candidate in \
    /etc/ssl/certs/ca-certificates.crt \
    /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem \
    /etc/ssl/cert.pem; do
    if [ -r "$candidate" ]; then
      blobstore_ca_file=$candidate
      break
    fi
  done
fi
if [ -z "$blobstore_ca_file" ] || [ ! -r "$blobstore_ca_file" ]; then
  echo "set FDB_TLS_BLOBSTORE_CA_FILE to a readable public CA bundle" >&2
  exit 1
fi

case "$output_dir" in
  /*) ;;
  *)
    echo "FDB_TLS_OUTPUT_DIR must be an absolute path" >&2
    exit 1
    ;;
esac

umask 077
mkdir -p "$output_dir"
if find "$output_dir" -mindepth 1 -print -quit | grep -q .; then
  echo "refusing to overwrite non-empty TLS output directory: $output_dir" >&2
  exit 1
fi

ca_dir=$output_dir/ca
operator_dir=$output_dir/operator
cell_dir=$output_dir/cell
backup_dir=$output_dir/backup
work_dir=$output_dir/.work
mkdir -p "$ca_dir" "$operator_dir" "$cell_dir" "$backup_dir" "$work_dir"
printf '%s\n' \
  '[ req ]' \
  'distinguished_name = req_dn' \
  'prompt = no' \
  '[ req_dn ]' > "$work_dir/openssl.cnf"

"$openssl_bin" genpkey -algorithm RSA \
  -pkeyopt rsa_keygen_bits:4096 -out "$ca_dir/key.pem"
"$openssl_bin" req -x509 -new -sha384 -days "$ca_days" \
  -config "$work_dir/openssl.cnf" \
  -key "$ca_dir/key.pem" -out "$ca_dir/cert.pem" \
  -subj "/C=CN/O=Actor/OU=actor-fdb/CN=actor-fdb-root-ca" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -addext "subjectKeyIdentifier=hash"

issue_leaf() {
  leaf_name=$1
  leaf_cn=$2
  leaf_san=$3
  leaf_dir=$4

  "$openssl_bin" genpkey -algorithm RSA \
    -pkeyopt rsa_keygen_bits:4096 -out "$leaf_dir/key.pem"
  "$openssl_bin" req -new -sha384 -key "$leaf_dir/key.pem" \
    -config "$work_dir/openssl.cnf" \
    -out "$work_dir/$leaf_name.csr.pem" \
    -subj "/C=CN/O=Actor/OU=actor-fdb/CN=$leaf_cn"
  printf '%s\n' \
    "basicConstraints=critical,CA:FALSE" \
    "keyUsage=critical,digitalSignature,keyEncipherment" \
    "extendedKeyUsage=serverAuth,clientAuth" \
    "subjectKeyIdentifier=hash" \
    "authorityKeyIdentifier=keyid,issuer" \
    "subjectAltName=$leaf_san" > "$work_dir/$leaf_name.ext"
  leaf_serial=$("$openssl_bin" rand -hex 16)
  "$openssl_bin" x509 -req -sha384 -days "$leaf_days" \
    -in "$work_dir/$leaf_name.csr.pem" \
    -CA "$ca_dir/cert.pem" -CAkey "$ca_dir/key.pem" \
    -set_serial "0x$leaf_serial" \
    -extfile "$work_dir/$leaf_name.ext" \
    -out "$work_dir/$leaf_name.cert.pem"
  cat "$work_dir/$leaf_name.cert.pem" "$ca_dir/cert.pem" > "$leaf_dir/cert.pem"
  cp "$ca_dir/cert.pem" "$leaf_dir/ca.pem"
  "$openssl_bin" verify -CAfile "$leaf_dir/ca.pem" "$work_dir/$leaf_name.cert.pem"
  "$openssl_bin" pkey -in "$leaf_dir/key.pem" -check -noout
}

issue_leaf operator fdb-kubernetes-operator \
  "DNS:fdb-kubernetes-operator-controller-manager.actor-fdb-cell-system.svc" \
  "$operator_dir"
issue_leaf cell "$FDB_TLS_CELL_NAME" \
  "DNS:$FDB_TLS_CELL_NAME.actor-fdb-cell-system.svc,DNS:*.$FDB_TLS_CELL_NAME.actor-fdb-cell-system.svc" \
  "$cell_dir"

# fdbbackup uses one TLS trust file for both the private FoundationDB transport
# and HTTPS blobstore requests. The Operator executes lifecycle commands while
# backup-agent Pods move data, so those two identities need the combined trust
# bundle. Keep the broader public roots out of the ordinary Cell Secret.
cat "$blobstore_ca_file" "$ca_dir/cert.pem" > "$operator_dir/ca.pem"
cat "$blobstore_ca_file" "$ca_dir/cert.pem" > "$backup_dir/ca.pem"
cp "$cell_dir/cert.pem" "$backup_dir/cert.pem"
cp "$cell_dir/key.pem" "$backup_dir/key.pem"
"$openssl_bin" verify -CAfile "$backup_dir/ca.pem" "$work_dir/cell.cert.pem"
"$openssl_bin" verify -CAfile "$operator_dir/ca.pem" "$work_dir/operator.cert.pem"

rm -r -- "$work_dir"
chmod 0400 "$ca_dir/key.pem" "$operator_dir/key.pem" "$cell_dir/key.pem" \
  "$backup_dir/key.pem"
chmod 0444 "$ca_dir/cert.pem" "$operator_dir/ca.pem" "$operator_dir/cert.pem" \
  "$cell_dir/ca.pem" "$cell_dir/cert.pem" "$backup_dir/ca.pem" \
  "$backup_dir/cert.pem"

"$openssl_bin" x509 -in "$ca_dir/cert.pem" -noout \
  -subject -serial -dates -fingerprint -sha256
"$openssl_bin" x509 -in "$operator_dir/cert.pem" -noout \
  -subject -serial -dates -fingerprint -sha256
"$openssl_bin" x509 -in "$cell_dir/cert.pem" -noout \
  -subject -serial -dates -fingerprint -sha256
