package cli

import (
	"bytes"
	"strings"
	"testing"
)

func TestIMAccountReportCountsAndFlagsDrift(t *testing.T) {
	records := []imAccountRecord{
		{Kind: "bot", UserID: "a_ready", State: "ready", Expected: expectation("bot", "ready"), Tencent: "imported"},
		{Kind: "bot", UserID: "a_gone", State: "deleted", Expected: expectation("bot", "deleted"), Tencent: "imported"},
		{Kind: "human", UserID: "u_ready", State: "ready", Expected: expectation("human", "ready"), Tencent: "missing"},
		{Kind: "human", UserID: "u_new", State: "provisioning", Expected: expectation("human", "provisioning"), Tencent: "missing"},
	}
	var output bytes.Buffer
	writeIMAccountReport(&output, records, true, false)
	text := output.String()
	for _, want := range []string{"平台记录 4 个账号，腾讯侧存在 2 个，与预期不符 2 个", "a_gone", "u_ready"} {
		if !strings.Contains(text, want) {
			t.Fatalf("report missing %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "a_ready") || strings.Contains(text, "u_new") {
		t.Fatalf("report lists accounts that match expectations without --list:\n%s", text)
	}

	output.Reset()
	writeIMAccountReport(&output, records, false, false)
	if !strings.Contains(output.String(), "平台记录 4 个账号，预计占用腾讯账号 3 个") {
		t.Fatalf("unchecked report:\n%s", output.String())
	}
}
