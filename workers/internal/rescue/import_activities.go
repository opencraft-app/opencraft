package rescue

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

const hermesImportResultMarker = "LIGHTVELA_HERMES_IMPORT_RESULT"

func (Activities) PrepareImportTATCommand(ctx context.Context, req ImportRequest, cfg TencentConfig, region string) (PreparedImport, error) {
	req = NormalizeImportRequest(req)
	if strings.TrimSpace(req.ImportObjectKey) == "" {
		return PreparedImport{}, temporalActivityError(fmt.Errorf("import object key is required"))
	}
	exportReq := req.exportRequest()
	target, err := GenerateCOSUploadTarget(ctx, cfg, exportReq, req.ImportObjectKey, http.MethodGet)
	if err != nil {
		return PreparedImport{}, temporalActivityError(err)
	}
	if strings.TrimSpace(req.ImportObjectURL) != "" {
		target.ObjectURL = req.ImportObjectURL
	}
	script := BuildHermesImportScript(target.SignedURL)
	if !req.Execute {
		fmt.Println("[dry-run] TAT import command:")
		fmt.Println(script)
	}
	return PreparedImport{
		InstanceID: req.InstanceID,
		Region:     region,
		ObjectURL:  target.ObjectURL,
		ObjectKey:  req.ImportObjectKey,
		Bucket:     req.COSUploadBucket,
		Command: TATCommandRequest{
			CommandName:    "hermes-import-workspace",
			Script:         script,
			TimeoutSeconds: req.CommandTimeoutSeconds,
		},
	}, nil
}

func (Activities) FinalizeImportOverTAT(ctx context.Context, req ImportRequest, prepared PreparedImport, result TATCommandResult) (PreparedImport, error) {
	if !req.Execute {
		return prepared, nil
	}
	markerLine := ""
	for _, line := range strings.Split(result.Output, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), hermesImportResultMarker) {
			markerLine = strings.TrimSpace(line)
		}
	}
	if markerLine == "" {
		return PreparedImport{}, fmt.Errorf("Hermes import did not report completion marker; tat_status=%s dropped=%d output_url=%s output=%s",
			result.TaskStatus, result.DroppedBytes, result.OutputURL, trimForLog(result.Output, 4096))
	}
	prepared.RemoteOutput = trimForLog(result.Output, 2048)
	for _, field := range strings.Fields(strings.TrimPrefix(markerLine, hermesImportResultMarker)) {
		key, value, ok := strings.Cut(field, "=")
		if !ok {
			continue
		}
		switch key {
		case "archive_bytes":
			if parsed, err := strconv.ParseInt(value, 10, 64); err == nil {
				prepared.ByteSize = parsed
			}
		case "archive_path":
			prepared.ArchivePath = value
		}
	}
	return prepared, nil
}

func BuildHermesImportScript(downloadURL string) string {
	return strings.TrimSpace(`#!/usr/bin/env bash
set -euo pipefail

export PATH="/home/agentuser/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
tmpdir="$(mktemp -d /tmp/lightvela-hermes-import.XXXXXX)"
archive="$tmpdir/hermes-backup.zip"
cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

echo "[import] downloading Hermes backup"
curl -fL --retry 3 --connect-timeout 10 --max-time 900 -o "$archive" ` + shellQuote(downloadURL) + `
bytes="$(wc -c < "$archive" | tr -d ' ')"
if [ "${bytes:-0}" -le 0 ]; then
  echo "[import] uploaded archive is empty" >&2
  exit 20
fi

if command -v unzip >/dev/null 2>&1; then
  unzip -t "$archive" >/dev/null
elif command -v python3 >/dev/null 2>&1; then
  python3 - "$archive" <<'PY'
import sys, zipfile
path = sys.argv[1]
with zipfile.ZipFile(path) as zf:
    bad = zf.testzip()
    if bad:
        raise SystemExit("bad zip member: " + bad)
PY
else
  echo "[import] neither unzip nor python3 is available for zip validation" >&2
  exit 21
fi

if ! command -v hermes >/dev/null 2>&1; then
  echo "[import] hermes command is not available" >&2
  exit 22
fi

echo "[import] running hermes import"
printf 'y\n' | hermes import --force "$archive"
printf '` + hermesImportResultMarker + ` archive_bytes=%s archive_path=%s\n' "$bytes" "$archive"
`)
}
