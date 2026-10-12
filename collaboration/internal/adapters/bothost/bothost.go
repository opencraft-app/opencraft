// Package bothost 把 Bot 凭据交付到 Bot 所在的 LightVela 实例。
//
// 生产使用 CTL 内部接口（经 TAT 写入 Hermes Profile）；开发机可以使用本地命令。
// 两种实现收发同一份 JSON 契约，凭据只出现在请求体中，不进入命令参数或日志。
package bothost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"strings"
	"time"

	botimport "git.woa.com/wisp/mono2/collaboration/internal/ports/botim"
)

const maxResponseBytes = 64 << 10

type request struct {
	Action         string `json:"action"`
	AccountSubject string `json:"accountSubject,omitempty"`
	InstanceID     string `json:"instanceId"`
	BotID          string `json:"botId"`
	DisplayName    string `json:"displayName,omitempty"`
	BotAgentID     string `json:"botAgentId,omitempty"`
	IMUserID       string `json:"imUserId,omitempty"`
	SDKAppID       int    `json:"sdkAppId,omitempty"`
	APIBaseURL     string `json:"apiBaseUrl,omitempty"`
	Credential     string `json:"credential,omitempty"`
}

type response struct {
	Owned       *bool  `json:"owned,omitempty"`
	DisplayName string `json:"displayName,omitempty"`
	Error       string `json:"error,omitempty"`
}

func verifyRequest(input botimport.HostRequest) request {
	return request{
		Action: "verify", AccountSubject: input.AccountSubject, InstanceID: input.InstanceID,
		BotID: input.BotID, DisplayName: input.DisplayName,
	}
}

func deliverRequest(input botimport.Delivery) request {
	return request{
		Action: "deliver", AccountSubject: input.AccountSubject, InstanceID: input.InstanceID,
		BotID: input.BotID, DisplayName: input.DisplayName, BotAgentID: input.BotAgentID,
		IMUserID: input.IMUserID, SDKAppID: input.SDKAppID, APIBaseURL: input.APIBaseURL,
		Credential: input.Credential.Reveal(),
	}
}

func revokeRequest(input botimport.HostRequest) request {
	return request{
		Action: "revoke", AccountSubject: input.AccountSubject, InstanceID: input.InstanceID,
		BotID: input.BotID,
	}
}

func verification(result response) (botimport.HostVerification, error) {
	if result.Owned == nil || !*result.Owned {
		return botimport.HostVerification{}, botimport.ErrBotNotOwned
	}
	return botimport.HostVerification{DisplayName: strings.TrimSpace(result.DisplayName)}, nil
}

// CommandHost 执行本机命令，请求 JSON 写入 stdin，结果 JSON 从 stdout 读取。
type CommandHost struct {
	path    string
	timeout time.Duration
}

func NewCommandHost(path string, timeout time.Duration) (*CommandHost, error) {
	if strings.TrimSpace(path) == "" || timeout <= 0 {
		return nil, errors.New("Bot 宿主命令配置无效")
	}
	return &CommandHost{path: path, timeout: timeout}, nil
}

func (host *CommandHost) Verify(ctx context.Context, input botimport.HostRequest) (botimport.HostVerification, error) {
	result, err := host.run(ctx, verifyRequest(input))
	if err != nil {
		return botimport.HostVerification{}, err
	}
	return verification(result)
}

func (host *CommandHost) Deliver(ctx context.Context, input botimport.Delivery) error {
	_, err := host.run(ctx, deliverRequest(input))
	return err
}

func (host *CommandHost) Revoke(ctx context.Context, input botimport.HostRequest) error {
	_, err := host.run(ctx, revokeRequest(input))
	return err
}

