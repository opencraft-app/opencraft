package wrapper

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"
	"time"
)

const defaultAGSEnvdPort = 49983

type AGSClientConfig struct {
	Domain         string
	APIURL         string
	APIKey         string
	HTTPClient     *http.Client
	EnvdPort       int
	EnvdUser       string
	RequestTimeout time.Duration
}

type AGSClient struct {
	domain         string
	apiURL         string
	apiKey         string
	httpClient     *http.Client
	envdPort       int
	envdUser       string
	requestTimeout time.Duration
}

type AGSSandbox struct {
	TemplateID         string
	SandboxID          string
	EnvdVersion        string
	Alias              string
	EnvdAccessToken    string
	TrafficAccessToken string
	Domain             string
}

type CreateSandboxOptions struct {
	TemplateID          string
	TimeoutSeconds      int
	Secure              bool
	AllowInternetAccess bool
	Metadata            map[string]string
	EnvVars             map[string]string
}

type CommandResult struct {
	Stdout   string
	Stderr   string
	ExitCode int
	Exited   bool
	Status   string
}

func NewAGSClient(cfg AGSClientConfig) (*AGSClient, error) {
	domain := strings.TrimSpace(cfg.Domain)
	if domain == "" {
		domain = strings.TrimSpace(os.Getenv("E2B_DOMAIN"))
	}
	if domain == "" {
		domain = "ap-beijing.tencentags.com"
	}
	apiURL := strings.TrimRight(strings.TrimSpace(cfg.APIURL), "/")
	if apiURL == "" {
		apiURL = strings.TrimRight(strings.TrimSpace(os.Getenv("E2B_API_URL")), "/")
	}
	if apiURL == "" {
		apiURL = "https://api." + domain
	}
	apiKey := strings.TrimSpace(cfg.APIKey)
	if apiKey == "" {
		apiKey = strings.TrimSpace(os.Getenv("E2B_API_KEY"))
	}
	if apiKey == "" {
		return nil, errors.New("E2B_API_KEY is required")
	}
	envdPort := cfg.EnvdPort
	if envdPort == 0 {
		envdPort = defaultAGSEnvdPort
	}
	timeout := cfg.RequestTimeout
	if timeout == 0 {
		timeout = envDurationSeconds("GATEWAY_AGS_REQUEST_TIMEOUT_SECONDS", 60*time.Second)
	}
	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: timeout}
	}
	envdUser := cfg.EnvdUser
	if envdUser == "" {
		envdUser = "user"
	}
	return &AGSClient{
		domain:         domain,
		apiURL:         apiURL,
		apiKey:         apiKey,
		httpClient:     httpClient,
		envdPort:       envdPort,
		envdUser:       envdUser,
		requestTimeout: timeout,
	}, nil
}

func (c *AGSClient) CreateSandbox(ctx context.Context, opts CreateSandboxOptions) (AGSSandbox, error) {
	if opts.TemplateID == "" {
		return AGSSandbox{}, errors.New("template id is required")
	}
	timeout := opts.TimeoutSeconds
	if timeout == 0 {
		timeout = 300
	}
	body := map[string]any{
		"templateID":            opts.TemplateID,
		"timeout":               timeout,
		"autoPause":             false,
		"secure":                opts.Secure,
		"allow_internet_access": opts.AllowInternetAccess,
	}
	if opts.Metadata != nil {
		body["metadata"] = opts.Metadata
	}
	if opts.EnvVars != nil {
		body["envVars"] = opts.EnvVars
	}
	var out AGSSandbox
	op := fmt.Sprintf("create_sandbox template_id=%s domain=%s api_url=%s", opts.TemplateID, c.domain, c.apiURL)
	if err := c.doJSON(ctx, http.MethodPost, c.apiURL+"/sandboxes", body, &out, op); err != nil {
		return AGSSandbox{}, err
	}
	if out.SandboxID == "" {
		return AGSSandbox{}, errors.New("create sandbox response missing sandboxID")
	}
	if out.Domain == "" {
		out.Domain = c.domain
	}
	return out, nil
}

func (c *AGSClient) DeleteSandbox(ctx context.Context, sandboxID string) error {
	if sandboxID == "" {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, c.apiURL+"/sandboxes/"+url.PathEscape(sandboxID), nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-API-Key", c.apiKey)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusNotFound {
		return nil
	}
	err = decodeHTTPError(resp, fmt.Sprintf("delete_sandbox sandbox_id=%s domain=%s api_url=%s", sandboxID, c.domain, c.apiURL))
	if isIdempotentDeleteSandboxError(err) {
		return nil
	}
	return err
}

