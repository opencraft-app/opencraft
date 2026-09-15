package modelgateway

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"time"
)

const maxRequestBody = 16 << 20

type Gateway struct {
	Listen   string
	Registry *Registry
	Client   *http.Client
}

func New(listen string, registry *Registry) *Gateway {
	if registry == nil {
		registry = NewRegistry()
	}
	return &Gateway{
		Listen: listen, Registry: registry,
		Client: &http.Client{Transport: &http.Transport{
			Proxy:             http.ProxyFromEnvironment,
			DialContext:       (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			ForceAttemptHTTP2: true,
		}},
	}
}

func (g *Gateway) Serve(ctx context.Context) error {
	server := &http.Server{
		Addr: g.Listen, Handler: g,
		ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second,
	}
	listener, err := net.Listen("tcp", g.Listen)
	if err != nil {
		return err
	}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("hypernode model gateway listening on %s", g.Listen)
	err = server.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (g *Gateway) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.Method == http.MethodGet && request.URL.Path == "/healthz" {
		response.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(response, `{"ok":true}`)
		return
	}
	const prefix = "/providers/"
	const suffix = "/v1/responses"
	if request.Method != http.MethodPost || !strings.HasPrefix(request.URL.Path, prefix) || !strings.HasSuffix(request.URL.Path, suffix) {
		http.NotFound(response, request)
		return
	}
	id := strings.TrimSuffix(strings.TrimPrefix(request.URL.Path, prefix), suffix)
	provider, found := g.Registry.Get(id)
	if !found {
		writeAPIError(response, http.StatusNotFound, "unknown HyperNode model provider")
		return
	}
	authorization := request.Header.Get("Authorization")
	if authorization == "" {
		writeAPIError(response, http.StatusUnauthorized, "missing Authorization header")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(response, request.Body, maxRequestBody))
	if err != nil {
		writeAPIError(response, http.StatusBadRequest, "invalid Responses request")
		return
	}
	chatBody, stream, codec, err := responsesToChat(body)
	if err != nil {
		writeAPIError(response, http.StatusBadRequest, err.Error())
		return
	}
	upstream, err := http.NewRequestWithContext(request.Context(), http.MethodPost, provider.Endpoint, bytes.NewReader(chatBody))
	if err != nil {
		writeAPIError(response, http.StatusBadGateway, "invalid provider endpoint")
		return
	}
	upstream.Header.Set("Authorization", authorization)
	upstream.Header.Set("Content-Type", "application/json")
	upstream.Header.Set("Accept", map[bool]string{true: "text/event-stream", false: "application/json"}[stream])
	if organization := request.Header.Get("OpenAI-Organization"); organization != "" {
		upstream.Header.Set("OpenAI-Organization", organization)
	}
	upstreamResponse, err := g.Client.Do(upstream)
	if err != nil {
		writeAPIError(response, http.StatusBadGateway, "model provider request failed")
		return
	}
	defer upstreamResponse.Body.Close()
	if upstreamResponse.StatusCode < 200 || upstreamResponse.StatusCode >= 300 {
		copyUpstreamError(response, upstreamResponse)
		return
	}
	if stream {
		response.Header().Set("Content-Type", "text/event-stream")
		response.Header().Set("Cache-Control", "no-cache")
		response.Header().Set("X-Accel-Buffering", "no")
		response.WriteHeader(http.StatusOK)
		if err := translateChatStream(request.Context(), response, upstreamResponse.Body, codec); err != nil && !errors.Is(err, context.Canceled) {
			log.Printf("model gateway stream ended: %v", err)
		}
		return
	}
	translated, err := translateChatResponse(upstreamResponse.Body, codec)
	if err != nil {
		writeAPIError(response, http.StatusBadGateway, "invalid model provider response")
		return
	}
	response.Header().Set("Content-Type", "application/json")
	_, _ = response.Write(translated)
}

func copyUpstreamError(response http.ResponseWriter, upstream *http.Response) {
	body, _ := io.ReadAll(io.LimitReader(upstream.Body, 1<<20))
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(upstream.StatusCode)
	if json.Valid(body) {
		_, _ = response.Write(body)
		return
	}
	encoded, _ := json.Marshal(map[string]any{"error": map[string]any{"message": strings.TrimSpace(string(body)), "type": "upstream_error"}})
	_, _ = response.Write(encoded)
}

func writeAPIError(response http.ResponseWriter, status int, message string) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(map[string]any{"error": map[string]any{"message": message, "type": "invalid_request_error"}})
}

func writeSSE(writer io.Writer, event string, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(writer, "event: %s\ndata: %s\n\n", event, encoded)
	return err
}

func scanSSE(reader io.Reader, consume func(data []byte) error) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 4<<20)
	var data []string
	flush := func() error {
		if len(data) == 0 {
			return nil
		}
		joined := []byte(strings.Join(data, "\n"))
		data = data[:0]
		if string(joined) == "[DONE]" {
			return io.EOF
		}
		return consume(joined)
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if err := flush(); err != nil {
				if errors.Is(err, io.EOF) {
					return nil
				}
				return err
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return flush()
}
