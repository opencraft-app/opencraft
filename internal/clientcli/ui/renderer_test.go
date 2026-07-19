package ui

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"git.woa.com/wisp/mono2/llmgateway/internal/client"
	clientscenario "git.woa.com/wisp/mono2/llmgateway/internal/clientcli/scenario"
)

func TestRendererProducesHumanAndMachineOutput(t *testing.T) {
	result := client.Result{StatusCode: 200, Data: json.RawMessage(`{"user_id":"user-1","backend":"new"}`), Request: client.RequestSummary{Lane: client.AuthInternal, Method: "GET", Path: "/assignment"}}

	var human bytes.Buffer
	if err := (Renderer{Writer: &human, Format: "table"}).Print("查询归属", result); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(human.String(), "完成：查询归属") || !strings.Contains(human.String(), "user-1") {
		t.Fatalf("human output=%q", human.String())
	}

	var machine bytes.Buffer
	if err := (Renderer{Writer: &machine, Format: "json"}).Print("查询归属", result); err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(machine.Bytes(), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["command"] != "查询归属" {
		t.Fatalf("json output=%s", machine.String())
	}
}

func TestRendererProducesReadableScenarioProgress(t *testing.T) {
	var output bytes.Buffer
	report := clientscenario.Report{
		Scenario: "onboard",
		Steps: []clientscenario.Step{
			{Name: "确保租户存在", Status: clientscenario.StepSucceeded, Result: client.Result{StatusCode: 200}},
			{Name: "应用订阅", Status: clientscenario.StepFailed, Error: "plan not found"},
		},
	}
	if err := (Renderer{Writer: &output, Format: "table"}).PrintScenario(report); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"场景：onboard", "[成功] 确保租户存在", "[失败] 应用订阅：plan not found"} {
		if !strings.Contains(output.String(), expected) {
			t.Fatalf("output %q does not contain %q", output.String(), expected)
		}
	}
}
