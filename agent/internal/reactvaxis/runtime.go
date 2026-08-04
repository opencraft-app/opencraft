package reactvaxis

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/dop251/goja"
	"github.com/dop251/goja_nodejs/eventloop"
)

const (
	ProtocolV1 = "reactvaxis/v1"
	ProtocolV2 = "reactvaxis/v2"
)

var ErrRuntimeClosed = errors.New("ReactVaxis runtime 已关闭")

// Bundle is a versioned JavaScript application artifact. SHA256 is mandatory:
// a Go binary must never execute a bundle different from the one it shipped.
type Bundle struct {
	Name     string
	Source   string
	SHA256   string
	Protocol string
}

// Installer adds a trusted native module to the isolated UI VM.
// Implementations must not retain or use the runtime from another goroutine.
type Installer interface {
	Install(*goja.Runtime) error
}

// LoopBinder is implemented by asynchronous native bridges. Every callback
// touching goja must return through this scheduler.
type LoopBinder interface {
	Bind(func(func(*goja.Runtime)) bool)
}

type InstallerCloser interface {
	Close()
}

type RuntimeConfig struct {
	Bundle     Bundle
	Installers []Installer
	Commits    int
}

// Runtime owns one isolated JavaScript event loop. It deliberately shares no
// VM state with the Tencent IM runtime.
type Runtime struct {
	loop    *eventloop.EventLoop
	commits chan *NativeNode
	errors  chan error
	done    chan struct{}
	once    sync.Once
	closers []InstallerCloser
}

func NewRuntime(config RuntimeConfig) (*Runtime, error) {
	if err := validateBundle(config.Bundle); err != nil {
		return nil, err
	}
	commitCapacity := config.Commits
	if commitCapacity <= 0 {
		commitCapacity = 1
	}
	runtime := &Runtime{
		loop:    eventloop.NewEventLoop(eventloop.EnableConsole(false)),
		commits: make(chan *NativeNode, commitCapacity),
		errors:  make(chan error, 1),
		done:    make(chan struct{}),
	}
	runtime.loop.Start()
	for _, installer := range config.Installers {
		if binder, ok := installer.(LoopBinder); ok {
			binder.Bind(runtime.loop.RunOnLoop)
		}
		if closer, ok := installer.(InstallerCloser); ok {
			runtime.closers = append(runtime.closers, closer)
		}
	}

	initialized := make(chan error, 1)
	if !runtime.loop.RunOnLoop(func(vm *goja.Runtime) {
		vm.SetFieldNameMapper(goja.TagFieldNameMapper("json", true))
		bridge := map[string]any{
			"commit": func(call goja.FunctionCall) goja.Value {
				var tree NativeNode
				if err := vm.ExportTo(call.Argument(0), &tree); err != nil {
					runtime.report(fmt.Errorf("导出 React commit: %w", err))
					return goja.Undefined()
				}
				runtime.publish(&tree)
				return goja.Undefined()
			},
		}
		if err := vm.Set("__raftNative", bridge); err != nil {
			initialized <- fmt.Errorf("安装 ReactVaxis bridge: %w", err)
			return
		}
		for _, installer := range config.Installers {
			if installer == nil {
				continue
			}
			if err := installer.Install(vm); err != nil {
				initialized <- fmt.Errorf("安装 native module: %w", err)
				return
			}
		}
		if _, err := vm.RunString(config.Bundle.Source); err != nil {
			initialized <- fmt.Errorf("执行 %s bundle: %w", config.Bundle.Name, err)
			return
		}
		facade, ok := vm.Get("__raftTui").(*goja.Object)
		if !ok {
			initialized <- errors.New("ReactVaxis bundle 未导出 __raftTui")
			return
		}
		if config.Bundle.Protocol == ProtocolV2 {
			declared := facade.Get("protocol")
			declaredText := "<missing>"
			if declared != nil && !goja.IsUndefined(declared) && !goja.IsNull(declared) {
				declaredText = declared.String()
			}
			if declaredText != ProtocolV2 {
				initialized <- fmt.Errorf(
					"ReactVaxis bundle 协议自声明不一致: got %q want %q",
					declaredText,
					ProtocolV2,
				)
				return
			}
		}
		start, ok := goja.AssertFunction(facade.Get("start"))
		if !ok {
			initialized <- errors.New("ReactVaxis bundle 未导出 start()")
			return
		}
		if _, err := start(facade); err != nil {
			initialized <- fmt.Errorf("首次 React render: %w", err)
			return
		}
		initialized <- nil
	}) {
		runtime.Close()
		return nil, ErrRuntimeClosed
	}
	if err := <-initialized; err != nil {
		runtime.Close()
		return nil, err
	}
	return runtime, nil
}

