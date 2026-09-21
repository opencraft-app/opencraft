package httptransport

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func TestNewServerUsesExplicitMuxAndTimeouts(t *testing.T) {
	config := ServerConfig{
		Address:           "127.0.0.1:0",
		ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    32 << 10,
		ShutdownTimeout:   15 * time.Second,
	}
	server, err := NewServer(config, http.HandlerFunc(func(
		http.ResponseWriter,
		*http.Request,
	) {
	}))
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	httpServer := server.HTTPServer()

	if httpServer.Handler == nil {
		t.Fatal("http.Server.Handler is nil and would use DefaultServeMux")
	}
	if httpServer.Handler == http.DefaultServeMux {
		t.Fatal("http.Server uses DefaultServeMux")
	}
	if httpServer.ReadHeaderTimeout != config.ReadHeaderTimeout ||
		httpServer.ReadTimeout != config.ReadTimeout ||
		httpServer.WriteTimeout != config.WriteTimeout ||
		httpServer.IdleTimeout != config.IdleTimeout ||
		httpServer.MaxHeaderBytes != config.MaxHeaderBytes {
		t.Fatalf("http.Server timeouts/header limit do not match config: %#v", httpServer)
	}
}

func TestNewServerRejectsUnsafeConfig(t *testing.T) {
	_, err := NewServer(ServerConfig{}, http.HandlerFunc(func(
		http.ResponseWriter,
		*http.Request,
	) {
	}))
	if err == nil {
		t.Fatal("NewServer() error = nil for empty config")
	}
}

func TestServerShutdownUsesConfiguredDrainLimit(t *testing.T) {
	server, err := NewServer(ServerConfig{
		Address:           "127.0.0.1:0",
		ReadHeaderTimeout: time.Second,
		ReadTimeout:       time.Second,
		WriteTimeout:      time.Second,
		IdleTimeout:       time.Second,
		MaxHeaderBytes:    1024,
		ShutdownTimeout:   20 * time.Millisecond,
	}, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}

	if err := server.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown() error = %v", err)
	}
}
