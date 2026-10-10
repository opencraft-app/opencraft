package nativemodule

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dop251/goja"
	"velachat/agent/internal/common"
)

var safeProviderCodePattern = regexp.MustCompile(`^sdk_[0-9]{1,10}$`)

const ProtocolV1 = "reactvaxis-native-module/v1"

var (
	ErrClosed            = errors.New("native module registry 已关闭")
	ErrQueueFull         = errors.New("native module subscription 队列已满")
	ErrUnknownCall       = errors.New("native module call 不存在")
	ErrUnknownTopic      = errors.New("native module topic 不存在")
	ErrDuplicateResource = errors.New("native module 资源重复注册")
	ErrDeadlineExceeded  = errors.New("native module 调用超时")
	ErrPayloadTooLarge   = errors.New("native module payload 超出限制")
	ErrInvalidDeadline   = errors.New("native module deadline 无效")
)

type codedError struct {
	cause error
	code  string
}

func (e codedError) Error() string      { return e.cause.Error() }
func (e codedError) Unwrap() error      { return e.cause }
func (e codedError) NativeCode() string { return e.code }

type CallHandler func(context.Context, any) (any, error)
type EmitFunc func(any) error
type TopicHandler func(context.Context, any, EmitFunc) error
type Scheduler func(func(*goja.Runtime)) bool

type Option func(*Registry)

func WithQueueCapacity(capacity int) Option {
	return func(registry *Registry) {
		if capacity > 0 {
			registry.queueCapacity = capacity
		}
	}
}

func WithMaxPayloadBytes(maxBytes int) Option {
	return func(registry *Registry) {
		if maxBytes > 0 {
			registry.maxPayloadBytes = maxBytes
		}
	}
}

type Registry struct {
	mu              sync.Mutex
	calls           map[string]CallHandler
	topics          map[string]TopicHandler
	subscriptions   map[string]*subscription
	schedule        Scheduler
	queueCapacity   int
	maxPayloadBytes int
	rootContext     context.Context
	cancel          context.CancelFunc
	closed          bool
}

type subscription struct {
	id       string
	launchID string
	cancel   context.CancelFunc
	queue    chan any
	once     sync.Once
	sequence atomic.Uint64
}

type callOptions struct {
	RequestID  string `json:"requestId"`
	DeadlineMS int64  `json:"deadlineMs"`
}

type subscribeOptions struct {
	SubscriptionID string `json:"subscriptionId"`
	LaunchID       string `json:"launchId"`
}

func NewRegistry(options ...Option) *Registry {
	rootContext, cancel := context.WithCancel(context.Background())
	registry := &Registry{
		calls:           make(map[string]CallHandler),
		topics:          make(map[string]TopicHandler),
		subscriptions:   make(map[string]*subscription),
		queueCapacity:   1024,
		maxPayloadBytes: 1 << 20,
		rootContext:     rootContext,
		cancel:          cancel,
	}
	for _, option := range options {
		option(registry)
	}
	return registry
}

func (r *Registry) Bind(schedule func(func(*goja.Runtime)) bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.schedule = schedule
}

func resourceKey(module, resource string) string { return module + "\x00" + resource }

func (r *Registry) RegisterCall(module, method string, handler CallHandler) {
	if module == "" || method == "" || handler == nil {
		panic("native module call 注册参数非法")
	}
	key := resourceKey(module, method)
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.calls[key]; exists {
		panic(fmt.Errorf("%w: %s.%s", ErrDuplicateResource, module, method))
	}
	r.calls[key] = handler
}

func (r *Registry) RegisterTopic(module, topic string, handler TopicHandler) {
	if module == "" || topic == "" || handler == nil {
		panic("native module topic 注册参数非法")
	}
	key := resourceKey(module, topic)
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.topics[key]; exists {
		panic(fmt.Errorf("%w: %s.%s", ErrDuplicateResource, module, topic))
	}
	r.topics[key] = handler
}

func (r *Registry) Install(vm *goja.Runtime) error {
	r.mu.Lock()
	bound := r.schedule != nil
	closed := r.closed
	r.mu.Unlock()
	if !bound {
		return errors.New("native module registry 尚未绑定 UI event loop")
	}
	if closed {
		return ErrClosed
	}
	bridge := map[string]any{
		"protocol": ProtocolV1,
		"call": func(call goja.FunctionCall) goja.Value {
			return r.call(vm, call)
		},
		"subscribe": func(call goja.FunctionCall) goja.Value {
			if err := r.subscribe(vm, call); err != nil {
				panic(vm.NewGoError(err))
			}
			return call.Argument(3).ToObject(vm).Get("subscriptionId")
		},
		"unsubscribe": func(call goja.FunctionCall) goja.Value {
			r.unsubscribe(call.Argument(0).String())
			return goja.Undefined()
		},
	}
	return vm.Set("__velaNativeModules", bridge)
}

