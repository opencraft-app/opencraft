package qqbot

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"acp-client/internal/correl"
	"acp-client/internal/service"

	"github.com/gorilla/websocket"
)

const (
	apiBase       = "https://api.sgroup.qq.com"
	tokenEndpoint = "https://bots.qq.com/app/getAppAccessToken"
	gatewayURL    = "https://api.sgroup.qq.com/gateway"

	intentGroupAndC2C = 1 << 25
	intentInteraction = 1 << 26

	opDispatch  = 0
	opHeartbeat = 1
	opIdentify  = 2
	opResume    = 6
	opHello     = 10
	opHeartbAck = 11
	opInvalidSe = 9
)

var qqMentionRE = regexp.MustCompile(`<@!?\d+>`)

type Service struct {
	bridge *service.Bridge
	store  *Store

	httpClient *http.Client

	mu      sync.Mutex
	cfg     Config
	pending map[string]*turn
	current *turn

	tokenMu sync.Mutex
	token   string
	tokenAt time.Time

	// WebSocket 状态
	wsMu      sync.Mutex
	wsConn    *websocket.Conn
	wsCancel  context.CancelFunc
	wsRunning bool
	wsState   string // "disconnected", "connecting", "connected"
	sessionID string
	lastSeq   int64
}

type turn struct {
	opID       string
	target     replyTarget
	buf        strings.Builder
	createdAt  time.Time
	finishedAt time.Time
}

type replyTarget struct {
	Kind        string
	OpenID      string
	GroupOpenID string
	MsgID       string
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	ExpiresInRaw any    `json:"expires_in"`
}

type wsPayload struct {
	Op int             `json:"op"`
	D  json.RawMessage `json:"d,omitempty"`
	S  int64           `json:"s,omitempty"`
	T  string          `json:"t,omitempty"`
}

type gatewayResponse struct {
	URL string `json:"url"`
}

type helloData struct {
	HeartbeatInterval int64 `json:"heartbeat_interval"`
}

type readyData struct {
	SessionID string `json:"session_id"`
}

func New(bridge *service.Bridge, store *Store) (*Service, error) {
	if bridge == nil {
		return nil, errors.New("qqbot: nil bridge")
	}
	cfg, err := store.Load()
	if err != nil {
		return nil, err
	}
	s := &Service{
		bridge: bridge,
		store:  store,
		cfg:    cfg,
		httpClient: &http.Client{
			Timeout: 15 * time.Second,
		},
		pending: make(map[string]*turn),
	}
	bridge.SubscribeEvents(s.handleBridgeEvent)
	return s, nil
}

func (s *Service) Config() Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg
}

func (s *Service) PublicConfig() PublicConfig {
	return s.Config().Public()
}

func (s *Service) PublicConfigWithStatus() PublicConfig {
	cfg := s.Config()
	pub := cfg.Public()
	switch {
	case !cfg.Enabled:
		pub.Status = "未启用"
	case cfg.AppID == "" || cfg.AppSecret == "":
		pub.Status = "配置不完整"
	default:
		s.wsMu.Lock()
		state := s.wsState
		s.wsMu.Unlock()
		switch state {
		case "connected":
			pub.Connected = true
			pub.Status = "已连接"
		case "connecting":
			pub.Status = "连接中…"
		default:
			pub.Status = "未连接"
		}
	}
	return pub
}

func (s *Service) UpdateConfig(next Config) error {
	current := s.Config()
	if strings.TrimSpace(next.AppSecret) == "" {
		next.AppSecret = current.AppSecret
	}
	next.normalize()
	if err := s.store.Save(next); err != nil {
		return err
	}
	s.mu.Lock()
	s.cfg = next
	s.mu.Unlock()
	s.invalidateToken()
	// 配置变更后重新连接 WebSocket
	s.Reconnect()
	return nil
}

func (s *Service) Enabled() bool {
	cfg := s.Config()
	return cfg.Enabled && cfg.AppID != "" && cfg.AppSecret != ""
}

