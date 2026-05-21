package service

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"log"
	"os/exec"
	"strings"
	"time"
)

// AgentModel 对应 cursor-agent --list-models 的一行。
type AgentModel struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	IsDefault bool   `json:"isDefault,omitempty"`
}

// ListAgentModels 运行 cursor-agent --list-models 并解析输出。
func ListAgentModels() ([]AgentModel, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "cursor-agent", "--list-models")
	out, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("acp-client: cursor-agent --list-models 失败: %v (output=%d bytes)", err, len(out))
		if len(out) > 0 {
			models := parseListModels(out)
			if len(models) > 0 {
				return models, nil
			}
		}
		return nil, fmt.Errorf("cursor-agent --list-models: %w", err)
	}
	models := parseListModels(out)
	log.Printf("acp-client: cursor-agent --list-models 解析到 %d 个模型", len(models))
	return models, nil
}

func parseListModels(data []byte) []AgentModel {
	var models []AgentModel
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || !strings.Contains(line, " - ") {
			continue
		}
		parts := strings.SplitN(line, " - ", 2)
		id := strings.TrimSpace(parts[0])
		name := strings.TrimSpace(parts[1])
		if id == "" {
			continue
		}
		m := AgentModel{ID: id, Name: name}
		if strings.HasSuffix(name, "(default)") {
			m.IsDefault = true
			m.Name = strings.TrimSpace(strings.TrimSuffix(name, "(default)"))
		}
		models = append(models, m)
	}
	return models
}
