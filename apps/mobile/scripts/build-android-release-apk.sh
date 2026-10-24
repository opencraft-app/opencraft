#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

for required in node java keytool openssl sha256sum md5sum base64; do
  command -v "$required" >/dev/null 2>&1 || { echo "$required is required." >&2; exit 1; }
done

android_sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$android_sdk" || ! -d "$android_sdk" ]]; then
  echo "Set ANDROID_HOME or ANDROID_SDK_ROOT to an installed Android SDK." >&2
  exit 1
fi

: "${OPENCRAFT_ANDROID_RELEASE_KEYSTORE:?Set the production PKCS12 keystore path}"
: "${OPENCRAFT_ANDROID_RELEASE_PASSWORD_FILE:?Set the release keystore password file path}"
: "${OPENCRAFT_ANDROID_RELEASE_KEY_ALIAS:?Set the release key alias}"
[[ -f "$OPENCRAFT_ANDROID_RELEASE_KEYSTORE" && -f "$OPENCRAFT_ANDROID_RELEASE_PASSWORD_FILE" ]] || {
  echo "Release signing files are missing." >&2
  exit 1
}

export NODE_ENV=production OPENCRAFT_ANDROID_RELEASE=1
expected_package="$(node -e 'const config = require("./app.config.js")({ config: require("./app.json").expo }); process.stdout.write(config.android.package)')"
if [[ -e android || -L android ]]; then
  echo "The Android native project already exists; use a clean checkout for the release build." >&2
  exit 1
fi
CI=1 node scripts/run-expo.cjs prebuild --platform android --no-install --clean
node scripts/configure-android-release-signing.cjs

gradle_options=(--no-daemon --max-workers=2)
if [[ "${OPENCRAFT_ANDROID_USE_CN_MIRRORS:-0}" == "1" ]]; then
  gradle_options+=(-I ../scripts/gradle-cn-mirrors.init.gradle)
fi
(
  cd android
  ./gradlew :app:assembleRelease "${gradle_options[@]}"
)

source_apk="android/app/build/outputs/apk/release/app-release.apk"
product_name="${OPENCRAFT_NATIVE_ARTIFACT_NAME:-OpenCraft}"
case "$product_name" in
  *[!a-zA-Z0-9._-]*) echo "OPENCRAFT_NATIVE_ARTIFACT_NAME must be a filename prefix." >&2; exit 1 ;;
esac
release_prefix="release/$product_name-$expected_package"
artifact="$release_prefix-android-release.apk"
[[ -f "$source_apk" ]] || { echo "Gradle did not produce $source_apk." >&2; exit 1; }

apksigner="$(find "$android_sdk/build-tools" -mindepth 2 -maxdepth 2 -type f -name apksigner -print -quit 2>/dev/null || true)"
[[ -n "$apksigner" ]] || { echo "Android SDK build-tools with apksigner are required." >&2; exit 1; }
aapt="$(dirname "$apksigner")/aapt"
[[ -x "$aapt" ]] || { echo "Android SDK build-tools with aapt are required." >&2; exit 1; }
badging="$("$aapt" dump badging "$source_apk")"
package_line="${badging%%$'\n'*}"
[[ "$package_line" == "package: name='$expected_package' "* ]] || {
  echo "The APK does not have the production application ID." >&2
  exit 1
}

certificate="$(mktemp)"
trap 'rm -f "$certificate"' EXIT
keytool -exportcert -alias "$OPENCRAFT_ANDROID_RELEASE_KEY_ALIAS" \
  -keystore "$OPENCRAFT_ANDROID_RELEASE_KEYSTORE" -storetype PKCS12 \
  -storepass:file "$OPENCRAFT_ANDROID_RELEASE_PASSWORD_FILE" \
  -file "$certificate" >/dev/null
expected_digest="$(sha256sum "$certificate" | cut -d' ' -f1)"
verification="$("$apksigner" verify --verbose --print-certs "$source_apk")"
grep -Fxq "Signer #1 certificate SHA-256 digest: $expected_digest" <<< "$verification" || {
    echo "The APK signature does not match the production keystore." >&2
    exit 1
  }

mkdir -p release
cp "$source_apk" "$artifact"
sha256sum "$artifact" > "$artifact.sha256"
cp "$certificate" "$release_prefix-signing-cert.der"
openssl x509 -inform DER -in "$release_prefix-signing-cert.der" -pubkey -noout \
  > "$release_prefix-public-key.pem"
openssl pkey -pubin -in "$release_prefix-public-key.pem" -outform DER \
  > "$release_prefix-public-key.der"
base64 -w0 "$release_prefix-public-key.der" > "$release_prefix-public-key.base64.txt"
{
  echo "Android package: $expected_package"
  echo "Signing certificate MD5: $(md5sum "$certificate" | cut -d' ' -f1 | tr '[:lower:]' '[:upper:]')"
  echo "APK file MD5: $(md5sum "$artifact" | cut -d' ' -f1)"
  echo "Public key (Base64 DER SPKI): $(cat "$release_prefix-public-key.base64.txt")"
} > "$release_prefix-filing.txt"
echo "Built $artifact and $release_prefix-filing.txt"