// Start 启动 WebSocket 网关连接（非阻塞）
func (s *Service) Start() {
	if !s.Enabled() {
		log.Printf("qqbot: 未启用或配置不完整，跳过 WebSocket 连接")
		return
	}
	go s.runGateway()
}

// Stop 断开 WebSocket 连接
func (s *Service) Stop() {
	s.wsMu.Lock()
	if s.wsCancel != nil {
		s.wsCancel()
	}
	s.wsMu.Unlock()
}

// Reconnect 断开并重新连接（非阻塞）
func (s *Service) Reconnect() {
	s.Stop()
	if s.Enabled() {
		s.wsMu.Lock()
		s.wsState = "connecting"
		s.wsMu.Unlock()
		go func() {
			// 等旧连接退出
			time.Sleep(500 * time.Millisecond)
			s.runGateway()
		}()
	} else {
		s.wsMu.Lock()
		s.wsState = "disconnected"
		s.wsMu.Unlock()
	}
}

func (s *Service) runGateway() {
	s.wsMu.Lock()
	if s.wsRunning {
		s.wsMu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.wsCancel = cancel
	s.wsRunning = true
	s.wsState = "connecting"
	s.wsMu.Unlock()

	defer func() {
		s.wsMu.Lock()
		s.wsRunning = false
		s.wsState = "disconnected"
		s.wsConn = nil
		s.wsMu.Unlock()
	}()

	reconnectAttempts := 0
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		err := s.connectAndServe(ctx)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			log.Printf("qqbot: WebSocket 断开: %v", err)
		}

		s.wsMu.Lock()
		s.wsState = "connecting"
		s.wsMu.Unlock()

		reconnectAttempts++
		delay := reconnectDelay(reconnectAttempts)
		log.Printf("qqbot: %v 后重连 (第 %d 次)", delay, reconnectAttempts)

		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
	}
}

func reconnectDelay(attempt int) time.Duration {
	delays := []time.Duration{
		1 * time.Second,
		2 * time.Second,
		5 * time.Second,
		10 * time.Second,
		30 * time.Second,
		60 * time.Second,
	}
	idx := attempt - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(delays) {
		idx = len(delays) - 1
	}
	return delays[idx]
}

func (s *Service) connectAndServe(ctx context.Context) error {
	cfg := s.Config()
	token, err := s.accessToken(ctx, cfg)
	if err != nil {
		return fmt.Errorf("获取 token: %w", err)
	}

	gwURL, err := s.getGatewayURL(ctx, token)
	if err != nil {
		return fmt.Errorf("获取 gateway URL: %w", err)
	}

	log.Printf("qqbot: 连接 WebSocket %s", gwURL)

	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
	}
	conn, _, err := dialer.DialContext(ctx, gwURL, nil)
	if err != nil {
		return fmt.Errorf("WebSocket 连接失败: %w", err)
	}

	s.wsMu.Lock()
	s.wsConn = conn
	s.wsMu.Unlock()

	defer func() {
		conn.Close()
		s.wsMu.Lock()
		if s.wsConn == conn {
			s.wsConn = nil
		}
		s.wsMu.Unlock()
	}()

	return s.serveWS(ctx, conn, token)
}