func (r *Registry) call(vm *goja.Runtime, call goja.FunctionCall) goja.Value {
	module := call.Argument(0).String()
	method := call.Argument(1).String()
	payload := exportValue(vm, call.Argument(2))
	var options callOptions
	_ = vm.ExportTo(call.Argument(3), &options)

	promise, resolve, reject := vm.NewPromise()
	r.mu.Lock()
	handler := r.calls[resourceKey(module, method)]
	rootContext := r.rootContext
	closed := r.closed
	maxPayloadBytes := r.maxPayloadBytes
	r.mu.Unlock()
	if closed || handler == nil {
		err := ErrUnknownCall
		if closed {
			err = ErrClosed
		}
		_ = reject(nativeError(vm, err, options.RequestID, false))
		return vm.ToValue(promise)
	}
	if options.DeadlineMS < 0 || options.DeadlineMS > int64((5*time.Minute)/time.Millisecond) {
		err := codedError{cause: ErrInvalidDeadline, code: "NATIVE_INVALID_ARGUMENT"}
		_ = reject(nativeError(vm, err, options.RequestID, false))
		return vm.ToValue(promise)
	}
	encoded, err := common.Marshal(payload)
	if err != nil {
		err := codedError{cause: err, code: "NATIVE_INVALID_ARGUMENT"}
		_ = reject(nativeError(vm, err, options.RequestID, false))
		return vm.ToValue(promise)
	}
	if len(encoded) > maxPayloadBytes {
		err := codedError{cause: ErrPayloadTooLarge, code: "NATIVE_PAYLOAD_TOO_LARGE"}
		_ = reject(nativeError(vm, err, options.RequestID, false))
		return vm.ToValue(promise)
	}
	handlerContext := rootContext
	cancel := func() {}
	if options.DeadlineMS > 0 {
		handlerContext, cancel = context.WithTimeout(
			rootContext,
			time.Duration(options.DeadlineMS)*time.Millisecond,
		)
	}
	go func() {
		defer cancel()
		result, err := handler(handlerContext, payload)
		var wireResult any
		if errors.Is(err, context.DeadlineExceeded) {
			err = codedError{cause: ErrDeadlineExceeded, code: "NATIVE_DEADLINE_EXCEEDED"}
		} else if errors.Is(err, context.Canceled) {
			err = codedError{cause: context.Canceled, code: "NATIVE_CALL_CANCELED"}
		}
		if err == nil {
			encoded, encodeErr := common.Marshal(result)
			if encodeErr != nil {
				err = codedError{cause: encodeErr, code: "NATIVE_INVALID_RESULT"}
			} else if len(encoded) > maxPayloadBytes {
				err = codedError{cause: ErrPayloadTooLarge, code: "NATIVE_RESULT_TOO_LARGE"}
			} else if decodeErr := common.Unmarshal(encoded, &wireResult); decodeErr != nil {
				err = codedError{cause: decodeErr, code: "NATIVE_INVALID_RESULT"}
			}
		}
		r.scheduleOnLoop(func(vm *goja.Runtime) {
			if err != nil {
				_ = reject(nativeError(vm, err, options.RequestID, true))
				return
			}
			_ = resolve(wireResult)
		})
	}()
	return vm.ToValue(promise)
}

func (r *Registry) subscribe(vm *goja.Runtime, call goja.FunctionCall) error {
	module := call.Argument(0).String()
	topic := call.Argument(1).String()
	payload := exportValue(vm, call.Argument(2))
	var options subscribeOptions
	if err := vm.ExportTo(call.Argument(3), &options); err != nil {
		return fmt.Errorf("解析 subscription options: %w", err)
	}
	if options.SubscriptionID == "" || options.LaunchID == "" {
		return errors.New("subscriptionId 和 launchId 必填")
	}
	r.mu.Lock()
	maxPayloadBytes := r.maxPayloadBytes
	r.mu.Unlock()
	encoded, err := common.Marshal(payload)
	if err != nil {
		return fmt.Errorf("subscription payload 非法: %w", err)
	}
	if len(encoded) > maxPayloadBytes {
		return codedError{cause: ErrPayloadTooLarge, code: "NATIVE_PAYLOAD_TOO_LARGE"}
	}

	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return ErrClosed
	}
	handler := r.topics[resourceKey(module, topic)]
	if handler == nil {
		r.mu.Unlock()
		return ErrUnknownTopic
	}
	if _, exists := r.subscriptions[options.SubscriptionID]; exists {
		r.mu.Unlock()
		return fmt.Errorf("subscriptionId 已存在: %s", options.SubscriptionID)
	}
	ctx, cancel := context.WithCancel(r.rootContext)
	sub := &subscription{
		id: options.SubscriptionID, launchID: options.LaunchID,
		cancel: cancel, queue: make(chan any, r.queueCapacity),
	}
	r.subscriptions[sub.id] = sub
	r.mu.Unlock()

	go r.drain(ctx, sub)
	go func() {
		err := handler(ctx, payload, func(value any) error {
			encoded, encodeErr := common.Marshal(value)
			if encodeErr != nil || len(encoded) > maxPayloadBytes {
				r.requireResync(sub, "payload_too_large")
				if encodeErr != nil {
					return encodeErr
				}
				return ErrPayloadTooLarge
			}
			select {
			case sub.queue <- value:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			default:
				r.requireResync(sub, "queue_overflow")
				return ErrQueueFull
			}
		})
		if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, ErrQueueFull) {
			r.failSubscription(sub, map[string]any{
				"kind": "error", "subscriptionId": sub.id, "launchId": sub.launchID,
				"error": map[string]any{"code": "NATIVE_SUBSCRIPTION_FAILED", "message": err.Error(), "retryable": true},
			})
		}
	}()
	return nil
}