func isIdempotentDeleteSandboxError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "requested resource does not exist") {
		return true
	}
	return strings.Contains(message, "unsupportedoperation.sandboxinstance") &&
		strings.Contains(message, "stopped state")
}

func (c *AGSClient) RunCommand(ctx context.Context, sb AGSSandbox, command string, env map[string]string, onStdout func(string) error, onStderr func(string) error) (CommandResult, error) {
	if command == "" {
		return CommandResult{}, errors.New("command is required")
	}
	body := map[string]any{
		"process": map[string]any{
			"cmd":  "/bin/bash",
			"args": []string{"-l", "-c", command},
			"envs": env,
		},
		"stdin": false,
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return CommandResult{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.sandboxURL(sb)+"/process.Process/Start", bytes.NewReader(connectEnvelope(raw, 0)))
	if err != nil {
		return CommandResult{}, err
	}
	req.Header.Set("Content-Type", "application/connect+json")
	req.Header.Set("Connect-Protocol-Version", "1")
	req.Header.Set("Connect-Content-Encoding", "identity")
	req.Header.Set("Connect-Timeout-Ms", strconv.FormatInt(int64(c.requestTimeout/time.Millisecond), 10))
	if sb.EnvdAccessToken != "" {
		req.Header.Set("X-Access-Token", sb.EnvdAccessToken)
	}
	if c.envdUser != "" {
		req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(c.envdUser+":")))
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return CommandResult{}, fmt.Errorf("ags run_command transport sandbox_id=%s domain=%s: %w", sb.SandboxID, sandboxDomain(sb, c.domain), err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return CommandResult{}, decodeHTTPError(resp, fmt.Sprintf("run_command sandbox_id=%s domain=%s envd_port=%d", sb.SandboxID, sandboxDomain(sb, c.domain), c.envdPort))
	}
	return readConnectCommandStream(resp.Body, onStdout, onStderr)
}

