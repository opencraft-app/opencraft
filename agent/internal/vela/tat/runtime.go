// Package tat owns the narrow lifecycle boundary between the Go Vela daemon
// and the embedded Tencent TAT runtime.
package tat

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"

	"velachat/agent/internal/common"
)

var (
	ErrInvalidConfig     = errors.New("TAT 配置无效")
	ErrNativeUnavailable = errors.New(
		"当前构建未包含内嵌 TAT，请使用正式 macOS ARM64 构建",
	)
)

type Tag struct {
	Key   string `json:"Key"`
	Value string `json:"Value"`
}

type Registration struct {
	StateRoot         string
	Region            string
	RegisterCodeID    string
	RegisterCodeValue string
	Tags              []Tag
}

type Runtime interface {
	Register(context.Context, Registration) error
	Start(context.Context, string) (Handle, error)
}

type Handle interface {
	Close(context.Context) error
}

type runtime struct {
	bridge nativeBridge
}

type nativeBridge interface {
	register(
		stateRoot string,
		region string,
		registerCodeID string,
		registerCodeValue string,
		tagsJSON string,
	) error
	start(stateRoot string) (nativeHandle, error)
}

type nativeHandle interface {
	close() error
}

func New() Runtime {
	return newRuntime(defaultNativeBridge())
}

func newRuntime(bridge nativeBridge) Runtime {
	return &runtime{bridge: bridge}
}

func (r *runtime) Register(
	ctx context.Context,
	registration Registration,
) error {
	if err := validateRegistration(registration); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	tagsJSON, err := common.Marshal(registration.Tags)
	if err != nil {
		return err
	}
	return r.bridge.register(
		filepath.Clean(registration.StateRoot),
		registration.Region,
		registration.RegisterCodeID,
		registration.RegisterCodeValue,
		string(tagsJSON),
	)
}

func (r *runtime) Start(
	ctx context.Context,
	stateRoot string,
) (Handle, error) {
	if !validStateRoot(stateRoot) {
		return nil, ErrInvalidConfig
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	handle, err := r.bridge.start(filepath.Clean(stateRoot))
	if err != nil {
		return nil, err
	}
	if handle == nil {
		return nil, ErrNativeUnavailable
	}
	return &runtimeHandle{native: handle}, nil
}

func validateRegistration(value Registration) error {
	if !validStateRoot(value.StateRoot) ||
		strings.TrimSpace(value.Region) == "" ||
		strings.TrimSpace(value.RegisterCodeID) == "" ||
		strings.TrimSpace(value.RegisterCodeValue) == "" ||
		len(value.Tags) < 1 ||
		len(value.Tags) > 10 {
		return ErrInvalidConfig
	}
	for _, tag := range value.Tags {
		if strings.TrimSpace(tag.Key) == "" ||
			strings.TrimSpace(tag.Value) == "" {
			return ErrInvalidConfig
		}
	}
	return nil
}

func validStateRoot(value string) bool {
	return filepath.IsAbs(value) && filepath.Clean(value) == value
}

type runtimeHandle struct {
	mu     sync.Mutex
	native nativeHandle
}

func (h *runtimeHandle) Close(ctx context.Context) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.native == nil {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	err := h.native.close()
	if err == nil {
		h.native = nil
	}
	return err
}
