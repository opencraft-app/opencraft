package instance

import (
	"os/exec"
	"strings"
	"testing"
)

func TestDesktopObserverIsNativeReadOnlyAndLoopback(t *testing.T) {
	unit := renderDesktopObserverUnit()
	for _, required := range []string{"User=agentuser", "-norc", "-display :1", "-rfbport 5901", "-localhost", "-no6", "-viewonly", "-nosel", "-noremote", "-nocmds", "-novncconnect", "NoNewPrivileges=true"} {
		if !strings.Contains(unit, required) {
			t.Fatalf("observer safety flag missing: %s", required)
		}
	}
	for _, forbidden := range []string{"websockify", "-rfbauth", "-passwd", "5900", "6080", "0.0.0.0"} {
		if strings.Contains(unit, forbidden) {
			t.Fatalf("observer consumes legacy/public capability: %s", forbidden)
		}
	}
	// Existing provision still starts exactly the original units. No capability
	// is advertised merely because the new file was installed.
	if strings.Contains(renderDesktopProvisionCommand("testOnly"), desktopObserverUnit) {
		t.Fatal("legacy provision enabled observer")
	}
	if !strings.Contains(renderDesktopStopServicesCommand(), desktopObserverUnit) {
		t.Fatal("idle cleanup forgot optional observer")
	}
	if !strings.Contains(renderDesktopStopServicesCommand(), desktopObserverProxyUnit) {
		t.Fatal("idle cleanup forgot verified observer proxy")
	}
}

func TestDesktopVerifiedObserverDeploymentIsOptionalAndBackendOnly(t *testing.T) {
	unit := renderDesktopObserverProxyUnit()
	for _, required := range []string{"User=root", "RuntimeDirectoryMode=0700", "NoNewPrivileges=true", "ProtectSystem=strict", "ProtectHome=true", "RestrictAddressFamilies=AF_UNIX AF_INET"} {
		if !strings.Contains(unit, required) {
			t.Fatalf("missing proxy protection %s", required)
		}
	}
	command := renderDesktopObserverPrepareCommand()
	if !strings.Contains(command, desktopObserverProxySource) || strings.Contains(command, "systemctl enable") {
		t.Fatal("prepare changed startup policy or detached runtime source")
	}
	if strings.Contains(renderDesktopProvisionCommand("testOnly"), desktopObserverProxyUnit) {
		t.Fatal("legacy provision enabled the verified observer")
	}
}

func TestDesktopObserverPreparationShellSyntax(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash syntax check unavailable")
	}
	command := exec.Command("bash", "-n")
	command.Stdin = strings.NewReader(renderDesktopObserverPrepareCommand())
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("observer preparation syntax: %v %s", err, output)
	}
}
