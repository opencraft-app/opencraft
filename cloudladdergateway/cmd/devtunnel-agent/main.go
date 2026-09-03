// Command devtunnel-agent 是反向回调隧道的客户端，跑在开发者的 DevCloud 机器上。
//
// 它只做出站：长轮询 hub 取回调请求，回放到本机固定的 trade 回调地址，再把应答
// 交回 hub。全程没有任何监听端口，因此不需要任何人能反向连入 DevCloud。
//
// 安全边界：只回放到写死的本地 base（默认 127.0.0.1:18084）、且只放行固定路径前缀
// （默认 /trade/jifei/callback），不是通用端口转发，避免被当作跳板。
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/devtunnel"
)

func main() {
	logger := log.New(os.Stdout, "[devtunnel-agent] ", log.LstdFlags)

	var (
		pollBase  = flag.String("hub", envOr("DEVTUNNEL_HUB", ""), "hub 控制面 base URL（经云梯 CLB 的 proxy 路由，如 http://1.12.212.56/v1/proxy/devtunnel）")
		env       = flag.String("env", envOr("DEVTUNNEL_ENV", ""), "本环境的分流 key，必须等于云梯为本 dev 路由盖的 Host")
		token     = flag.String("token", os.Getenv("DEVTUNNEL_TOKEN"), "Bearer token，与 hub 一致")
		localBase = flag.String("local", envOr("DEVTUNNEL_LOCAL_BASE", "http://127.0.0.1:18084"), "本地 trade 回放 base URL")
		allowPfx  = flag.String("allow-prefix", envOr("DEVTUNNEL_ALLOW_PREFIX", "/trade/jifei/callback"), "只放行此路径前缀的回放")
	)
	flag.Parse()

	if strings.TrimSpace(*pollBase) == "" || strings.TrimSpace(*env) == "" {
		logger.Fatalf("必须提供 -hub 和 -env（或 DEVTUNNEL_HUB / DEVTUNNEL_ENV）")
	}
	base := strings.TrimRight(strings.TrimSpace(*pollBase), "/")
	logger.Printf("start: hub=%s env=%s local=%s allow=%s auth=%v", base, *env, *localBase, *allowPfx, *token != "")

	ctx, cancel := context.WithCancel(context.Background())
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() { <-stop; logger.Printf("stopping"); cancel() }()

	a := &agent{
		hubBase:   base,
		env:       *env,
		token:     strings.TrimSpace(*token),
		localBase: strings.TrimRight(strings.TrimSpace(*localBase), "/"),
		allowPfx:  *allowPfx,
		pollCli:   &http.Client{Timeout: 40 * time.Second}, // 略大于 hub 的 25s poll 挂起
		replayCli: &http.Client{Timeout: 15 * time.Second},
		logger:    logger,
	}
	a.run(ctx)
}

type agent struct {
	hubBase   string
	env       string
	token     string
	localBase string
	allowPfx  string
	pollCli   *http.Client
	replayCli *http.Client
	logger    *log.Logger
}

func (a *agent) run(ctx context.Context) {
	backoff := time.Second
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		got, err := a.pollOnce(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			a.logger.Printf("poll error: %v（%s 后重试）", err, backoff)
			time.Sleep(backoff)
			if backoff < 10*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = time.Second
		if got != nil {
			a.handle(ctx, *got)
		}
	}
}

// pollOnce 发一次长轮询。返回 (nil,nil) 表示空闲（应立即再轮询）。
func (a *agent) pollOnce(ctx context.Context) (*devtunnel.TunneledRequest, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, a.hubBase+"/_tunnel/poll?env="+a.env, nil)
	a.auth(req)
	resp, err := a.pollCli.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent {
		return nil, nil
	}
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, &httpError{resp.StatusCode, string(b)}
	}
	var tr devtunnel.TunneledRequest
	if err := json.NewDecoder(resp.Body).Decode(&tr); err != nil {
		return nil, err
	}
	return &tr, nil
}

// handle 回放一个请求到本地 trade，并把应答交回 hub。
func (a *agent) handle(ctx context.Context, tr devtunnel.TunneledRequest) {
	var out devtunnel.TunneledResponse
	if !strings.HasPrefix(tr.Path, a.allowPfx) {
		a.logger.Printf("rid=%s 拒绝回放非白名单路径 %q", tr.RID, tr.Path)
		out = devtunnel.TunneledResponse{Status: http.StatusForbidden, Body: []byte("path not allowed by agent")}
	} else {
		out = a.replay(ctx, tr)
	}
	payload, _ := json.Marshal(out)
	rr, _ := http.NewRequestWithContext(ctx, http.MethodPost, a.hubBase+"/_tunnel/reply?rid="+tr.RID, bytes.NewReader(payload))
	a.auth(rr)
	resp, err := a.replayCli.Do(rr)
	if err != nil {
		a.logger.Printf("rid=%s reply 失败: %v", tr.RID, err)
		return
	}
	resp.Body.Close()
	if resp.StatusCode == http.StatusGone {
		a.logger.Printf("rid=%s 应答被丢弃（ingest 已超时）", tr.RID)
	}
}

func (a *agent) replay(ctx context.Context, tr devtunnel.TunneledRequest) devtunnel.TunneledResponse {
	url := a.localBase + tr.Path
	if tr.Query != "" {
		url += "?" + tr.Query
	}
	req, err := http.NewRequestWithContext(ctx, tr.Method, url, bytes.NewReader(tr.Body))
	if err != nil {
		return devtunnel.TunneledResponse{Status: http.StatusBadGateway, Body: []byte(err.Error())}
	}
	for k, vs := range tr.Headers {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	resp, err := a.replayCli.Do(req)
	if err != nil {
		a.logger.Printf("rid=%s 回放本地失败: %v", tr.RID, err)
		return devtunnel.TunneledResponse{Status: http.StatusBadGateway, Body: []byte(err.Error())}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	a.logger.Printf("rid=%s %s %s → %d (%dB)", tr.RID, tr.Method, tr.Path, resp.StatusCode, len(body))
	return devtunnel.TunneledResponse{Status: resp.StatusCode, Headers: resp.Header, Body: body}
}

func (a *agent) auth(r *http.Request) {
	if a.token != "" {
		r.Header.Set("Authorization", "Bearer "+a.token)
	}
}

type httpError struct {
	code int
	body string
}

func (e *httpError) Error() string { return "hub returned " + http.StatusText(e.code) + ": " + e.body }

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}