func (s *Service) serveWS(ctx context.Context, conn *websocket.Conn, token string) error {
	msgCh := make(chan wsPayload, 64)
	errCh := make(chan error, 1)

	go func() {
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				errCh <- err
				return
			}
			var p wsPayload
			if err := json.Unmarshal(raw, &p); err != nil {
				log.Printf("qqbot: 解析 WebSocket 消息失败: %v", err)
				continue
			}
			msgCh <- p
		}
	}()

	var heartbeatTicker *time.Ticker
	defer func() {
		if heartbeatTicker != nil {
			heartbeatTicker.Stop()
		}
	}()

	for {
		select {
		case <-ctx.Done():
			conn.WriteMessage(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
			return ctx.Err()

		case err := <-errCh:
			return err

		case p := <-msgCh:
			if p.S > 0 {
				s.wsMu.Lock()
				s.lastSeq = p.S
				s.wsMu.Unlock()
			}

			switch p.Op {
			case opHello:
				var hello helloData
				json.Unmarshal(p.D, &hello)
				interval := hello.HeartbeatInterval
				if interval <= 0 {
					interval = 41250
				}
				log.Printf("qqbot: Hello 收到，心跳间隔 %dms", interval)

				if heartbeatTicker != nil {
					heartbeatTicker.Stop()
				}
				heartbeatTicker = time.NewTicker(time.Duration(interval) * time.Millisecond)

				// 尝试 Resume 或 Identify
				s.wsMu.Lock()
				sid := s.sessionID
				seq := s.lastSeq
				s.wsMu.Unlock()

				if sid != "" && seq > 0 {
					log.Printf("qqbot: 尝试 Resume session=%s seq=%d", sid, seq)
					resume := map[string]any{
						"op": opResume,
						"d": map[string]any{
							"token":      "QQBot " + token,
							"session_id": sid,
							"seq":        seq,
						},
					}
					if err := conn.WriteJSON(resume); err != nil {
						return err
					}
				} else {
					if err := s.sendIdentify(conn, token); err != nil {
						return err
					}
				}

			case opHeartbAck:
				// 心跳 ACK，无需处理

			case opInvalidSe:
				log.Printf("qqbot: Session 无效，重新 Identify")
				s.wsMu.Lock()
				s.sessionID = ""
				s.lastSeq = 0
				s.wsMu.Unlock()
				if err := s.sendIdentify(conn, token); err != nil {
					return err
				}

			case opDispatch:
				s.handleDispatch(ctx, p)
			}

		case <-func() <-chan time.Time {
			if heartbeatTicker != nil {
				return heartbeatTicker.C
			}
			return nil
		}():
			s.wsMu.Lock()
			seq := s.lastSeq
			s.wsMu.Unlock()
			hb := map[string]any{"op": opHeartbeat, "d": seq}
			if err := conn.WriteJSON(hb); err != nil {
				return fmt.Errorf("发送心跳失败: %w", err)
			}
		}
	}
}

func (s *Service) sendIdentify(conn *websocket.Conn, token string) error {
	intents := intentGroupAndC2C | intentInteraction
	log.Printf("qqbot: 发送 Identify intents=%d", intents)
	identify := map[string]any{
		"op": opIdentify,
		"d": map[string]any{
			"token":   "QQBot " + token,
			"intents": intents,
			"shard":   []int{0, 1},
		},
	}
	return conn.WriteJSON(identify)
}

func (s *Service) handleDispatch(ctx context.Context, p wsPayload) {
	switch p.T {
	case "READY":
		var ready readyData
		json.Unmarshal(p.D, &ready)
		s.wsMu.Lock()
		s.sessionID = ready.SessionID
		s.wsState = "connected"
		s.wsMu.Unlock()
		log.Printf("qqbot: READY session=%s", ready.SessionID)

	case "RESUMED":
		s.wsMu.Lock()
		s.wsState = "connected"
		s.wsMu.Unlock()
		log.Printf("qqbot: RESUMED 会话恢复成功")

	case "C2C_MESSAGE_CREATE":
		s.handleC2CMessage(ctx, p.D)

	case "GROUP_AT_MESSAGE_CREATE":
		s.handleGroupMessage(ctx, p.D)

	default:
		log.Printf("qqbot: 忽略事件 t=%s", p.T)
	}
}

