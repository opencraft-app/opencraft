package ui

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"

	"git.woa.com/wisp/mono2/llmgateway/internal/client"
	clientscenario "git.woa.com/wisp/mono2/llmgateway/internal/clientcli/scenario"
)

type Renderer struct {
	Writer io.Writer
	Format string
}

func (r Renderer) Print(label string, result client.Result) error {
	if r.Writer == nil {
		return nil
	}
	if strings.EqualFold(strings.TrimSpace(r.Format), "json") {
		payload := struct {
			Command    string          `json:"command"`
			StatusCode int             `json:"status_code"`
			DryRun     bool            `json:"dry_run,omitempty"`
			Request    any             `json:"request"`
			Data       json.RawMessage `json:"data,omitempty"`
		}{Command: label, StatusCode: result.StatusCode, DryRun: result.DryRun, Request: result.Request, Data: result.Data}
		return writeJSON(r.Writer, payload)
	}
	if result.DryRun {
		_, err := fmt.Fprintf(r.Writer, "计划执行：%s\n  %s %s（%s 认证）\n", label, result.Request.Method, result.Request.Path, result.Request.Lane)
		return err
	}
	if _, err := fmt.Fprintf(r.Writer, "完成：%s（HTTP %d）\n", label, result.StatusCode); err != nil {
		return err
	}
	return writeHumanData(r.Writer, result.Data)
}

func (r Renderer) PrintScenario(report clientscenario.Report) error {
	if r.Writer == nil {
		return nil
	}
	if strings.EqualFold(strings.TrimSpace(r.Format), "json") {
		return writeJSON(r.Writer, report)
	}
	if _, err := fmt.Fprintf(r.Writer, "场景：%s\n", report.Scenario); err != nil {
		return err
	}
	for index, step := range report.Steps {
		status := "成功"
		if step.Status == clientscenario.StepFailed {
			status = "失败"
		}
		if _, err := fmt.Fprintf(r.Writer, "  %d. [%s] %s", index+1, status, step.Name); err != nil {
			return err
		}
		if step.Result.StatusCode > 0 {
			if _, err := fmt.Fprintf(r.Writer, "（HTTP %d）", step.Result.StatusCode); err != nil {
				return err
			}
		} else if step.Result.DryRun {
			if _, err := fmt.Fprint(r.Writer, "（仅计划）"); err != nil {
				return err
			}
		}
		if step.Error != "" {
			if _, err := fmt.Fprintf(r.Writer, "：%s", step.Error); err != nil {
				return err
			}
		}
		if _, err := fmt.Fprintln(r.Writer); err != nil {
			return err
		}
	}
	if report.APIKey != "" {
		_, err := fmt.Fprintf(r.Writer, "新模型 Key：%s\n", report.APIKey)
		return err
	}
	return nil
}

func writeHumanData(w io.Writer, raw []byte) error {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var object map[string]any
	if json.Unmarshal(raw, &object) == nil {
		keys := make([]string, 0, len(object))
		for key := range object {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			value := object[key]
			if nested, ok := value.(map[string]any); ok {
				nestedRaw, _ := json.Marshal(nested)
				value = string(nestedRaw)
			}
			if list, ok := value.([]any); ok {
				listRaw, _ := json.Marshal(list)
				value = string(listRaw)
			}
			if _, err := fmt.Fprintf(w, "  %-22s %v\n", key, value); err != nil {
				return err
			}
		}
		return nil
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		_, err := fmt.Fprintln(w, string(raw))
		return err
	}
	pretty, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(w, string(pretty))
	return err
}

func writeJSON(w io.Writer, value any) error {
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}
