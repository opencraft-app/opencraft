// Package app assembles the Vela command actions from the independently
// testable platform, embedded IM, Host, and existing Runtime components.
package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/agentgateway"
	velacli "github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/cli"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/gojaim"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/host"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/humantui"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/im"
	velainstall "github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/install"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/tat"
	"github.com/google/uuid"
)

var (
	ErrInvalidConfig      = errors.New("Vela 应用配置无效")
	ErrHistoryUnavailable = errors.New("Vela IM Transport 不支持历史恢复")
)

type Config struct {
	Root                  string
	Version               string
	BuildID               string
	Stdout                io.Writer
	Stderr                io.Writer
	Now                   func() time.Time
	AllowInsecureLoopback bool
	AllowInsecureHTTP     bool
	Transports            host.TransportFactory
	TAT                   tat.Runtime
	HeartbeatInterval     time.Duration
	CodexExecutable       string
	Controller            ComputerController
	InstallerFactory      InstallerFactory
}

type FirstInstaller interface {
	Install(context.Context, velainstall.Options) error
}

type InstallerFactory func() (FirstInstaller, error)

func (a *Actions) TUI(ctx context.Context, options velacli.TUIOptions) error {
	root, err := a.resolveStateRoot(options.StateDir)
	if err != nil {
		return err
	}
	application, err := humantui.New(humantui.Config{
		PlatformURL:       options.PlatformURL,
		StateRoot:         root,
		AllowInsecureHTTP: a.config.AllowInsecureHTTP,
	})
	if err != nil {
		return err
	}
	defer application.Close()
	finished := make(chan error, 1)
	go func() { finished <- application.Run() }()
	select {
	case err := <-finished:
		return err
	case <-ctx.Done():
		_ = application.Close()
		return ctx.Err()
	}
}

type Actions struct {
	config Config
}

var _ velacli.Actions = (*Actions)(nil)

func NewActions(config Config) (*Actions, error) {
	if config.Root != "" && !filepath.IsAbs(config.Root) ||
		strings.TrimSpace(config.Version) == "" ||
		config.Stdout == nil ||
		config.Stderr == nil {
		return nil, ErrInvalidConfig
	}
	if config.CodexExecutable != "" &&
		(!filepath.IsAbs(config.CodexExecutable) ||
			filepath.Clean(config.CodexExecutable) != config.CodexExecutable) {
		return nil, ErrInvalidConfig
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	if strings.TrimSpace(config.BuildID) == "" {
		config.BuildID = config.Version
	}
	if config.Root != "" {
		config.Root = filepath.Clean(config.Root)
	}
	if config.TAT == nil {
		config.TAT = tat.New()
	}
	if config.Controller == nil {
		config.Controller = &defaultComputerController{config: config}
	}
	return &Actions{config: config}, nil
}

func writeHostFailure(
	writer io.Writer,
	report host.FailureReport,
) {
	_, _ = fmt.Fprintf(
		writer,
		"Vela Agent Host failure: %s\n",
		report.String(),
	)
}

func writeHostStartup(writer io.Writer, stage host.StartupStage) {
	_, _ = fmt.Fprintf(
		writer,
		"Vela Agent Host startup: stage=%s\n",
		stage,
	)
}

type gojaTransportFactory struct{}

func (*gojaTransportFactory) New() (im.Transport, error) {
	return gojaim.NewTransport(gojaim.TransportConfig{})
}

type bindingTransportFactory struct {
	next host.TransportFactory
	slot *agentgateway.TransportSlot
}

func (f *bindingTransportFactory) New() (im.Transport, error) {
	transport, err := f.next.New()
	if err != nil {
		return nil, err
	}
	return &bindingTransport{
		next: transport,
		slot: f.slot,
	}, nil
}

type bindingTransport struct {
	next    im.Transport
	slot    *agentgateway.TransportSlot
	binding *agentgateway.TransportBinding
}

var _ im.Transport = (*bindingTransport)(nil)
var _ im.HistoryTransport = (*bindingTransport)(nil)

func (t *bindingTransport) Start(
	ctx context.Context,
	session im.Session,
) error {
	if err := t.next.Start(ctx, session); err != nil {
		return err
	}
	// Publish the concrete transport to the Gateway so its optional Tencent IM
	// capabilities (search, reactions, and attachments) remain discoverable.
	// The binding wrapper still owns lifecycle and history replay for Host.
	t.binding = t.slot.Bind(t.next)
	return nil
}

func (t *bindingTransport) SendText(
	ctx context.Context,
	request im.SendTextRequest,
) (im.SendReceipt, error) {
	return t.next.SendText(ctx, request)
}

func (t *bindingTransport) SendCustom(
	ctx context.Context,
	request im.SendCustomRequest,
) (im.SendReceipt, error) {
	return t.next.SendCustom(ctx, request)
}

func (t *bindingTransport) UnreadConversations(
	ctx context.Context,
) ([]im.UnreadConversation, error) {
	history, ok := t.next.(im.HistoryTransport)
	if !ok {
		return nil, ErrHistoryUnavailable
	}
	return history.UnreadConversations(ctx)
}

func (t *bindingTransport) History(
	ctx context.Context,
	request im.HistoryRequest,
) (im.HistoryPage, error) {
	history, ok := t.next.(im.HistoryTransport)
	if !ok {
		return im.HistoryPage{}, ErrHistoryUnavailable
	}
	return history.History(ctx, request)
}

func (t *bindingTransport) MarkRead(
	ctx context.Context,
	conversation im.Conversation,
) error {
	history, ok := t.next.(im.HistoryTransport)
	if !ok {
		return ErrHistoryUnavailable
	}
	return history.MarkRead(ctx, conversation)
}

func (t *bindingTransport) Events() <-chan im.Event {
	return t.next.Events()
}

func (t *bindingTransport) Close(ctx context.Context) error {
	if t.binding != nil {
		t.binding.Release()
	}
	return t.next.Close(ctx)
}

func newID() (string, error) {
	value, err := uuid.NewV7()
	if err != nil {
		return "", err
	}
	return value.String(), nil
}
