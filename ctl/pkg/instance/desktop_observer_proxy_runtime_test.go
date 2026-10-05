package instance

import (
	"context"
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestDesktopObserverProxyNative(t *testing.T) {
	if os.Getenv("OPENCRAFT_DESKTOP_NATIVE_TEST") != "1" {
		t.Skip("explicit isolated native observation only")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "python3", "-B", "desktop_observer_proxy_test.py", "-v")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("native proxy: %v\n%s", err, output)
	}
}