func (s *Service) handleC2CMessage(ctx context.Context, raw json.RawMessage) {
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		log.Printf("qqbot: 解析 C2C 消息失败: %v", err)
		return
	}

	author, _ := data["author"].(map[string]any)
	openID := firstString(author["user_openid"], data["user_openid"])
	msgID := firstString(data["id"])
	content := strings.TrimSpace(firstString(data["content"]))

	if openID == "" {
		log.Printf("qqbot: C2C 消息缺少 user_openid")
		return
	}

	cfg := s.Config()
	if !allowed(openID, cfg.AllowOpenIDs) {
		log.Printf("qqbot: C2C openid=%s 不在允许列表", openID)
		return
	}

	text := strings.TrimSpace(qqMentionRE.ReplaceAllString(content, ""))
	target := replyTarget{Kind: "c2c", OpenID: openID, MsgID: msgID}

	imageURLs := extractImageURLs(data)
	images := make([]service.PromptImage, 0, len(imageURLs))
	for _, u := range imageURLs {
		img, err := s.downloadImage(ctx, u, cfg.MaxImageBytes)
		if err != nil {
			log.Printf("qqbot: 下载图片失败: %v", err)
			continue
		}
		images = append(images, img)
	}

	if text == "" && len(images) == 0 {
		log.Printf("qqbot: C2C 空消息 openid=%s", openID)
		return
	}

	s.dispatchToBridge(text, target, images)
}

func (s *Service) handleGroupMessage(ctx context.Context, raw json.RawMessage) {
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		log.Printf("qqbot: 解析群消息失败: %v", err)
		return
	}

	groupOpenID := firstString(data["group_openid"])
	author, _ := data["author"].(map[string]any)
	memberOpenID := firstString(author["member_openid"])
	msgID := firstString(data["id"])
	content := strings.TrimSpace(firstString(data["content"]))

	if groupOpenID == "" {
		log.Printf("qqbot: 群消息缺少 group_openid")
		return
	}

	cfg := s.Config()
	if !allowed(groupOpenID, cfg.AllowGroupOpenIDs) {
		log.Printf("qqbot: 群 %s 不在允许列表", groupOpenID)
		return
	}

	text := strings.TrimSpace(qqMentionRE.ReplaceAllString(content, ""))
	target := replyTarget{Kind: "group", GroupOpenID: groupOpenID, OpenID: memberOpenID, MsgID: msgID}

	imageURLs := extractImageURLs(data)
	images := make([]service.PromptImage, 0, len(imageURLs))
	for _, u := range imageURLs {
		img, err := s.downloadImage(ctx, u, cfg.MaxImageBytes)
		if err != nil {
			log.Printf("qqbot: 下载图片失败: %v", err)
			continue
		}
		images = append(images, img)
	}

	if text == "" && len(images) == 0 {
		log.Printf("qqbot: 群空消息 group=%s", groupOpenID)
		return
	}

	s.dispatchToBridge(text, target, images)
}

func (s *Service) dispatchToBridge(text string, target replyTarget, images []service.PromptImage) {
	opID := "qq-" + correl.ID()
	s.registerTurn(opID, target)
	if err := s.bridge.ChatWithOpID(text, opID, "chat", images); err != nil {
		s.forgetTurn(opID)
		log.Printf("qqbot: 消息入队失败: %v", err)
		return
	}
	log.Printf("qqbot: 消息已入队 kind=%s opID=%s textLen=%d images=%d", target.Kind, opID, len(text), len(images))
}

// ─── Bridge 事件处理 ───

func (s *Service) registerTurn(opID string, target replyTarget) {
	if strings.TrimSpace(opID) == "" {
		return
	}
	s.mu.Lock()
	s.pending[opID] = &turn{opID: opID, target: target, createdAt: time.Now()}
	s.mu.Unlock()
}

func (s *Service) forgetTurn(opID string) {
	s.mu.Lock()
	delete(s.pending, opID)
	if s.current != nil && s.current.opID == opID {
		s.current = nil
	}
	s.mu.Unlock()
}

