package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type loadUser struct {
	ID     string
	SetID  string
	APIKey string
	SSE    bool
}

type loadController struct {
	cfg    config
	users  []loadUser
	stats  *loadStats
	phase  atomic.Int64
	client *http.Client
	wg     sync.WaitGroup
}

func newLoadController(cfg config, users []loadUser) *loadController {
	return &loadController{
		cfg: cfg, users: users, stats: newLoadStats(),
		client: &http.Client{Timeout: cfg.SSEDuration + 45*time.Second},
	}
}

func (l *loadController) start(ctx context.Context) {
	for index := range l.users {
		user := l.users[index]
		l.wg.Add(1)
		go func(seed int64) {
			defer l.wg.Done()
			if user.SSE {
				l.runSSE(ctx, user)
				return
			}
			l.runNormal(ctx, user, rand.New(rand.NewSource(seed)))
		}(int64(index + 1))
	}
}

func (l *loadController) stopAndWait() { l.wg.Wait() }

func (l *loadController) setPhase(phase int) { l.phase.Store(int64(phase)) }

func (l *loadController) runNormal(ctx context.Context, user loadUser, random *rand.Rand) {
	for {
		phase := int(l.phase.Load())
		err := l.chat(ctx, user.APIKey, false)
		l.stats.recordNormal(phase, err)
		jitter := time.Duration(random.Int63n(int64(l.cfg.NormalInterval/2)+1)) - l.cfg.NormalInterval/4
		if !waitContext(ctx, l.cfg.NormalInterval+jitter) {
			return
		}
	}
}

func (l *loadController) runSSE(ctx context.Context, user loadUser) {
	for {
		phase := int(l.phase.Load())
		started := time.Now()
		err := l.chat(ctx, user.APIKey, true)
		l.stats.recordSSE(phase, time.Since(started), err)
		if ctx.Err() != nil {
			return
		}
	}
}

func (l *loadController) chat(ctx context.Context, key string, stream bool) error {
	payload, _ := json.Marshal(map[string]any{
		"model": l.cfg.Model,
		"messages": []map[string]string{
			{"role": "system", "content": "You are a deterministic upgrade regression assistant."},
			{"role": "user", "content": "你好"},
		},
		"stream": stream,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, l.cfg.TrafficURL+"/v1/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	resp, err := l.client.Do(req)
	if err != nil {
		return compactLoadError(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return compactLoadError(err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("status=%d body=%s", resp.StatusCode, truncate(string(raw), 160))
	}
	if stream && !bytes.Contains(raw, []byte("data: [DONE]")) {
		return errNoSSEEvents
	}
	if !stream && len(bytes.TrimSpace(raw)) == 0 {
		return fmt.Errorf("empty response")
	}
	return nil
}

func compactLoadError(err error) error {
	if err == nil {
		return nil
	}
	message := err.Error()
	for _, marker := range []string{"context canceled", "Client.Timeout", "connection reset", "EOF"} {
		if strings.Contains(message, marker) {
			return fmt.Errorf("%s", marker)
		}
	}
	return fmt.Errorf("%s", truncate(message, 160))
}

func truncate(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}
