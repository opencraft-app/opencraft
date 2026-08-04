package humantui

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"velachat/agent/internal/reactvaxis"
	"velachat/agent/internal/reactvaxis/nativemodule"
	"velachat/agent/internal/vela/gojaim"
	"velachat/agent/internal/vela/humanim"
	"velachat/agent/internal/vela/humanplatform"
	"velachat/agent/internal/vela/im"
)

type Config struct {
	PlatformURL       string
	StateRoot         string
	AllowInsecureHTTP bool
	HTTP              *http.Client
	NewTransport      func() (im.Transport, error)
}

type App struct {
	runtime   *reactvaxis.Runtime
	messaging *humanim.Adapter
	closeOnce sync.Once
	closeErr  error
}

func New(config Config) (*App, error) {
	if strings.TrimSpace(config.PlatformURL) == "" || !filepath.IsAbs(config.StateRoot) {
		return nil, errors.New("Human TUI 配置无效")
	}
	platform, err := humanplatform.NewClient(humanplatform.Config{
		BaseURL:           config.PlatformURL,
		StatePath:         filepath.Join(config.StateRoot, "human", "session.json"),
		AllowInsecureHTTP: config.AllowInsecureHTTP,
		HTTP:              config.HTTP,
	})
	if err != nil {
		return nil, err
	}
	newTransport := config.NewTransport
	if newTransport == nil {
		newTransport = func() (im.Transport, error) {
			return gojaim.NewTransport(gojaim.TransportConfig{})
		}
	}
	messaging := humanim.NewAdapter(humanim.Config{Issuer: platform, NewTransport: newTransport})
	registry := nativemodule.NewRegistry(nativemodule.WithQueueCapacity(1024))
	registerModules(registry, platform, messaging)
	bundle, err := EmbeddedBundle()
	if err != nil {
		return nil, err
	}
	runtime, err := reactvaxis.NewRuntime(reactvaxis.RuntimeConfig{
		Bundle: bundle, Installers: []reactvaxis.Installer{registry}, Commits: 8,
	})
	if err != nil {
		return nil, err
	}
	return &App{runtime: runtime, messaging: messaging}, nil
}

func (a *App) Run() error {
	return reactvaxis.RunInteractive(a.runtime)
}

func (a *App) Snapshot(ctx context.Context, width, height int) (string, error) {
	return reactvaxis.Snapshot(ctx, a.runtime, width, height)
}

func (a *App) Close() error {
	a.closeOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		a.closeErr = a.messaging.Close(ctx)
		a.runtime.Close()
	})
	return a.closeErr
}
