package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func newPacerHandler(upstreamBaseURL string, streamDuration time.Duration) http.Handler {
	upstream, err := url.Parse(upstreamBaseURL)
	if err != nil {
		panic(err)
	}
	client := &http.Client{Transport: http.DefaultTransport}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			w.WriteHeader(http.StatusOK)
			return
		}

		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		target := *upstream
		target.Path = singleJoiningSlash(upstream.Path, r.URL.Path)
		target.RawQuery = r.URL.RawQuery
		upstreamRequest, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), bytes.NewReader(body))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		copyHeaders(upstreamRequest.Header, r.Header)

		response, err := client.Do(upstreamRequest)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer response.Body.Close()
		copyHeaders(w.Header(), response.Header)
		w.WriteHeader(response.StatusCode)

		if !isStreamingRequest(body) || response.StatusCode >= http.StatusBadRequest {
			_, _ = io.Copy(w, response.Body)
			return
		}

		payload, err := io.ReadAll(response.Body)
		if err != nil {
			return
		}
		events := splitSSEEvents(payload)
		if len(events) == 0 {
			return
		}
		interval := time.Duration(0)
		if len(events) > 1 {
			interval = streamDuration / time.Duration(len(events)-1)
		}
		for i, event := range events {
			if i > 0 && !waitContext(r.Context(), interval) {
				return
			}
			if _, err := w.Write(event); err != nil {
				return
			}
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
		}
	})
}

func isStreamingRequest(body []byte) bool {
	compact := bytes.ReplaceAll(body, []byte(" "), nil)
	compact = bytes.ReplaceAll(compact, []byte("\n"), nil)
	compact = bytes.ReplaceAll(compact, []byte("\t"), nil)
	return bytes.Contains(compact, []byte(`"stream":true`))
}

func splitSSEEvents(payload []byte) [][]byte {
	normalized := bytes.ReplaceAll(payload, []byte("\r\n"), []byte("\n"))
	parts := bytes.Split(normalized, []byte("\n\n"))
	events := make([][]byte, 0, len(parts))
	for _, part := range parts {
		if len(bytes.TrimSpace(part)) == 0 {
			continue
		}
		event := append([]byte(nil), part...)
		event = append(event, '\n', '\n')
		events = append(events, event)
	}
	return events
}

func waitContext(ctx context.Context, duration time.Duration) bool {
	if duration <= 0 {
		return true
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func copyHeaders(destination, source http.Header) {
	for name, values := range source {
		for _, value := range values {
			destination.Add(name, value)
		}
	}
}

func singleJoiningSlash(left, right string) string {
	leftSlash := strings.HasSuffix(left, "/")
	rightSlash := strings.HasPrefix(right, "/")
	switch {
	case leftSlash && rightSlash:
		return left + right[1:]
	case !leftSlash && !rightSlash:
		return left + "/" + right
	default:
		return left + right
	}
}

var errNoSSEEvents = errors.New("upstream returned no SSE events")
