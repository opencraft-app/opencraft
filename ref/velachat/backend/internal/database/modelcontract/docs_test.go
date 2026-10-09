package modelcontract

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCurrentChineseSpecificationsDoNotReintroduceRetiredContracts(t *testing.T) {
	root := filepath.Join("..", "..", "..", "platform", "v1")
	current := []string{
		"02-领域模型.md", "03-状态机与事务.md", "04-数据库规格.md",
		"05-HTTP-API设计.md", "06-TAT执行面.md", "07-腾讯云IM适配.md", "08-内部任务契约.md",
		"09-权限与错误契约.md", "10-TDSQL分区与路由.md",
	}
	for _, name := range current {
		data, err := os.ReadFile(filepath.Join(root, name))
		if err != nil {
			t.Fatal(err)
		}
		text := string(data)
		for _, retired := range []string{
			"23 张", "23张", "25 张", "25张", "/runtime/session", "`If-Match`",
			"Computer 没有平台凭证", "Computer 不持有平台凭证", "Authorization: AgentCredential",
		} {
			if strings.Contains(text, retired) {
				t.Errorf("%s still contains retired contract %q", name, retired)
			}
		}
	}
}

func TestErrorContractMarkdownUsesMachineRegistryInsteadOfCopiedList(t *testing.T) {
	path := filepath.Join("..", "..", "..", "platform", "v1", "09-权限与错误契约.md")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if !strings.Contains(text, "error-registry-source: openapi.yaml#/x-error-code-registry") {
		t.Fatal("错误契约文档未声明机器 registry 权威")
	}
	if strings.Contains(text, "runtime_credential_invalid") || strings.Contains(text, "account_already_exists") {
		t.Fatal("错误契约文档重新复制了可漂移的错误码清单")
	}
}

func TestCurrentDatabaseDocsMatchMachineContractTableCount(t *testing.T) {
	for _, name := range []string{"README.md", "04-数据库规格.md", "10-TDSQL分区与路由.md"} {
		path := filepath.Join("..", "..", "..", "platform", "v1", name)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), "26 张") {
			t.Errorf("%s 未与 26 表机器契约同步", name)
		}
	}
}
