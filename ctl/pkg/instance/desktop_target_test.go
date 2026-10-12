package instance

import (
	"strings"
	"testing"
)

func TestParseDesktopIncarnationAcceptsOnlyVerifiedProof(t *testing.T) {
	incarnation := strings.Repeat("a", 64)

	if got, ok := parseDesktopIncarnation(`{"verified":true,"incarnation":"` + incarnation + `","readOnly":true}`); !ok || got != incarnation {
		t.Fatalf("a verified proof must yield the incarnation, got %q ok=%v", got, ok)
	}
	// 真实 TAT 输出前后会有噪声，只取最后一条 JSON。
	if got, ok := parseDesktopIncarnation("noise\n" + `{"verified":true,"incarnation":"` + incarnation + `","readOnly":true}` + "\nmore"); !ok || got != incarnation {
		t.Fatalf("the last JSON line must win, got %q ok=%v", got, ok)
	}

	for _, rejected := range []string{
		"",
		"not json",
		`{"verified":false,"reason":"observer proxy unavailable"}`,
		`{"verified":true,"incarnation":"short","readOnly":true}`,
		`{"verified":true,"incarnation":"` + strings.Repeat("z", 64) + `","readOnly":true}`,
		`{"verified":true,"incarnation":"` + incarnation + `","readOnly":false}`,
		`{"verified":true,"readOnly":true}`,
	} {
		if got, ok := parseDesktopIncarnation(rejected); ok {
			t.Fatalf("expected %q to be rejected, got %q", rejected, got)
		}
	}
}

// TestDesktopTargetVerifyCommandKeepsKeyInsideSandbox 验证命令只能把 key 留在沙箱内：
// 脚本自己读 key、自己校验 HMAC，只输出 incarnation。
func TestDesktopTargetVerifyCommandKeepsKeyInsideSandbox(t *testing.T) {
	command := renderDesktopTargetVerifyCommand()

	for _, want := range []string{
		desktopTargetVerifyPath,
		// sudo 会重置 PATH，必须用绝对路径，且先确认它可执行。
		"test -x /usr/bin/python3",
		"/usr/bin/python3 -B " + desktopTargetVerifyPath,
		"install -o root -g root -m 0700",
		// 从未做过桌面准备的镜像上该目录不存在，mktemp 前必须先建。
		"install -d -o root -g root -m 0755 /usr/local/libexec/opencraft",
	} {
		if !strings.Contains(command, want) {
			t.Fatalf("verify command must contain %q:\n%s", want, command)
		}
	}
	for _, forbidden := range []string{
		// 不能把 key 或 MAC 回传/落盘到可读位置。
		"cat /run/opencraft-desktop-observer/key",
		"base64 /run/opencraft-desktop-observer/key",
		// 不能触碰 legacy 可写端点或只读 observer。
		"vela-x11vnc",
		"vela-desktop-observer",
		"vela-novnc",
		// 不能改动可写端点/ingressproxy。
		"vela-desktop-input",
		"websockify",
	} {
		if strings.Contains(command, forbidden) {
			t.Fatalf("verify command must not contain %q:\n%s", forbidden, command)
		}
	}
	// 脚本本体必须内嵌下发（沙箱内不依赖外部文件）。
	if !strings.Contains(command, "opencraft-desktop-observer/v1") {
		t.Fatalf("verify command must embed the verifier source:\n%s", command)
	}
}
