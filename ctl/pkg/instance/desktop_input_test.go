package instance

import (
	"os/exec"
	"strings"
	"testing"
)

func TestDesktopInputEpochCommandsValidateBindings(t *testing.T) {
	const id = "11111111-1111-4111-8111-111111111111"
	const next = "22222222-2222-4222-8222-222222222222"
	digest := strings.Repeat("a", 64)
	grant := renderDesktopInputGrantCommand(id, 1234, digest, next, digest)
	if !strings.HasSuffix(grant, "--grant "+id+" 1234 "+digest+" "+next+" "+digest) {
		t.Fatal("grant lost epoch binding")
	}
	if !strings.HasSuffix(renderDesktopInputActivateCommand(next, "", digest), "--activate "+next+" - "+digest) {
		t.Fatal("initial CAS missing empty epoch marker")
	}
	if !strings.HasSuffix(renderDesktopInputActivateCommand(next, id, digest), "--activate "+next+" "+id+" "+digest) {
		t.Fatal("CAS missing expected generation")
	}
	for _, invalid := range []string{"", "gen-1", id + ";id", "$(id)", strings.ToUpper("abcdefab-abcd-4abc-8abc-abcdefabcdef")} {
		if renderDesktopInputGrantCommand(id, 1234, digest, invalid, digest) != "exit 1" {
			t.Errorf("accepted generation %q", invalid)
		}
		if renderDesktopInputActivateCommand(invalid, id, digest) != "exit 1" {
			t.Errorf("accepted activation generation %q", invalid)
		}
		if invalid != "" && renderDesktopInputActivateCommand(next, invalid, digest) != "exit 1" {
			t.Errorf("accepted expected generation %q", invalid)
		}
	}
	for _, invalid := range []string{"", digest + ";id", strings.Repeat("A", 64), strings.Repeat("a", 63)} {
		if renderDesktopInputGrantCommand(id, 1234, digest, next, invalid) != "exit 1" {
			t.Error("accepted invalid incarnation")
		}
		if renderDesktopInputActivateCommand(next, id, invalid) != "exit 1" {
			t.Error("accepted invalid activation incarnation")
		}
	}
	for _, invalid := range []string{"", `{}`, `{"generation":null}`, `{"generation":"bad"}`, `{"generation":""} {"generation":""}`} {
		if _, ok := parseDesktopInputEpoch(invalid); ok {
			t.Errorf("accepted invalid epoch %q", invalid)
		}
	}
}

// TestDesktopInputEndpointIsLoopbackWritableAndPasswordless 键鼠是硬需求，但端点
// 不能退回「公网 + 密码」：可写端口必须只绑回环、不带 RFB 密码，且不能复用
// 5900（它在 ingressproxy 后面，是靠密码保护的 legacy 端点）。
func TestDesktopInputEndpointIsLoopbackWritableAndPasswordless(t *testing.T) {
	unit := renderDesktopInputUnit()

	for _, want := range []string{
		"-display :1",
		"-rfbport 5903",
		// 只绑回环：公网不可达，TAT 隧道是唯一入口。
		"-localhost",
		// 不下发密码：隧道本身已经是凭据。
		"-nopw",
		// 单主独占：同一时刻只有一个客户端持有键鼠。
		"-nevershared",
		// 不踢掉既有的 5900/5901 服务。
		"-dontdisconnect",
		// x11vnc 自身的远程控制面保持关闭。
		"-noremote", "-nocmds", "-novncconnect",
		"User=agentuser",
	} {
		if !strings.Contains(unit, want) {
			t.Fatalf("input unit must contain %q:\n%s", want, unit)
		}
	}

	for _, forbidden := range []string{
		// 只读 observer 的原语不能出现在这里。
		"-viewonly",
		// 不能复用受密码保护的 legacy 端点，也不能自己引入密码。
		"-rfbauth", "-passwd", "5900",
		// 公网监听。
		"0.0.0.0",
		// websockify/ingressproxy 相关。
		"websockify",
	} {
		if strings.Contains(unit, forbidden) {
			t.Fatalf("input unit must not contain %q:\n%s", forbidden, unit)
		}
	}
}

func TestDesktopInputProxyCapabilitiesAllowPhysicalIdentity(t *testing.T) {
	if !strings.Contains(renderDesktopInputProxyUnit(), "CapabilityBoundingSet=CAP_DAC_READ_SEARCH CAP_SYS_PTRACE\n") {
		t.Fatal("input gateway must retain only observer identity /proc capabilities")
	}
}

// TestDesktopInputPrepareCommandDoesNotTouchLegacyUnits 准备命令只允许操作自己的
// unit：不能重启或改动 5900 / 5901 / websockify，否则会影响仍在使用 ingressproxy
// 的区域。
func TestDesktopInputPrepareCommandDoesNotTouchLegacyUnits(t *testing.T) {
	command := renderDesktopInputPrepareCommand()
	if len(command) >= desktopInstallCommandLimit {
		t.Fatalf("prepare command exceeds TAT input limit: %d", len(command))
	}
	check := exec.Command("bash", "-n")
	check.Stdin = strings.NewReader(command)
	if output, err := check.CombinedOutput(); err != nil {
		t.Fatalf("invalid prepare shell syntax: %v: %s", err, output)
	}

	for _, want := range []string{
		"vela-desktop-input.service",
		"systemctl daemon-reload",
		"systemctl is-active --quiet vela-desktop-input.service",
		"/etc/systemd/system/opencraft-desktop-input-gateway.service",
		renderDesktopInputProxyUnit(),
	} {
		if !strings.Contains(command, want) {
			t.Fatalf("prepare command must contain %q:\n%s", want, command)
		}
	}
	// 只写自己的 unit 文件。
	if !strings.Contains(command, "/etc/systemd/system/vela-desktop-input.service") {
		t.Fatalf("prepare command must install only its own unit:\n%s", command)
	}
	for _, forbidden := range []string{
		"vela-x11vnc",
		"vela-desktop-observer",
		"vela-novnc",
		"websockify",
	} {
		if strings.Contains(command, forbidden) {
			t.Fatalf("prepare command must not touch %q:\n%s", forbidden, command)
		}
	}
}
