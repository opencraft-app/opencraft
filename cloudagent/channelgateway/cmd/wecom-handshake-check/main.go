package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

const defaultWeComWebSocketURL = "wss://openws.work.weixin.qq.com"

type frame struct {
	Cmd     string          `json:"cmd,omitempty"`
	Headers frameHeaders    `json:"headers,omitempty"`
	Body    json.RawMessage `json:"body,omitempty"`
	ErrCode int             `json:"errcode,omitempty"`
	ErrMsg  string          `json:"errmsg,omitempty"`
}

type frameHeaders struct {
	ReqID string `json:"req_id,omitempty"`
}

func main() {
	var url string
	var timeout time.Duration
	flag.StringVar(&url, "url", envAny([]string{"WECOM_WEBSOCKET_URL", "CODEBUDDY_WECOM_BOT_WS_URL"}, defaultWeComWebSocketURL), "WeCom AI Bot websocket URL")
	flag.DurationVar(&timeout, "timeout", 15*time.Second, "handshake timeout")
	flag.Parse()

	botID := strings.TrimSpace(os.Getenv("WECOM_BOT_ID"))
	secret := strings.TrimSpace(os.Getenv("WECOM_SECRET"))
	if botID == "" || secret == "" {
		exitJSON(2, map[string]any{
			"ok":    false,
			"error": "WECOM_BOT_ID and WECOM_SECRET are required",
		})
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	started := time.Now()
	conn, resp, err := websocket.DefaultDialer.DialContext(ctx, url, http.Header{})
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		exitJSON(1, map[string]any{
			"ok":              false,
			"phase":           "dial",
			"url":             url,
			"bot_id_redacted": redactMiddle(botID),
			"bot_id_len":      len(botID),
			"secret_len":      len(secret),
			"http_status":     status,
			"elapsed_ms":      elapsedMS(started),
			"error":           err.Error(),
		})
	}
	defer conn.Close()

	reqID := fmt.Sprintf("aibot_subscribe-%d", time.Now().UnixNano())
	payload := map[string]any{
		"cmd":     "aibot_subscribe",
		"headers": map[string]any{"req_id": reqID},
		"body":    map[string]any{"bot_id": botID, "secret": secret},
	}
	if err := conn.WriteJSON(payload); err != nil {
		exitJSON(1, map[string]any{
			"ok":              false,
			"phase":           "subscribe_write",
			"url":             url,
			"bot_id_redacted": redactMiddle(botID),
			"elapsed_ms":      elapsedMS(started),
			"error":           err.Error(),
		})
	}

	if err := conn.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		exitJSON(1, map[string]any{
			"ok":         false,
			"phase":      "set_read_deadline",
			"url":        url,
			"elapsed_ms": elapsedMS(started),
			"error":      err.Error(),
		})
	}
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			exitJSON(1, map[string]any{
				"ok":              false,
				"phase":           "subscribe_read",
				"url":             url,
				"bot_id_redacted": redactMiddle(botID),
				"elapsed_ms":      elapsedMS(started),
				"error":           err.Error(),
			})
		}
		var ack frame
		if err := json.Unmarshal(raw, &ack); err != nil {
			continue
		}
		if ack.Headers.ReqID != reqID {
			continue
		}
		result := map[string]any{
			"ok":              ack.ErrCode == 0,
			"phase":           "subscribe_ack",
			"url":             url,
			"bot_id_redacted": redactMiddle(botID),
			"bot_id_len":      len(botID),
			"secret_len":      len(secret),
			"req_id_prefix":   "aibot_subscribe",
			"elapsed_ms":      elapsedMS(started),
			"errcode":         ack.ErrCode,
			"errmsg":          ack.ErrMsg,
		}
		if ack.ErrCode != 0 {
			exitJSON(1, result)
		}
		exitJSON(0, result)
	}
}

func env(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func envAny(keys []string, fallback string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return fallback
}

func elapsedMS(started time.Time) int64 {
	return time.Since(started).Milliseconds()
}

func redactMiddle(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= 8 {
		return "<redacted>"
	}
	return value[:4] + "..." + value[len(value)-4:]
}

func exitJSON(code int, payload map[string]any) {
	encoded, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "{\"ok\":false,\"error\":\"%s\"}\n", err)
		os.Exit(1)
	}
	fmt.Println(string(encoded))
	os.Exit(code)
}
