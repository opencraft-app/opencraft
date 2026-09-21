package openapirelease

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func TestPinnedOASDiffAllowsAdditiveEndpointAndRejectsClosedResponseExpansion(t *testing.T) {
	_, current, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("无法定位 OpenAPI release 源码")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(current), "..", "..", ".."))
	base := `openapi: 3.0.3
info: {title: test, version: 1.0.0}
paths:
  /things:
    get:
      operationId: listThings
      security: [{HumanBearer: []}]
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                additionalProperties: false
                required: [id]
                properties:
                  id: {type: string}
components:
  securitySchemes:
    HumanBearer: {type: http, scheme: bearer}
`
	additive := replaceOnce(t, base, "components:\n", `  /health:
    get:
      operationId: health
      responses:
        '204': {description: ok}
components:
`)
	breaking := replaceOnce(t, base, "                  id: {type: string}\n", "                  id: {type: string}\n                  name: {type: string}\n")
	if output, err := runOASDiff(t, root, base, additive); err != nil {
		t.Fatalf("新增 endpoint 被误判为破坏性变更: %v\n%s", err, output)
	}
	if output, err := runOASDiff(t, root, base, breaking); err == nil {
		t.Fatalf("封闭响应增加字段未被拒绝:\n%s", output)
	}
}

func runOASDiff(t *testing.T, root, base, revision string) ([]byte, error) {
	t.Helper()
	directory := t.TempDir()
	basePath := filepath.Join(directory, "base.yaml")
	revisionPath := filepath.Join(directory, "revision.yaml")
	if err := os.WriteFile(basePath, []byte(base), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(revisionPath, []byte(revision), 0o600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(
		"go", "tool", "oasdiff", "breaking", basePath, revisionPath,
		"--severity-levels", filepath.Join(root, "platform/v1/oasdiff-levels.txt"),
		"--fail-on", "WARN", "--format", "text",
	)
	command.Dir = root
	return command.CombinedOutput()
}

func replaceOnce(t *testing.T, value, old, replacement string) string {
	t.Helper()
	for index := 0; index+len(old) <= len(value); index++ {
		if value[index:index+len(old)] == old {
			return value[:index] + replacement + value[index+len(old):]
		}
	}
	t.Fatalf("测试 fixture 缺少待替换文本 %q", old)
	return ""
}