func (host *CommandHost) run(ctx context.Context, payload request) (response, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return response{}, err
	}
	commandContext, cancel := context.WithTimeout(ctx, host.timeout)
	defer cancel()
	command := exec.CommandContext(commandContext, host.path)
	command.Stdin = bytes.NewReader(encoded)
	var stdout, stderr bytes.Buffer
	command.Stdout = &limitedWriter{buffer: &stdout, limit: maxResponseBytes}
	command.Stderr = &limitedWriter{buffer: &stderr, limit: 4 << 10}
	if err := command.Run(); err != nil {
		return response{}, fmt.Errorf("Bot 宿主命令 %s 失败: %w: %s", payload.Action, err, firstLine(stderr.String()))
	}
	var result response
	if stdout.Len() > 0 {
		if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
			return response{}, fmt.Errorf("Bot 宿主命令 %s 输出无效: %w", payload.Action, err)
		}
	}
	if result.Error != "" {
		return response{}, fmt.Errorf("Bot 宿主命令 %s 失败: %s", payload.Action, firstLine(result.Error))
	}
	return result, nil
}

// CTLHost 调用 CTL 内部接口；CTL 校验实例归属并经 TAT 写入 Hermes Profile。
type CTLHost struct {
	base   *url.URL
	token  string
	client *http.Client
}

func NewCTLHost(baseURL string, token string, client *http.Client) (*CTLHost, error) {
	base, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || base.Host == "" || (base.Scheme != "https" && base.Scheme != "http") ||
		len(strings.TrimSpace(token)) < 20 || client == nil {
		return nil, errors.New("CTL Bot 宿主配置无效")
	}
	base.Path = strings.TrimRight(base.Path, "/")
	copied := *client
	copied.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &CTLHost{base: base, token: strings.TrimSpace(token), client: &copied}, nil
}

func (host *CTLHost) Verify(ctx context.Context, input botimport.HostRequest) (botimport.HostVerification, error) {
	result, err := host.post(ctx, "bots:verify", verifyRequest(input))
	if err != nil {
		return botimport.HostVerification{}, err
	}
	return verification(result)
}

func (host *CTLHost) Deliver(ctx context.Context, input botimport.Delivery) error {
	_, err := host.post(ctx, "bots:deliver", deliverRequest(input))
	return err
}

func (host *CTLHost) Revoke(ctx context.Context, input botimport.HostRequest) error {
	_, err := host.post(ctx, "bots:revoke", revokeRequest(input))
	return err
}

func (host *CTLHost) post(ctx context.Context, action string, payload request) (response, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return response{}, err
	}
	endpoint := *host.base
	endpoint.Path += "/internal/vela-im/" + action
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(encoded))
	if err != nil {
		return response{}, err
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	httpRequest.Header.Set("Accept", "application/json")
	httpRequest.Header.Set("Authorization", "Bearer "+host.token)
	httpResponse, err := host.client.Do(httpRequest)
	if err != nil {
		return response{}, fmt.Errorf("CTL %s 请求失败: %w", action, err)
	}
	defer httpResponse.Body.Close()
	body, err := io.ReadAll(io.LimitReader(httpResponse.Body, maxResponseBytes))
	if err != nil {
		return response{}, err
	}
	if httpResponse.StatusCode == http.StatusForbidden || httpResponse.StatusCode == http.StatusNotFound {
		return response{}, botimport.ErrBotNotOwned
	}
	if httpResponse.StatusCode < 200 || httpResponse.StatusCode >= 300 {
		return response{}, fmt.Errorf("CTL %s 返回 HTTP %d", action, httpResponse.StatusCode)
	}
	var result response
	if len(body) > 0 {
		if err := json.Unmarshal(body, &result); err != nil {
			return response{}, fmt.Errorf("CTL %s 响应无效: %w", action, err)
		}
	}
	return result, nil
}

type limitedWriter struct {
	buffer *bytes.Buffer
	limit  int
}

func (writer *limitedWriter) Write(data []byte) (int, error) {
	remaining := writer.limit - writer.buffer.Len()
	if remaining > 0 {
		if len(data) > remaining {
			writer.buffer.Write(data[:remaining])
		} else {
			writer.buffer.Write(data)
		}
	}
	return len(data), nil
}

func firstLine(value string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(value), "\n")
	if len(line) > 200 {
		return line[:200]
	}
	return line
}

var (
	_ botimport.Host = (*CommandHost)(nil)
	_ botimport.Host = (*CTLHost)(nil)
)
