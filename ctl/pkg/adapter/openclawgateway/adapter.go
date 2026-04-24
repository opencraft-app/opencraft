package openclawgateway

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"
	"golang.org/x/net/websocket"
)

type Adapter interface {
	Call(ctx context.Context, gatewayURL, gatewayToken, method string, params interface{}, out interface{}) error
}

type AdapterConfig struct {
	Timeout time.Duration
}

type OpenClawGatewayAdapter struct {
	timeout time.Duration
	logger  *zap.Logger
}

type eventFrame struct {
	Type    string          `json:"type"`
	Event   string          `json:"event,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type responseFrame struct {
	Type    string          `json:"type"`
	ID      string          `json:"id"`
	OK      bool            `json:"ok"`
	Payload json.RawMessage `json:"payload,omitempty"`
	Error   *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type requestFrame struct {
	Type   string      `json:"type"`
	ID     string      `json:"id"`
	Method string      `json:"method"`
	Params interface{} `json:"params,omitempty"`
}

type connectParams struct {
	MinProtocol int `json:"minProtocol"`
	MaxProtocol int `json:"maxProtocol"`
	Client      struct {
		ID       string `json:"id"`
		Version  string `json:"version"`
		Platform string `json:"platform"`
		Mode     string `json:"mode"`
	} `json:"client"`
	Role   string   `json:"role"`
	Scopes []string `json:"scopes"`
	Auth   struct {
		Token string `json:"token,omitempty"`
	} `json:"auth"`
}

const gatewayProtocolVersion = 3

func NewAdapter(conf *AdapterConfig, logger *zap.Logger) *OpenClawGatewayAdapter {
	timeout := 10 * time.Second
	if conf != nil && conf.Timeout > 0 {
		timeout = conf.Timeout
	}
	if logger == nil {
		logger = zap.NewNop()
	}
	return &OpenClawGatewayAdapter{
		timeout: timeout,
		logger:  logger.With(zap.String("component", "openclawgateway-adapter")),
	}
}

func (a *OpenClawGatewayAdapter) Call(ctx context.Context, gatewayURL, gatewayToken, method string, params interface{}, out interface{}) error {
	gatewayURL = strings.TrimSpace(gatewayURL)
	gatewayToken = strings.TrimSpace(gatewayToken)
	method = strings.TrimSpace(method)
	if gatewayURL == "" {
		return fmt.Errorf("gateway url is required")
	}
	if gatewayToken == "" {
		return fmt.Errorf("gateway token is required")
	}
	if method == "" {
		return fmt.Errorf("gateway method is required")
	}
	deadline := a.timeout
	if dl, ok := ctx.Deadline(); ok {
		if remaining := time.Until(dl); remaining > 0 && remaining < deadline {
			deadline = remaining
		}
	}
	origin := gatewayOriginFor(gatewayURL)
	config, err := websocket.NewConfig(gatewayURL, origin)
	if err != nil {
		return fmt.Errorf("build websocket config: %w", err)
	}
	config.Header = http.Header{}

	ws, err := websocket.DialConfig(config)
	if err != nil {
		return fmt.Errorf("dial gateway websocket: %w", err)
	}
	defer ws.Close()
	_ = ws.SetDeadline(time.Now().Add(deadline))

	if _, err := readConnectChallenge(ws); err != nil {
		return err
	}
	if err := sendConnect(ws, gatewayToken); err != nil {
		return err
	}
	if err := readConnectResult(ws); err != nil {
		return err
	}
	requestID, err := sendRequest(ws, method, params)
	if err != nil {
		return err
	}
	return readMethodResult(ws, requestID, out)
}

func gatewayOriginFor(gatewayURL string) string {
	if strings.HasPrefix(gatewayURL, "wss://") {
		return "https://" + strings.TrimPrefix(gatewayURL, "wss://")
	}
	if strings.HasPrefix(gatewayURL, "ws://") {
		return "http://" + strings.TrimPrefix(gatewayURL, "ws://")
	}
	return "http://127.0.0.1"
}

func readConnectChallenge(ws *websocket.Conn) (string, error) {
	for {
		var raw json.RawMessage
		if err := websocket.JSON.Receive(ws, &raw); err != nil {
			return "", fmt.Errorf("receive connect challenge: %w", err)
		}
		var evt eventFrame
		if err := json.Unmarshal(raw, &evt); err != nil {
			continue
		}
		if evt.Type != "event" || evt.Event != "connect.challenge" {
			continue
		}
		var payload struct {
			Nonce string `json:"nonce"`
		}
		if err := json.Unmarshal(evt.Payload, &payload); err != nil {
			return "", fmt.Errorf("decode connect challenge: %w", err)
		}
		if strings.TrimSpace(payload.Nonce) == "" {
			return "", fmt.Errorf("gateway connect challenge missing nonce")
		}
		return payload.Nonce, nil
	}
}

func sendConnect(ws *websocket.Conn, gatewayToken string) error {
	params := connectParams{
		// OpenClaw gateway is currently on protocol v3. Using the current
		// version avoids a successful unit-test-only handshake that would fail
		// immediately against a live gateway.
		MinProtocol: gatewayProtocolVersion,
		MaxProtocol: gatewayProtocolVersion,
		Role:        "operator",
		Scopes:      []string{"operator.admin"},
	}
	params.Client.ID = "gateway-client"
	params.Client.Version = "ctl"
	params.Client.Platform = "linux"
	params.Client.Mode = "backend"
	params.Auth.Token = gatewayToken

	return websocket.JSON.Send(ws, requestFrame{
		Type:   "req",
		ID:     "connect",
		Method: "connect",
		Params: params,
	})
}

func readConnectResult(ws *websocket.Conn) error {
	for {
		var raw json.RawMessage
		if err := websocket.JSON.Receive(ws, &raw); err != nil {
			return fmt.Errorf("receive connect result: %w", err)
		}
		var res responseFrame
		if err := json.Unmarshal(raw, &res); err != nil {
			continue
		}
		if res.Type != "res" || res.ID != "connect" {
			continue
		}
		if !res.OK {
			if res.Error != nil && res.Error.Message != "" {
				return fmt.Errorf("gateway connect failed: %s", res.Error.Message)
			}
			return fmt.Errorf("gateway connect failed")
		}
		return nil
	}
}

func sendRequest(ws *websocket.Conn, method string, params interface{}) (string, error) {
	requestID := uuid.NewString()
	return requestID, websocket.JSON.Send(ws, requestFrame{
		Type:   "req",
		ID:     requestID,
		Method: method,
		Params: params,
	})
}

func readMethodResult(ws *websocket.Conn, requestID string, out interface{}) error {
	for {
		var raw json.RawMessage
		if err := websocket.JSON.Receive(ws, &raw); err != nil {
			return fmt.Errorf("receive gateway response: %w", err)
		}
		var res responseFrame
		if err := json.Unmarshal(raw, &res); err != nil {
			continue
		}
		if res.Type != "res" || res.ID != requestID {
			continue
		}
		if !res.OK {
			if res.Error != nil && res.Error.Message != "" {
				return fmt.Errorf("gateway %s", res.Error.Message)
			}
			return fmt.Errorf("gateway request failed")
		}
		if out == nil || len(res.Payload) == 0 {
			return nil
		}
		if err := json.Unmarshal(res.Payload, out); err != nil {
			return fmt.Errorf("decode gateway payload: %w", err)
		}
		return nil
	}
}
