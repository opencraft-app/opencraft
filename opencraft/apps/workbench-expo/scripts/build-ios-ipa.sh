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
CI=1 node scripts/run-expo.cjs prebuild --platform ios --no-install --no-clean
(cd ios && pod install)

workspace="$(find ios -maxdepth 1 -name '*.xcworkspace' -print -quit)"
if [[ -z "$workspace" ]]; then
  echo "Expo prebuild did not create an Xcode workspace." >&2
  exit 1
fi
scheme="$(basename "$workspace" .xcworkspace)"
archive="$PWD/release/OpenCraft-ios-internal.xcarchive"
artifact_dir="$PWD/release/ios-export"
export_method="${OPENCRAFT_IOS_EXPORT_METHOD:-development}"
case "$export_method" in
  development|ad-hoc) ;;
  *) echo "OPENCRAFT_IOS_EXPORT_METHOD must be development or ad-hoc." >&2; exit 1 ;;
esac

mkdir -p release "$artifact_dir"
xcodebuild archive \
  -workspace "$workspace" \
  -scheme "$scheme" \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$archive" \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates

export_options="$(mktemp -t opencraft-ios-export.XXXXXX.plist)"
trap 'rm -f "$export_options"' EXIT
cat > "$export_options" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>$export_method</string>
<key>teamID</key><string>$APPLE_TEAM_ID</string>
<key>signingStyle</key><string>automatic</string>
</dict></plist>
EOF
xcodebuild -exportArchive \
  -archivePath "$archive" \
  -exportOptionsPlist "$export_options" \
  -exportPath "$artifact_dir" \
  -allowProvisioningUpdates

ipa="$(find "$artifact_dir" -maxdepth 1 -name '*.ipa' -print -quit)"
if [[ -z "$ipa" ]]; then
  echo "Xcode export succeeded but did not produce an IPA." >&2
  exit 1
fi
cp "$ipa" release/OpenCraft-ios-internal.ipa
shasum -a 256 release/OpenCraft-ios-internal.ipa > release/OpenCraft-ios-internal.ipa.sha256
echo "Built release/OpenCraft-ios-internal.ipa"