func (c *AGSClient) UploadFile(ctx context.Context, sb AGSSandbox, remotePath, filename string, content []byte) error {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		return err
	}
	if _, err := part.Write(content); err != nil {
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	endpoint := c.fileURL(sb, remotePath)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, &body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	if sb.EnvdAccessToken != "" {
		req.Header.Set("X-Access-Token", sb.EnvdAccessToken)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("ags upload_file transport sandbox_id=%s domain=%s remote_path=%s: %w", sb.SandboxID, sandboxDomain(sb, c.domain), remotePath, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return decodeHTTPError(resp, fmt.Sprintf("upload_file sandbox_id=%s domain=%s remote_path=%s", sb.SandboxID, sandboxDomain(sb, c.domain), remotePath))
	}
	return nil
}

func (c *AGSClient) DownloadFile(ctx context.Context, sb AGSSandbox, remotePath string) ([]byte, error) {
	endpoint := c.fileURL(sb, remotePath)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	if sb.EnvdAccessToken != "" {
		req.Header.Set("X-Access-Token", sb.EnvdAccessToken)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("ags download_file transport sandbox_id=%s domain=%s remote_path=%s: %w", sb.SandboxID, sandboxDomain(sb, c.domain), remotePath, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, decodeHTTPError(resp, fmt.Sprintf("download_file sandbox_id=%s domain=%s remote_path=%s", sb.SandboxID, sandboxDomain(sb, c.domain), remotePath))
	}
	return io.ReadAll(resp.Body)
}

func (c *AGSClient) sandboxURL(sb AGSSandbox) string {
	return fmt.Sprintf("https://%d-%s.%s", c.envdPort, sb.SandboxID, sandboxDomain(sb, c.domain))
}

func (c *AGSClient) fileURL(sb AGSSandbox, remotePath string) string {
	values := url.Values{}
	values.Set("path", remotePath)
	if c.envdUser != "" {
		values.Set("username", c.envdUser)
	}
	return c.sandboxURL(sb) + "/files?" + values.Encode()
}

func (c *AGSClient) doJSON(ctx context.Context, method, endpoint string, body any, out any, op string) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", c.apiKey)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("ags %s transport: %w", op, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return decodeHTTPError(resp, op)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func sandboxDomain(sb AGSSandbox, fallback string) string {
	if sb.Domain != "" {
		return sb.Domain
	}
	return fallback
}

func connectEnvelope(data []byte, flags byte) []byte {
	var out bytes.Buffer
	_ = out.WriteByte(flags)
	_ = binary.Write(&out, binary.BigEndian, uint32(len(data)))
	_, _ = out.Write(data)
	return out.Bytes()
}

func readConnectCommandStream(r io.Reader, onStdout func(string) error, onStderr func(string) error) (CommandResult, error) {
	reader := bufio.NewReader(r)
	var result CommandResult
	for {
		header := make([]byte, 5)
		if _, err := io.ReadFull(reader, header); err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				return result, nil
			}
			return result, err
		}
		flags := header[0]
		size := binary.BigEndian.Uint32(header[1:])
		payload := make([]byte, size)
		if _, err := io.ReadFull(reader, payload); err != nil {
			return result, err
		}
		if flags&0b00000010 != 0 {
			var terminal struct {
				Error *struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if err := json.Unmarshal(payload, &terminal); err == nil && terminal.Error != nil {
				return result, fmt.Errorf("%s: %s", terminal.Error.Code, terminal.Error.Message)
			}
			return result, nil
		}
		var msg struct {
			Event struct {
				Start *struct {
					PID int `json:"pid"`
				} `json:"start"`
				Data *struct {
					Stdout string `json:"stdout"`
					Stderr string `json:"stderr"`
					PTY    string `json:"pty"`
				} `json:"data"`
				End *struct {
					ExitCode int    `json:"exitCode"`
					Exited   bool   `json:"exited"`
					Status   string `json:"status"`
					Error    string `json:"error"`
				} `json:"end"`
			} `json:"event"`
		}
		if err := json.Unmarshal(payload, &msg); err != nil {
			return result, err
		}
		if msg.Event.Data != nil {
			if msg.Event.Data.Stdout != "" {
				text, err := decodeConnectBytes(msg.Event.Data.Stdout)
				if err != nil {
					return result, err
				}
				result.Stdout += text
				if onStdout != nil {
					if err := onStdout(text); err != nil {
						return result, err
					}
				}
			}
			if msg.Event.Data.Stderr != "" {
				text, err := decodeConnectBytes(msg.Event.Data.Stderr)
				if err != nil {
					return result, err
				}
				result.Stderr += text
				if onStderr != nil {
					if err := onStderr(text); err != nil {
						return result, err
					}
				}
			}
		}
		if msg.Event.End != nil {
			result.ExitCode = msg.Event.End.ExitCode
			result.Exited = msg.Event.End.Exited
			result.Status = msg.Event.End.Status
			if msg.Event.End.Error != "" {
				return result, errors.New(msg.Event.End.Error)
			}
			if msg.Event.End.Exited && msg.Event.End.ExitCode != 0 {
				return result, fmt.Errorf("process exited with code %d: %s", msg.Event.End.ExitCode, result.Stderr)
			}
		}
	}
}

func decodeConnectBytes(encoded string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func decodeHTTPError(resp *http.Response, op string) error {
	raw, _ := io.ReadAll(resp.Body)
	var payload struct {
		Code    any    `json:"code"`
		Message string `json:"message"`
		Error   any    `json:"error"`
	}
	_ = json.Unmarshal(raw, &payload)
	message := payload.Message
	if message == "" && payload.Error != nil {
		message = fmt.Sprint(payload.Error)
	}
	if message == "" {
		message = strings.TrimSpace(string(raw))
	}
	if message == "" {
		message = resp.Status
	}
	if payload.Code != nil {
		code := strings.TrimSpace(fmt.Sprint(payload.Code))
		if code != "" && !strings.Contains(message, code) {
			message = code + ": " + message
		}
	}
	op = strings.TrimSpace(op)
	if op == "" {
		op = "unknown"
	}
	fmt.Fprintf(os.Stderr, "timeline source=ags_client event=ags_http_error status=%d op=%s message=%s\n", resp.StatusCode, quoteServerField(op), quoteServerField(message))
	return fmt.Errorf("ags http %d op=%s: %s", resp.StatusCode, op, message)
}

func artifactChecksum(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

func sanitizeRemoteName(name string) string {
	base := path.Base(name)
	base = strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-' {
			return r
		}
		return '_'
	}, base)
	if base == "." || base == "/" || base == "" {
		return "input"
	}
	return base
}
