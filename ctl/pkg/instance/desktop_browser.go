package instance

import (
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"strings"

	pctx "ctl/pkg/context"
	"go.uber.org/zap"
)

//go:embed scripts/ensure-desktop-browser.sh
var desktopBrowserEnsureScript string

// This is the same offline capability used by the TAT rollout. It does not
// install a browser, start a desktop, or change Agent browser configuration.
func renderDesktopBrowserEnsureCommand() string {
	return "printf %s " + shellQuoteArg(base64.StdEncoding.EncodeToString([]byte(desktopBrowserEnsureScript))) + " | base64 -d | sudo -n bash -s -- --apply agentuser"
}

// Browser registration is optional. An unsupported image or failed delivery
// must not fail instance creation or cause an otherwise usable VM to be deleted.
func (l *logic) ensureDesktopBrowserOnCreate(ctx pctx.Context, sandboxID string) {
	if l == nil || l.logger == nil || strings.TrimSpace(sandboxID) == "" || isPendingSandboxID(sandboxID) {
		return
	}
	result, err := l.execSandboxPtyCommandStream(ctx, sandboxID, "desktop_browser_ensure", renderDesktopBrowserEnsureCommand(), "agentuser", 60, nil)
	if err != nil || !sandboxCommandSucceeded(result) {
		l.logger.Warn("desktop browser registration failed; instance remains usable", zap.String("sandbox_id", sandboxID), zap.Error(err))
		return
	}
	// Only compact capability status is logged, never the entire remote output.
	status := desktopBrowserEnsureStatus(result.Stdout)
	if status == "CONFIGURED" || status == "ALREADY_CONFIGURED" {
		l.logger.Info("image desktop browser registered; GUI acceptance pending", zap.String("sandbox_id", sandboxID), zap.String("browser_status", status))
	} else {
		l.logger.Warn("desktop browser registration skipped; no packages installed", zap.String("sandbox_id", sandboxID), zap.String("browser_status", status))
	}
}

func desktopBrowserEnsureStatus(output string) string {
	for _, line := range strings.Split(output, "\n") {
		if !strings.HasPrefix(line, "LV_BROWSER_JSON=") {
			continue
		}
		var value struct {
			Status string `json:"status"`
		}
		if json.Unmarshal([]byte(strings.TrimPrefix(line, "LV_BROWSER_JSON=")), &value) == nil {
			return value.Status
		}
	}
	return "UNKNOWN"
}
