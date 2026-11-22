#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]] || ! command -v xcodebuild >/dev/null 2>&1; then
  echo "An iOS IPA requires macOS with Xcode." >&2
  exit 1
fi
if ! command -v pod >/dev/null 2>&1; then
  echo "CocoaPods is required to build the iOS native dependencies." >&2
  exit 1
fi
if [[ -z "${APPLE_TEAM_ID:-}" ]]; then
  echo "Set APPLE_TEAM_ID to the Apple Developer team used for signing." >&2
  exit 1
fi

export NODE_ENV=production
export OPENCRAFT_IOS_EXPORT_METHOD="${OPENCRAFT_IOS_EXPORT_METHOD:-development}"
export_method="$OPENCRAFT_IOS_EXPORT_METHOD"
artifact_kind="internal"
signing_style="automatic"
archive_signing=(CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates)
provisioning_updates=(-allowProvisioningUpdates)
case "$export_method" in
  development|ad-hoc) ;;
  app-store-connect)
    if [[ "${OPENCRAFT_IOS_RELEASE:-0}" != "1" ]]; then
      echo "An App Store export requires OPENCRAFT_IOS_RELEASE=1 and a clean native project." >&2
      exit 1
    fi
    if [[ ! "$APPLE_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || [[ ! "${OPENCRAFT_IOS_BUILD_NUMBER:-}" =~ ^[1-9][0-9]{0,3}$ ]]; then
      echo "App Store exports require a valid APPLE_TEAM_ID and numeric OPENCRAFT_IOS_BUILD_NUMBER (1–9999)." >&2
      exit 1
    fi
    artifact_kind="testflight"
    signing_style="manual"
    archive_signing=()
    provisioning_updates=()
    ;;
  *) echo "Unsupported OPENCRAFT_IOS_EXPORT_METHOD: $export_method" >&2; exit 1 ;;
esac

if [[ "${OPENCRAFT_IOS_RELEASE:-0}" == "1" ]]; then
  if [[ -e ios || -L ios ]]; then
    echo "The iOS native project already exists; use a clean checkout for the release build." >&2
    exit 1
  fi
  prebuild_mode="--clean"
else
  prebuild_mode="--no-clean"
fi
product_name="${OPENCRAFT_NATIVE_ARTIFACT_NAME:-OpenCraft}"
case "$product_name" in
  *[!a-zA-Z0-9._-]*) echo "OPENCRAFT_NATIVE_ARTIFACT_NAME must be a filename prefix." >&2; exit 1 ;;
esac
CI=1 node scripts/run-expo.cjs prebuild --platform ios --no-install "$prebuild_mode"
(cd ios && pod install)

workspace="$(find ios -maxdepth 1 -name '*.xcworkspace' -print -quit)"
if [[ -z "$workspace" ]]; then
  echo "Expo prebuild did not create an Xcode workspace." >&2
  exit 1
fi
scheme="$(basename "$workspace" .xcworkspace)"
mkdir -p release
archive="$PWD/release/${product_name}-ios-${artifact_kind}.xcarchive"
artifact_dir="$(mktemp -d "$PWD/release/${product_name}-ios-export.XXXXXX")"

export_options="$(mktemp -t opencraft-ios-export.XXXXXX.plist)"
trap 'rm -f "$export_options"; rm -r "$artifact_dir"' EXIT
xcodebuild archive \
  -workspace "$workspace" \
  -scheme "$scheme" \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$archive" \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
  ${archive_signing[@]+"${archive_signing[@]}"}
cat > "$export_options" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>$export_method</string>
<key>teamID</key><string>$APPLE_TEAM_ID</string>
<key>signingStyle</key><string>$signing_style</string>
</dict></plist>
EOF
if [[ "$export_method" == "app-store-connect" ]]; then
  /usr/libexec/PlistBuddy -c 'Add :signingCertificate string Apple Distribution' \
    -c 'Add :provisioningProfiles dict' \
    -c 'Add :provisioningProfiles:app.opencraft string OpenCraft TestFlight CI' "$export_options"
fi
xcodebuild -exportArchive \
  -archivePath "$archive" \
  -exportOptionsPlist "$export_options" \
  -exportPath "$artifact_dir" \
  ${provisioning_updates[@]+"${provisioning_updates[@]}"}

ipa="$(find "$artifact_dir" -maxdepth 1 -name '*.ipa' -print -quit)"
if [[ -z "$ipa" ]]; then
  echo "Xcode export succeeded but did not produce an IPA." >&2
  exit 1
fi
artifact="release/${product_name}-ios-${artifact_kind}.ipa"
cp "$ipa" "$artifact"
shasum -a 256 "$artifact" > "$artifact.sha256"
echo "Built $artifact"
