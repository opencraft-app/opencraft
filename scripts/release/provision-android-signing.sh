#!/usr/bin/env bash
# One-time provisioning of the Android production signing key.
#
# Run on a trusted computer with JDK keytool, openssl and an authenticated gh
# that may administer the repository. Given a new directory outside any Git
# checkout it generates the PKCS12 key there; given an existing key directory
# (opencraft-release.p12 and password.txt) it uploads that key. It restricts the
# android-release Environment to main and stores the key, password and alias as
# Environment secrets.
#
# Every later app.opencraft release must be signed by this key, or installed
# apps cannot update. Back up the generated directory before deleting anything.
#
# Usage: provision-android-signing.sh <key-directory-outside-git> [owner/repo]
set -euo pipefail

directory="${1:?Usage: provision-android-signing.sh <key-directory-outside-git> [owner/repo]}"
repository="${2:-opencraft-app/opencraft}"
environment=android-release
alias=opencraft-release

for required in keytool openssl gh base64; do
  command -v "$required" >/dev/null 2>&1 || { echo "$required is required." >&2; exit 1; }
done
[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "Repository must be owner/name." >&2; exit 1; }
parent="$(cd "$(dirname "$directory")" && pwd)"
if git -C "$parent" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Keep the signing key outside Git checkouts: $parent is inside one." >&2
  exit 1
fi

# Replacing an existing key would make every installed app unable to update, so
# continue only when the inventory is known: a missing Environment (HTTP 404)
# or a readable secret list without the key. Any other failure stops here,
# before a key, policy or secret changes.
lookup_error="$(mktemp)"
trap 'rm -f "$lookup_error"' EXIT
if gh api "repos/$repository/environments/$environment" >/dev/null 2>"$lookup_error"; then
  if ! names="$(gh secret list --env "$environment" --repo "$repository" --json name --jq '.[].name')"; then
    echo "Cannot read the $environment secrets; refusing to continue without knowing whether a key exists." >&2
    exit 1
  fi
  if grep -qx ANDROID_RELEASE_KEYSTORE_BASE64 <<<"$names"; then
    echo "The $environment Environment already holds a signing key; refusing to replace it." >&2
    exit 1
  fi
elif ! grep -q 'HTTP 404' "$lookup_error"; then
  cat "$lookup_error" >&2
  echo "Cannot verify the $environment Environment; refusing to continue." >&2
  exit 1
fi

directory="$parent/$(basename "$directory")"
keystore="$directory/opencraft-release.p12"
password_file="$directory/password.txt"
if [[ ! -e "$directory" ]]; then
  (umask 077 && mkdir "$directory")
  (umask 077 && openssl rand -base64 32 | tr -d '\n' > "$password_file")
  keytool -genkeypair -noprompt \
    -storetype PKCS12 -keystore "$keystore" \
    -storepass:file "$password_file" -keypass:file "$password_file" \
    -alias "$alias" -keyalg RSA -keysize 4096 -validity 10000 \
    -dname "CN=OpenCraft" >/dev/null
  chmod 600 "$keystore"
elif [[ ! -f "$keystore" || ! -f "$password_file" ]]; then
  echo "$directory exists without opencraft-release.p12 and password.txt; choose a new directory." >&2
  exit 1
fi

fingerprint="$(keytool -list -keystore "$keystore" -storetype PKCS12 -storepass:file "$password_file" \
  -alias "$alias" | sed -n 's/^Certificate fingerprint (SHA-256): //p')"
[[ -n "$fingerprint" ]] || { echo "The keystore does not open with password.txt and alias $alias." >&2; exit 1; }

gh api --method PUT "repos/$repository/environments/$environment" --input - >/dev/null <<'EOF'
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
EOF
policies="$(gh api "repos/$repository/environments/$environment/deployment-branch-policies" \
  --jq '.branch_policies[].name')"
if ! grep -qx main <<<"$policies"; then
  gh api --method POST "repos/$repository/environments/$environment/deployment-branch-policies" \
    -f name=main -f type=branch >/dev/null
fi

base64 < "$keystore" | tr -d '\n' \
  | gh secret set ANDROID_RELEASE_KEYSTORE_BASE64 --env "$environment" --repo "$repository"
gh secret set ANDROID_RELEASE_KEYSTORE_PASSWORD --env "$environment" --repo "$repository" < "$password_file"
printf '%s' "$alias" | gh secret set ANDROID_RELEASE_KEY_ALIAS --env "$environment" --repo "$repository"

cat <<EOF
Stored the $environment signing secrets for $repository (deployments limited to main).
Signing certificate SHA-256: $fingerprint
Back up $directory (keystore and password) to a password manager or offline
storage now. Losing it means installed app.opencraft apps can no longer update.
EOF
