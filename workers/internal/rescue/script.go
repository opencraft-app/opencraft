package rescue

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
)

func BuildArchiveScript(req ExportRequest) string {
	archive := fmt.Sprintf("%s/rescue-export-%s-%d.tar.gz", strings.TrimRight(req.RemoteWorkDir, "/"), req.InstanceID, time.Now().Unix())
	return fmt.Sprintf(`#!/usr/bin/env bash
set -euo pipefail

MOUNT_ROOT=%s
ARCHIVE=%s
DEVICE_GLOBS=(%s)
REMOTE_PATHS=(
%s
)

mkdir -p "$MOUNT_ROOT"
ROOT_SOURCE="$(findmnt -n -o SOURCE / || true)"
mounted_device=""

cleanup() {
  if mountpoint -q "$MOUNT_ROOT"; then
    umount "$MOUNT_ROOT" || true
  fi
}
trap cleanup EXIT

for pattern in "${DEVICE_GLOBS[@]}"; do
  for dev in $pattern; do
    [ -b "$dev" ] || continue
    [ "$dev" != "$ROOT_SOURCE" ] || continue
    fstype="$(blkid -o value -s TYPE "$dev" 2>/dev/null || true)"
    [ -n "$fstype" ] || continue
    if mount -o ro,noload "$dev" "$MOUNT_ROOT" 2>/tmp/rescue-mount.err; then
      mounted_device="$dev"
      break 2
    fi
    if mount -o ro "$dev" "$MOUNT_ROOT" 2>/tmp/rescue-mount.err; then
      mounted_device="$dev"
      break 2
    fi
  done
done

if [ -z "$mounted_device" ]; then
  echo "No mountable device found from: ${DEVICE_GLOBS[*]}" >&2
  lsblk -f >&2 || true
  cat /tmp/rescue-mount.err >&2 || true
  exit 10
fi

tar_args=()
for path in "${REMOTE_PATHS[@]}"; do
  rel="${path#/}"
  if [ "$rel" = "$path" ]; then
    rel="$path"
  fi
  if [ "$rel" = "" ]; then
    rel="."
  fi
  if [ -e "$MOUNT_ROOT/$rel" ]; then
    tar_args+=("$rel")
  else
    echo "Skipping missing path: $path" >&2
  fi
done

if [ "${#tar_args[@]}" -eq 0 ]; then
  echo "No requested paths exist under $MOUNT_ROOT" >&2
  exit 11
fi

tar --numeric-owner --one-file-system -C "$MOUNT_ROOT" -czf "$ARCHIVE" "${tar_args[@]}"
bytes="$(wc -c < "$ARCHIVE" | tr -d ' ')"
sha="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
printf 'RESCUE_EXPORT_RESULT={"archive":"%s","device":"%s","bytes":%%s,"sha256":"%s"}\n' "$ARCHIVE" "$mounted_device" "$bytes" "$sha"
`, shellQuote(req.MountRoot), shellQuote(archive), shellQuoteList(req.DeviceGlobs), shellLines(req.RemotePaths), "%s", "%s", "%s")
}

type archiveMarker struct {
	Archive string `json:"archive"`
	Device  string `json:"device"`
	Bytes   int64  `json:"bytes"`
	SHA256  string `json:"sha256"`
}

type uploadMarker struct {
	ObjectURL string `json:"object_url"`
	Device    string `json:"device"`
	Bytes     int64  `json:"bytes"`
	SHA256    string `json:"sha256"`
}

func ParseArchiveMarker(output string) (archiveMarker, error) {
	re := regexp.MustCompile(`(?m)^RESCUE_EXPORT_RESULT=(\{.*\})$`)
	match := re.FindStringSubmatch(output)
	if len(match) != 2 {
		return archiveMarker{}, fmt.Errorf("missing RESCUE_EXPORT_RESULT marker")
	}
	var marker archiveMarker
	if err := json.Unmarshal([]byte(match[1]), &marker); err != nil {
		return archiveMarker{}, err
	}
	return marker, nil
}

func ParseUploadMarker(output string) (uploadMarker, error) {
	re := regexp.MustCompile(`(?m)^RESCUE_UPLOAD_RESULT=(\{.*\})$`)
	match := re.FindStringSubmatch(output)
	if len(match) != 2 {
		return uploadMarker{}, fmt.Errorf("missing RESCUE_UPLOAD_RESULT marker")
	}
	var marker uploadMarker
	if err := json.Unmarshal([]byte(match[1]), &marker); err != nil {
		return uploadMarker{}, err
	}
	return marker, nil
}

func BuildUploaderRunScript(binaryURL string, configJSON string) string {
	return fmt.Sprintf(`#!/usr/bin/env bash
set -euo pipefail
workdir="$(mktemp -d /root/rescue-uploader.XXXXXX)"
cleanup() {
  rm -rf "$workdir" || true
}
trap cleanup EXIT
cd "$workdir"
cat > config.json <<'RESCUE_UPLOADER_CONFIG'
%s
RESCUE_UPLOADER_CONFIG
if command -v curl >/dev/null 2>&1; then
  curl -fL --connect-timeout 20 --max-time 300 -o rescue-uploader %s
elif command -v wget >/dev/null 2>&1; then
  wget -O rescue-uploader %s
else
  echo "neither curl nor wget is available to fetch rescue uploader" >&2
  exit 21
fi
chmod 700 rescue-uploader
./rescue-uploader config.json
`, configJSON, shellQuote(binaryURL), shellQuote(binaryURL))
}

func shellQuoteList(values []string) string {
	quoted := make([]string, 0, len(values))
	for _, value := range values {
		quoted = append(quoted, shellQuote(value))
	}
	return strings.Join(quoted, " ")
}

func shellLines(values []string) string {
	lines := make([]string, 0, len(values))
	for _, value := range values {
		lines = append(lines, "  "+shellQuote(value))
	}
	return strings.Join(lines, "\n")
}

func shellQuote(value string) string {
	if value == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
