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
	importSuccess := importSuccessEmailTemplateData{
		AgentLabel: "我的 Agent",
	}
	failure := exportFailureEmailTemplateData{
		AgentLabel:  "我的 Agent",
		RemotePaths: "/home/agentuser/.hermes",
		Reason:      "磁盘快照正在创建，请稍后重试。",
	}
	importFailure := importFailureEmailTemplateData{
		AgentLabel: "我的 Agent",
		Reason:     "目标 Agent 的 Hermes 运行环境不可用，请稍后重试。",
	}
	cases := []struct {
		name     string
		rendered string
		contains string
	}{
		{name: "success subject", rendered: renderRescueTextTemplate("export_success.subject", success), contains: "我的 Agent"},
		{name: "success html", rendered: renderRescueHTMLTemplate("export_success.html", success), contains: "https://example.com/download"},
		{name: "success text", rendered: renderRescueTextTemplate("export_success.txt", success), contains: "8 小时"},
		{name: "import success subject", rendered: renderRescueTextTemplate("import_success.subject", importSuccess), contains: "我的 Agent"},
		{name: "import success html", rendered: renderRescueHTMLTemplate("import_success.html", importSuccess), contains: "工作区已完成恢复"},
		{name: "import success text", rendered: renderRescueTextTemplate("import_success.txt", importSuccess), contains: "导入已完成"},
		{name: "failure subject", rendered: renderRescueTextTemplate("export_failure.subject", failure), contains: "我的 Agent"},
		{name: "failure html", rendered: renderRescueHTMLTemplate("export_failure.html", failure), contains: "/home/agentuser/.hermes"},
		{name: "failure text", rendered: renderRescueTextTemplate("export_failure.txt", failure), contains: "磁盘快照正在创建"},
		{name: "import failure subject", rendered: renderRescueTextTemplate("import_failure.subject", importFailure), contains: "我的 Agent"},
		{name: "import failure html", rendered: renderRescueHTMLTemplate("import_failure.html", importFailure), contains: "Hermes 运行环境不可用"},
		{name: "import failure text", rendered: renderRescueTextTemplate("import_failure.txt", importFailure), contains: "导入不会继续覆盖"},
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
