package wispcloud

import (
	"strings"
	"testing"
)

func TestWispCreateScriptDetachesDaemon(t *testing.T) {
	script := wispCreateScript()

	for _, want := range []string{
		"nohup sudo -n env",
		`"$install/bin/wisp" daemon run --config "$WISP_CONFIG" >>"$log" 2>&1 </dev/null &`,
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("wisp create script missing detached daemon fragment %q", want)
		}
	}

	if strings.Contains(script, `daemon run --config "$WISP_CONFIG" >"$log" 2>&1 &`) {
		t.Fatalf("wisp create script still uses non-detached daemon redirection")
	}
}