func (s *Service) handleBridgeEvent(raw json.RawMessage) {
	var ev map[string]any
	if err := json.Unmarshal(raw, &ev); err != nil {
		return
	}
	t, _ := ev["type"].(string)
	switch t {
	case "prompt_begin":
		opID := firstString(ev["opId"], ev["opID"], ev["id"])
		if opID == "" {
			return
		}
		s.mu.Lock()
		if tr := s.pending[opID]; tr != nil {
			s.current = tr
			delete(s.pending, opID)
		}
		s.mu.Unlock()
	case "session_update":
		text := agentMessageText(ev)
		if text == "" {
			return
		}
		s.mu.Lock()
		if s.current != nil {
			_, _ = s.current.buf.WriteString(text)
		}
		s.mu.Unlock()
	case "prompt_done":
		s.mu.Lock()
		tr := s.current
		s.current = nil
		if tr != nil {
			tr.finishedAt = time.Now()
		}
		s.mu.Unlock()
		if tr == nil {
			return
		}
		msg := strings.TrimSpace(tr.buf.String())
		if msg == "" {
			msg = "（本轮没有可发送的文本回复）"
		}
		go func() {
			if err := s.SendMarkdown(context.Background(), tr.target, msg); err != nil {
				log.Printf("qqbot: 发送回复失败 opID=%s: %v", tr.opID, err)
			}
		}()
	}
}

// ─── 消息发送 (REST API) ───

func (s *Service) SendMarkdown(ctx context.Context, target replyTarget, markdown string) error {
	cfg := s.Config()
	if !cfg.Enabled {
		return errors.New("qqbot disabled")
	}
	token, err := s.accessToken(ctx, cfg)
	if err != nil {
		return err
	}
	endpoint, err := sendEndpoint(target)
	if err != nil {
		return err
	}

	chunks := chunkMarkdownText(markdown, 5000)
	for _, chunk := range chunks {
		payload := map[string]any{
			"msg_type": 2,
			"markdown": map[string]any{
				"content": chunk,
			},
			"msg_seq": nextMsgSeq(),
		}
		if target.MsgID != "" {
			payload["msg_id"] = target.MsgID
		}
		body, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "QQBot "+token)
		req.Header.Set("Content-Type", "application/json")
		resp, err := s.httpClient.Do(req)
		if err != nil {
			return err
		}
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return fmt.Errorf("qq api status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(respBody)))
		}
	}
	return nil
}

// nextMsgSeq 生成唯一消息序号（与 openclaw-qqbot 一致：时间戳低位 ^ 随机数，0~65535）。
func nextMsgSeq() int {
	t := time.Now().UnixMilli() % 100000000
	r := time.Now().UnixNano() % 65536
	return int((t ^ r) % 65536)
}

// chunkMarkdownText 按 limit 分片 markdown 文本，尽量在行边界或代码块边界拆分。
func chunkMarkdownText(text string, limit int) []string {
	if len(text) <= limit {
		return []string{text}
	}
	var chunks []string
	remaining := text
	for len(remaining) > 0 {
		if len(remaining) <= limit {
			chunks = append(chunks, remaining)
			break
		}
		cut := findMarkdownBreak(remaining, limit)
		chunks = append(chunks, remaining[:cut])
		remaining = remaining[cut:]
	}
	return chunks
}

// findMarkdownBreak 在 text[:limit] 内寻找合适的拆分点。
func findMarkdownBreak(text string, limit int) int {
	seg := text[:limit]
	// 优先在最后一个换行处拆分
	if idx := strings.LastIndex(seg, "\n"); idx > limit/2 {
		return idx + 1
	}
	// 其次在最后一个空格处拆分
	if idx := strings.LastIndex(seg, " "); idx > limit/2 {
		return idx + 1
	}
	return limit
}

func sendEndpoint(target replyTarget) (string, error) {
	switch target.Kind {
	case "c2c":
		if target.OpenID == "" {
			return "", errors.New("missing openid")
		}
		return apiBase + "/v2/users/" + url.PathEscape(target.OpenID) + "/messages", nil
	case "group":
		if target.GroupOpenID == "" {
			return "", errors.New("missing group_openid")
		}
		return apiBase + "/v2/groups/" + url.PathEscape(target.GroupOpenID) + "/messages", nil
	default:
		return "", fmt.Errorf("unsupported qq target kind %q", target.Kind)
	}
}

// ─── Token 管理 ───

