#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required to build the Android APK." >&2
  exit 1
fi
if ! command -v java >/dev/null 2>&1; then
  echo "A JDK is required to build the Android APK." >&2
  exit 1
fi

android_sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$android_sdk" || ! -d "$android_sdk" ]]; then
  echo "Set ANDROID_HOME or ANDROID_SDK_ROOT to an installed Android SDK." >&2
  exit 1
fi

export NODE_ENV=production
# The Android project is generated and ignored. Preserve any local native edits
# while syncing the current Expo config; CI always starts from a clean checkout.
CI=1 node scripts/run-expo.cjs prebuild --platform android --no-install --no-clean

gradle_options=(--no-daemon --max-workers=2)
if [[ "${OPENCRAFT_ANDROID_USE_CN_MIRRORS:-0}" == "1" ]]; then
  gradle_options+=(-I ../scripts/gradle-cn-mirrors.init.gradle)
fi
(
  cd android
  ./gradlew :app:assembleRelease "${gradle_options[@]}"
)

source_apk="android/app/build/outputs/apk/release/app-release.apk"
artifact="release/OpenCraft-android-internal.apk"
if [[ ! -f "$source_apk" ]]; then
  echo "Gradle succeeded but did not produce $source_apk." >&2
  exit 1
fi

apksigner="$(find "$android_sdk/build-tools" -mindepth 2 -maxdepth 2 -type f -name apksigner -print -quit 2>/dev/null || true)"
if [[ -z "$apksigner" ]]; then
  echo "Android SDK build-tools with apksigner are required to verify the APK." >&2
  exit 1
fi
"$apksigner" verify "$source_apk"

mkdir -p release
cp "$source_apk" "$artifact"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$artifact" > "$artifact.sha256"
else
  shasum -a 256 "$artifact" > "$artifact.sha256"
fi
echo "Built $artifact"