func (r *Registry) drain(ctx context.Context, sub *subscription) {
	for {
		select {
		case value := <-sub.queue:
			completed := make(chan struct{})
			if !r.scheduleOnLoop(func(vm *goja.Runtime) {
				defer close(completed)
				if ctx.Err() != nil || !r.subscriptionActive(sub) {
					return
				}
				sequence := sub.sequence.Add(1)
				r.invokeDispatch(vm, map[string]any{
					"kind": "event", "subscriptionId": sub.id, "launchId": sub.launchID,
					"sequence": sequence, "payload": value,
				})
			}) {
				return
			}
			select {
			case <-completed:
			case <-ctx.Done():
				return
			}
		case <-ctx.Done():
			return
		}
	}
}

func (r *Registry) requireResync(sub *subscription, reason string) {
	sub.once.Do(func() {
		sub.cancel()
		r.removeSubscription(sub)
		r.dispatch(map[string]any{
			"kind": "resync_required", "subscriptionId": sub.id,
			"launchId": sub.launchID, "reason": reason,
			"lastSequence": sub.sequence.Load(),
		})
	})
}

func (r *Registry) failSubscription(sub *subscription, event map[string]any) {
	sub.once.Do(func() {
		sub.cancel()
		r.removeSubscription(sub)
		r.dispatch(event)
	})
}

func (r *Registry) removeSubscription(sub *subscription) {
	r.mu.Lock()
	if r.subscriptions[sub.id] == sub {
		delete(r.subscriptions, sub.id)
	}
	r.mu.Unlock()
}

func (r *Registry) subscriptionActive(sub *subscription) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return !r.closed && r.subscriptions[sub.id] == sub
}

func (r *Registry) dispatch(event map[string]any) {
	r.scheduleOnLoop(func(vm *goja.Runtime) {
		r.invokeDispatch(vm, event)
	})
}

func (r *Registry) invokeDispatch(vm *goja.Runtime, event map[string]any) {
	dispatch, ok := goja.AssertFunction(vm.Get("__velaNativeModuleDispatch"))
	if !ok {
		return
	}
	_, _ = dispatch(goja.Undefined(), vm.ToValue(event))
}

func (r *Registry) scheduleOnLoop(callback func(*goja.Runtime)) bool {
	r.mu.Lock()
	schedule := r.schedule
	closed := r.closed
	r.mu.Unlock()
	if closed || schedule == nil {
		return false
	}
	return schedule(callback)
}

func (r *Registry) unsubscribe(id string) {
	r.mu.Lock()
	sub := r.subscriptions[id]
	delete(r.subscriptions, id)
	r.mu.Unlock()
	if sub != nil {
		sub.once.Do(sub.cancel)
	}
}

func (r *Registry) Close() {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	r.cancel()
	subscriptions := r.subscriptions
	r.subscriptions = make(map[string]*subscription)
	r.mu.Unlock()
	for _, sub := range subscriptions {
		sub.once.Do(sub.cancel)
	}
}

func exportValue(vm *goja.Runtime, value goja.Value) any {
	if goja.IsUndefined(value) || goja.IsNull(value) {
		return nil
	}
	var exported any
	if err := vm.ExportTo(value, &exported); err != nil {
		return nil
	}
	return exported
}

func nativeError(vm *goja.Runtime, err error, requestID string, retryable bool) goja.Value {
	code := "NATIVE_CALL_FAILED"
	if coded, ok := err.(interface{ NativeCode() string }); ok && coded.NativeCode() != "" {
		code = coded.NativeCode()
	}
	message := err.Error()
	providerCode := ""
	var provider interface{ SafeCode() string }
	if errors.As(err, &provider) && safeProviderCodePattern.MatchString(provider.SafeCode()) {
		providerCode = provider.SafeCode()
		message = "消息服务请求失败"
	}
	value := map[string]any{
		"code": code, "message": message,
		"retryable": retryable, "requestId": requestID,
	}
	if providerCode != "" {
		value["providerCode"] = providerCode
	}
	return vm.ToValue(value)
}