func validateBundle(bundle Bundle) error {
	if strings.TrimSpace(bundle.Name) == "" {
		return errors.New("ReactVaxis bundle 缺少名称")
	}
	if bundle.Protocol != ProtocolV1 && bundle.Protocol != ProtocolV2 {
		return fmt.Errorf(
			"ReactVaxis 协议不兼容: got %q want %q or %q",
			bundle.Protocol,
			ProtocolV1,
			ProtocolV2,
		)
	}
	provided, err := hex.DecodeString(bundle.SHA256)
	if err != nil || len(provided) != sha256.Size {
		return errors.New("ReactVaxis bundle SHA-256 非法")
	}
	digest := sha256.Sum256([]byte(bundle.Source))
	if !equalBytes(provided, digest[:]) {
		return errors.New("ReactVaxis bundle SHA-256 校验失败")
	}
	return nil
}

func equalBytes(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	var different byte
	for index := range left {
		different |= left[index] ^ right[index]
	}
	return different == 0
}

func (r *Runtime) NextCommit(ctx context.Context) (*NativeNode, error) {
	select {
	case tree := <-r.commits:
		return tree, nil
	case err := <-r.errors:
		return nil, err
	case <-r.done:
		return nil, ErrRuntimeClosed
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (r *Runtime) Dispatch(handlerID string, payload map[string]any) {
	if handlerID == "" {
		return
	}
	if !r.loop.RunOnLoop(func(vm *goja.Runtime) {
		facade, ok := vm.Get("__raftTui").(*goja.Object)
		if !ok {
			r.report(errors.New("__raftTui 已丢失"))
			return
		}
		dispatch, ok := goja.AssertFunction(facade.Get("dispatch"))
		if !ok {
			r.report(errors.New("__raftTui.dispatch 不可调用"))
			return
		}
		if _, err := dispatch(facade, vm.ToValue(handlerID), vm.ToValue(payload)); err != nil {
			r.report(fmt.Errorf("React 事件回流失败: %w", err))
		}
	}) {
		r.report(ErrRuntimeClosed)
	}
}

func (r *Runtime) Resize(width, height int) {
	if width <= 0 || height <= 0 {
		return
	}
	if !r.loop.RunOnLoop(func(vm *goja.Runtime) {
		facade, ok := vm.Get("__raftTui").(*goja.Object)
		if !ok {
			r.report(errors.New("__raftTui 已丢失"))
			return
		}
		resize, ok := goja.AssertFunction(facade.Get("resize"))
		if !ok {
			r.report(errors.New("__raftTui.resize 不可调用"))
			return
		}
		if _, err := resize(facade, vm.ToValue(width), vm.ToValue(height)); err != nil {
			r.report(fmt.Errorf("React resize 回流失败: %w", err))
		}
	}) {
		r.report(ErrRuntimeClosed)
	}
}

func (r *Runtime) Close() {
	r.once.Do(func() {
		for _, closer := range r.closers {
			closer.Close()
		}
		r.loop.Terminate()
		close(r.done)
	})
}

func (r *Runtime) publish(tree *NativeNode) {
	select {
	case r.commits <- tree:
		return
	default:
	}
	select {
	case <-r.commits:
	default:
	}
	select {
	case r.commits <- tree:
	case <-r.done:
	}
}

func (r *Runtime) report(err error) {
	select {
	case r.errors <- err:
	default:
	}
}