func (s *Service) accessToken(ctx context.Context, cfg Config) (string, error) {
	s.tokenMu.Lock()
	if s.token != "" && time.Until(s.tokenAt) > time.Minute {
		token := s.token
		s.tokenMu.Unlock()
		return token, nil
	}
	s.tokenMu.Unlock()

	body, err := json.Marshal(map[string]string{
		"appId":        cfg.AppID,
		"clientSecret": cfg.AppSecret,
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenEndpoint, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("qq token status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	var out tokenResponse
	if err := json.Unmarshal(respBody, &out); err != nil {
		return "", err
	}
	if out.AccessToken == "" {
		return "", errors.New("qq token response missing access_token")
	}
	expiresIn := parseExpiresIn(out.ExpiresInRaw)
	if expiresIn <= 0 {
		expiresIn = 7200
	}
	exp := time.Now().Add(time.Duration(expiresIn-60) * time.Second)
	s.tokenMu.Lock()
	s.token = out.AccessToken
	s.tokenAt = exp
	s.tokenMu.Unlock()
	return out.AccessToken, nil
}

func (s *Service) getGatewayURL(ctx context.Context, token string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, gatewayURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "QQBot "+token)
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("gateway status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var gw gatewayResponse
	if err := json.Unmarshal(body, &gw); err != nil {
		return "", err
	}
	if gw.URL == "" {
		return "", errors.New("gateway response missing url")
	}
	return gw.URL, nil
}

func parseExpiresIn(v any) int64 {
	switch x := v.(type) {
	case float64:
		return int64(x)
	case int64:
		return x
	case int:
		return int64(x)
	case json.Number:
		n, _ := x.Int64()
		return n
	case string:
		n, _ := strconv.ParseInt(strings.TrimSpace(x), 10, 64)
		return n
	default:
		return 0
	}
}

func (s *Service) invalidateToken() {
	s.tokenMu.Lock()
	s.token = ""
	s.tokenAt = time.Time{}
	s.tokenMu.Unlock()
}

// ─── 图片下载 ───

func (s *Service) downloadImage(ctx context.Context, rawURL string, limit int64) (service.PromptImage, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return service.PromptImage{}, err
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return service.PromptImage{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return service.PromptImage{}, fmt.Errorf("image status=%d", resp.StatusCode)
	}
	var r io.Reader = resp.Body
	if limit > 0 {
		r = io.LimitReader(resp.Body, limit+1)
	}
	b, err := io.ReadAll(r)
	if err != nil {
		return service.PromptImage{}, err
	}
	if limit > 0 && int64(len(b)) > limit {
		return service.PromptImage{}, fmt.Errorf("image exceeds %d bytes", limit)
	}
	mimeType := resp.Header.Get("Content-Type")
	if idx := strings.IndexByte(mimeType, ';'); idx >= 0 {
		mimeType = strings.TrimSpace(mimeType[:idx])
	}
	if mimeType == "" {
		mimeType = http.DetectContentType(b)
	}
	exts, _ := mime.ExtensionsByType(mimeType)
	name := "qq-image"
	if len(exts) > 0 {
		name += exts[0]
	}
	return service.PromptImage{
		Data:     base64.StdEncoding.EncodeToString(b),
		MimeType: mimeType,
		Name:     name,
	}, nil
}

// ─── 辅助函数 ───

func agentMessageText(ev map[string]any) string {
	upd, ok := ev["update"]
	if !ok || upd == nil {
		return ""
	}
	if s, ok := upd.(string); ok {
		var parsed any
		if err := json.Unmarshal([]byte(s), &parsed); err == nil {
			upd = parsed
		}
	}
	m, ok := upd.(map[string]any)
	if !ok {
		return ""
	}
	merged := mergeSessionUpdateEnvelope(m)
	kind := normalizeKind(merged)
	if kind != "agent_message_chunk" {
		return ""
	}
	return extractText(merged["content"])
}

func mergeSessionUpdateEnvelope(in map[string]any) map[string]any {
	out := make(map[string]any, len(in)+4)
	for k, v := range in {
		out[k] = v
	}
	if nested, ok := out["sessionUpdate"].(map[string]any); ok {
		for k, v := range nested {
			out[k] = v
		}
		delete(out, "sessionUpdate")
	}
	if nested, ok := out["session_update"].(map[string]any); ok {
		for k, v := range nested {
			out[k] = v
		}
		delete(out, "session_update")
	}
	return out
}

func normalizeKind(m map[string]any) string {
	raw := firstString(m["sessionUpdate"], m["session_update"])
	if raw == "" {
		if nested, ok := m["sessionUpdate"].(map[string]any); ok {
			raw = firstString(nested["type"], nested["kind"], nested["sessionUpdate"])
		}
	}
	if raw == "" {
		raw = firstString(m["type"], m["kind"])
	}
	return toSnakeLower(raw)
}

func toSnakeLower(s string) string {
	var b strings.Builder
	var prevLower bool
	for _, r := range strings.TrimSpace(s) {
		switch {
		case r == '-':
			b.WriteByte('_')
			prevLower = false
		case r >= 'A' && r <= 'Z':
			if prevLower {
				b.WriteByte('_')
			}
			b.WriteRune(r + ('a' - 'A'))
			prevLower = false
		default:
			b.WriteRune(r)
			prevLower = (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
		}
	}
	return strings.ToLower(b.String())
}

func extractText(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case []any:
		var b strings.Builder
		for _, item := range x {
			b.WriteString(extractText(item))
		}
		return b.String()
	case map[string]any:
		if s := firstString(x["text"]); s != "" {
			return s
		}
		if x["type"] == "text" {
			return firstString(x["content"])
		}
		if parts, ok := x["parts"].([]any); ok {
			return extractText(parts)
		}
	}
	return ""
}

func extractImageURLs(data map[string]any) []string {
	var out []string
	collectImageURLs(data["attachments"], &out)
	collectImageURLs(data["images"], &out)
	collectImageURLs(data["image"], &out)
	if msg, ok := data["message"].(map[string]any); ok {
		collectImageURLs(msg["attachments"], &out)
		collectImageURLs(msg["images"], &out)
	}
	seen := make(map[string]struct{}, len(out))
	uniq := out[:0]
	for _, u := range out {
		u = strings.TrimSpace(u)
		if u == "" {
			continue
		}
		if _, ok := seen[u]; ok {
			continue
		}
		seen[u] = struct{}{}
		uniq = append(uniq, u)
	}
	return uniq
}

func collectImageURLs(v any, out *[]string) {
	switch x := v.(type) {
	case string:
		if looksLikeImageURL(x) {
			*out = append(*out, x)
		}
	case []any:
		for _, item := range x {
			collectImageURLs(item, out)
		}
	case map[string]any:
		ct := strings.ToLower(firstString(x["content_type"], x["contentType"], x["mime_type"], x["mimeType"]))
		for _, key := range []string{"url", "image_url", "imageUrl"} {
			if s := firstString(x[key]); s != "" && (strings.HasPrefix(ct, "image/") || (ct == "" && looksLikeImageURL(s))) {
				*out = append(*out, s)
			}
		}
	}
}

func looksLikeImageURL(s string) bool {
	low := strings.ToLower(strings.TrimSpace(s))
	return (strings.HasPrefix(low, "http://") || strings.HasPrefix(low, "https://")) &&
		(strings.Contains(low, ".png") || strings.Contains(low, ".jpg") || strings.Contains(low, ".jpeg") || strings.Contains(low, ".gif") || strings.Contains(low, ".webp"))
}

func allowed(id string, allow []string) bool {
	if len(allow) == 0 {
		return true
	}
	for _, v := range allow {
		if v == id {
			return true
		}
	}
	return false
}

func firstString(vals ...any) string {
	for _, v := range vals {
		switch x := v.(type) {
		case string:
			if strings.TrimSpace(x) != "" {
				return strings.TrimSpace(x)
			}
		case fmt.Stringer:
			if strings.TrimSpace(x.String()) != "" {
				return strings.TrimSpace(x.String())
			}
		}
	}
	return ""
}
