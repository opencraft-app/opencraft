package rescue

import (
	"strings"
	"testing"
)

func TestRescueEmailTemplatesRender(t *testing.T) {
	success := exportSuccessEmailTemplateData{
		AgentLabel:  "我的 Agent",
		DownloadURL: "https://example.com/download",
		TTLLabel:    "8 小时",
	}
	failure := exportFailureEmailTemplateData{
		AgentLabel:  "我的 Agent",
		RemotePaths: "/home/agentuser/.hermes",
		Reason:      "磁盘快照正在创建，请稍后重试。",
	}
	cases := []struct {
		name     string
		rendered string
		contains string
	}{
		{name: "success subject", rendered: renderRescueTextTemplate("export_success.subject", success), contains: "我的 Agent"},
		{name: "success html", rendered: renderRescueHTMLTemplate("export_success.html", success), contains: "https://example.com/download"},
		{name: "success text", rendered: renderRescueTextTemplate("export_success.txt", success), contains: "8 小时"},
		{name: "failure subject", rendered: renderRescueTextTemplate("export_failure.subject", failure), contains: "我的 Agent"},
		{name: "failure html", rendered: renderRescueHTMLTemplate("export_failure.html", failure), contains: "/home/agentuser/.hermes"},
		{name: "failure text", rendered: renderRescueTextTemplate("export_failure.txt", failure), contains: "磁盘快照正在创建"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if strings.Contains(tc.rendered, "template") && strings.Contains(tc.rendered, "render failed") {
				t.Fatalf("template failed to render: %s", tc.rendered)
			}
			if !strings.Contains(tc.rendered, tc.contains) {
				t.Fatalf("rendered template missing %q: %s", tc.contains, tc.rendered)
			}
		})
	}
}
