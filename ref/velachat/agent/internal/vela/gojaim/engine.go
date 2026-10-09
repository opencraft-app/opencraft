package gojaim

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dop251/goja"
	"github.com/dop251/goja_nodejs/eventloop"
)

type CommandRejectionError struct {
	code   string
	detail string
}

func (e *CommandRejectionError) Error() string {
	return ErrCommandRejected.Error() + " (" + e.SafeCode() + ")"
}

func (e *CommandRejectionError) Unwrap() error {
	return ErrCommandRejected
}

func (e *CommandRejectionError) SafeCode() string {
	if e == nil || e.code == "" {
		return "command_rejected"
	}
	return e.code
}

func (e *CommandRejectionError) SafeDetail() string {
	if e == nil {
		return ""
	}
	return e.detail
}

var (
	commandDiagnosticURL    = regexp.MustCompile(`(?i)\b(?:https?|wss?)://\S+`)
	commandDiagnosticSecret = regexp.MustCompile(
		`(?i)\b(?:authorization|bearer|token|secret|signature|usersig|signed[-_ ]?url|sig)\b\s*[:=]?\s*\S+`,
	)
	commandDiagnosticOpaque = regexp.MustCompile(`[A-Za-z0-9_./+=-]{20,}`)
)

var (
	ErrInvalidConfig   = errors.New("Goja IM Engine 配置无效")
	ErrEngineClosed    = errors.New("Goja IM Engine 已关闭")
	ErrHostUnavailable = errors.New("Goja IM 宿主能力不可用")
	ErrCommandRejected = errors.New("LiteChat 命令被拒绝")
)

type SocketEvent struct {
	Type   string `json:"type"`
	Data   any    `json:"data,omitempty"`
	Code   int    `json:"code,omitempty"`
	Reason string `json:"reason,omitempty"`
}

type FetchRequest struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    any               `json:"body,omitempty"`
}

type FetchResult struct {
	Status     int               `json:"status"`
	StatusText string            `json:"status_text,omitempty"`
	Headers    map[string]string `json:"headers,omitempty"`
	Body       string            `json:"body"`
	Error      string            `json:"error,omitempty"`
}

type RuntimeEvent struct {
	Type string `json:"type"`
	Data any    `json:"data,omitempty"`
}

type Host interface {
	OpenWebSocket(
		context.Context,
		string,
		func(SocketEvent),
	) (uint64, error)
	SendWebSocket(context.Context, uint64, []byte) error
	CloseWebSocket(context.Context, uint64) error
	StartFetch(
		context.Context,
		FetchRequest,
		func(FetchResult),
	) (uint64, error)
	AbortFetch(context.Context, uint64) error
}

type RejectingHost struct{}

func (RejectingHost) OpenWebSocket(
	context.Context,
	string,
	func(SocketEvent),
) (uint64, error) {
	return 0, ErrHostUnavailable
}

func (RejectingHost) SendWebSocket(
	context.Context,
	uint64,
	[]byte,
) error {
	return ErrHostUnavailable
}

func (RejectingHost) CloseWebSocket(
	context.Context,
	uint64,
) error {
	return ErrHostUnavailable
}

func (RejectingHost) StartFetch(
	context.Context,
	FetchRequest,
	func(FetchResult),
) (uint64, error) {
	return 0, ErrHostUnavailable
}

func (RejectingHost) AbortFetch(
	context.Context,
	uint64,
) error {
	return ErrHostUnavailable
}

type Config struct {
	SDKAppID int
	Host     Host
	Timeout  time.Duration
}

type Engine struct {
	loop     *eventloop.EventLoop
	host     Host
	ctx      context.Context
	cancel   context.CancelFunc
	clientID string

	closeOnce sync.Once
	closed    chan struct{}
}

type engineInitResult struct {
	clientID string
	err      error
}

type commandResult struct {
	value any
	err   error
}

func NewEngine(config Config) (*Engine, error) {
	if config.SDKAppID <= 0 || config.Host == nil {
		return nil, ErrInvalidConfig
	}
	timeout := config.Timeout
	if timeout <= 0 {
		timeout = probeTimeout
	}
	if err := ValidateBundle(EmbeddedBundle()); err != nil {
		return nil, err
	}

	ctx, cancel := context.WithCancel(context.Background())
	engine := &Engine{
		loop:   eventloop.NewEventLoop(eventloop.EnableConsole(false)),
		host:   config.Host,
		ctx:    ctx,
		cancel: cancel,
		closed: make(chan struct{}),
	}
	engine.loop.Start()

	result := make(chan engineInitResult, 1)
	if !engine.loop.RunOnLoop(func(vm *goja.Runtime) {
		clientID, err := engine.initialize(vm, config.SDKAppID)
		result <- engineInitResult{clientID: clientID, err: err}
	}) {
		engine.terminate()
		return nil, ErrEngineClosed
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case initialized := <-result:
		if initialized.err != nil {
			engine.terminate()
			return nil, initialized.err
		}
		engine.clientID = initialized.clientID
		return engine, nil
	case <-timer.C:
		engine.terminate()
		return nil, fmt.Errorf("%w: initialization timeout", ErrInvalidBundle)
	}
}

func (e *Engine) ClientID() string {
	return e.clientID
}

func (e *Engine) Command(
	ctx context.Context,
	request map[string]any,
) (any, error) {
	result, err := e.BeginCommand(request)
	if err != nil {
		return nil, err
	}
	select {
	case completed := <-result:
		return completed.value, completed.err
	case <-e.closed:
		return nil, ErrEngineClosed
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// BeginCommand schedules a JavaScript command on the owning event loop and
// returns its eventual result without waiting for a returned Promise. Login is
// deliberately started this way because LiteChat may keep its Promise pending
// until initial conversation synchronization is complete, while its session is
// already usable through the conversation API.
func (e *Engine) BeginCommand(
	request map[string]any,
) (<-chan commandResult, error) {
	result := make(chan commandResult, 1)
	if !e.loop.RunOnLoop(func(vm *goja.Runtime) {
		e.invokeCommand(vm, request, result)
	}) {
		return nil, ErrEngineClosed
	}
	return result, nil
}

func (e *Engine) DrainEvents(
	ctx context.Context,
) ([]RuntimeEvent, error) {
	type drainResult struct {
		events []RuntimeEvent
		err    error
	}
	result := make(chan drainResult, 1)
	if !e.loop.RunOnLoop(func(vm *goja.Runtime) {
		facade, ok := vm.Get("__velaLiteChat").(*goja.Object)
		if !ok {
			result <- drainResult{err: ErrInvalidBundle}
			return
		}
		drain, ok := goja.AssertFunction(facade.Get("drainEvents"))
		if !ok {
			result <- drainResult{err: ErrInvalidBundle}
			return
		}
		value, err := drain(
			goja.Undefined(),
			vm.ToValue(e.clientID),
		)
		if err != nil {
			result <- drainResult{err: ErrCommandRejected}
			return
		}
		var events []RuntimeEvent
		if err := vm.ExportTo(value, &events); err != nil {
			result <- drainResult{err: ErrCommandRejected}
			return
		}
		result <- drainResult{events: events}
	}) {
		return nil, ErrEngineClosed
	}
	select {
	case completed := <-result:
		return completed.events, completed.err
	case <-e.closed:
		return nil, ErrEngineClosed
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (e *Engine) Close(ctx context.Context) error {
	e.closeOnce.Do(func() {
		go e.terminate()
	})
	select {
	case <-e.closed:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (e *Engine) invokeCommand(
	vm *goja.Runtime,
	request map[string]any,
	result chan<- commandResult,
) {
	finish := func(completed commandResult) {
		select {
		case result <- completed:
		default:
		}
	}
	facade, ok := vm.Get("__velaLiteChat").(*goja.Object)
	if !ok {
		finish(commandResult{err: ErrInvalidBundle})
		return
	}
	command, ok := goja.AssertFunction(facade.Get("command"))
	if !ok {
		finish(commandResult{err: ErrInvalidBundle})
		return
	}
	value, err := command(
		goja.Undefined(),
		vm.ToValue(e.clientID),
		vm.ToValue(request),
	)
	if err != nil {
		if exception, ok := err.(*goja.Exception); ok {
			finish(commandResult{err: classifyCommandRejection(vm, exception.Value())})
		} else {
			finish(commandResult{err: &CommandRejectionError{code: "command_rejected"}})
		}
		return
	}
	then, isPromise := goja.AssertFunction(
		value.ToObject(vm).Get("then"),
	)
	if !isPromise {
		finish(commandResult{value: value.Export()})
		return
	}
	fulfilled := vm.ToValue(func(call goja.FunctionCall) goja.Value {
		finish(commandResult{value: call.Argument(0).Export()})
		return goja.Undefined()
	})
	rejected := vm.ToValue(func(call goja.FunctionCall) goja.Value {
		finish(commandResult{err: classifyCommandRejection(vm, call.Argument(0))})
		return goja.Undefined()
	})
	if _, err := then(value, fulfilled, rejected); err != nil {
		finish(commandResult{err: ErrCommandRejected})
	}
}

func classifyCommandRejection(
	vm *goja.Runtime,
	value goja.Value,
) *CommandRejectionError {
	values := rejectionDiagnosticValues(vm, value)
	for _, candidate := range values {
		if code := safeSDKCode(vm, candidate); code != "" {
			return &CommandRejectionError{code: "sdk_" + strings.ToLower(code)}
		}
	}
	reasons := make([]string, 0, len(values))
	for _, candidate := range values {
		if candidate != nil && !goja.IsUndefined(candidate) && !goja.IsNull(candidate) {
			reasons = append(reasons, candidate.String())
		}
	}
	reason := strings.Join(reasons, " ")
	for fragment, code := range map[string]string{
		"网络目标不在允许列表":                "endpoint_denied",
		"unsupported fetch payload": "invalid_fetch_payload",
		"FileReader is not defined": "missing_file_reader",
		"Blob is not defined":       "missing_blob",
		"Invalid file":              "invalid_file",
	} {
		if strings.Contains(reason, fragment) {
			return &CommandRejectionError{
				code: code, detail: safeCommandDiagnosticDetail(reason),
			}
		}
	}
	return &CommandRejectionError{
		code: "command_rejected", detail: safeCommandDiagnosticDetail(reason),
	}
}

func safeCommandDiagnosticDetail(reason string) string {
	reason = commandDiagnosticURL.ReplaceAllString(reason, "[url-redacted]")
	reason = commandDiagnosticSecret.ReplaceAllString(reason, "[secret-redacted]")
	reason = commandDiagnosticOpaque.ReplaceAllString(reason, "[opaque-redacted]")
	var sanitized strings.Builder
	for _, character := range reason {
		if character >= 0x20 && character <= 0x7e {
			sanitized.WriteRune(character)
		} else {
			sanitized.WriteByte(' ')
		}
	}
	detail := strings.Join(strings.Fields(sanitized.String()), " ")
	detail = strings.TrimSpace(strings.ReplaceAll(detail, "[object Object]", ""))
	if len(detail) > 160 {
		detail = strings.TrimSpace(detail[:160])
	}
	return detail
}

func rejectionDiagnosticValues(vm *goja.Runtime, root goja.Value) []goja.Value {
	values := make([]goja.Value, 0, 12)
	seen := make(map[*goja.Object]struct{})
	var visit func(goja.Value, int)
	visit = func(value goja.Value, depth int) {
		if value == nil || goja.IsUndefined(value) || goja.IsNull(value) || depth > 3 {
			return
		}
		values = append(values, value)
		object := value.ToObject(vm)
		if object == nil {
			return
		}
		if _, duplicate := seen[object]; duplicate {
			return
		}
		seen[object] = struct{}{}
		for _, field := range []string{
			"message", "errorMessage", "reason", "cause", "error", "data",
		} {
			visit(object.Get(field), depth+1)
		}
	}
	visit(root, 0)
	return values
}

func safeSDKCode(vm *goja.Runtime, value goja.Value) string {
	if value == nil || goja.IsUndefined(value) || goja.IsNull(value) {
		return ""
	}
	object := value.ToObject(vm)
	if object == nil {
		return ""
	}
	var raw any
	for _, field := range []string{"code", "errorCode", "error_code"} {
		candidate := object.Get(field)
		if candidate == nil || goja.IsUndefined(candidate) || goja.IsNull(candidate) {
			continue
		}
		raw = candidate.Export()
		break
	}
	var code string
	switch typed := raw.(type) {
	case string:
		code = strings.TrimSpace(typed)
	case int:
		code = strconv.Itoa(typed)
	case int64:
		code = strconv.FormatInt(typed, 10)
	case float64:
		if typed == float64(int64(typed)) {
			code = strconv.FormatInt(int64(typed), 10)
		}
	}
	if code == "" || len(code) > 32 {
		return ""
	}
	for _, character := range code {
		if character < '0' || character > '9' {
			return ""
		}
	}
	return code
}

func (e *Engine) terminate() {
	e.cancel()
	e.loop.Terminate()
	close(e.closed)
}

func (e *Engine) initialize(
	vm *goja.Runtime,
	sdkAppID int,
) (string, error) {
	vm.SetFieldNameMapper(goja.TagFieldNameMapper("json", true))
	if err := e.installHost(vm); err != nil {
		return "", err
	}
	if _, err := vm.RunString(EmbeddedBundle()); err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidBundle, err)
	}
	facade, ok := vm.Get("__velaLiteChat").(*goja.Object)
	if !ok {
		return "", ErrInvalidBundle
	}
	create, ok := goja.AssertFunction(facade.Get("create"))
	if !ok {
		return "", ErrInvalidBundle
	}
	value, err := create(
		goja.Undefined(),
		vm.ToValue(map[string]any{"SDKAppID": sdkAppID}),
	)
	if err != nil {
		return "", fmt.Errorf("%w: create: %v", ErrInvalidBundle, err)
	}
	return value.String(), nil
}

func (e *Engine) installHost(vm *goja.Runtime) error {
	websocket := map[string]any{
		"open": func(call goja.FunctionCall) goja.Value {
			url := call.Argument(0).String()
			callback, ok := goja.AssertFunction(call.Argument(1))
			if !ok {
				panic(vm.NewTypeError("websocket callback is required"))
			}
			id, err := e.host.OpenWebSocket(
				e.ctx,
				url,
				func(event SocketEvent) {
					e.loop.RunOnLoop(func(owner *goja.Runtime) {
						_, _ = callback(
							goja.Undefined(),
							socketEventValue(owner, event),
						)
					})
				},
			)
			if err != nil {
				panic(vm.NewGoError(err))
			}
			return vm.ToValue(id)
		},
		"send": func(call goja.FunctionCall) goja.Value {
			id := uint64(call.Argument(0).ToInteger())
			payload, err := exportBytes(call.Argument(1))
			if err != nil {
				panic(vm.NewTypeError(err.Error()))
			}
			if err := e.host.SendWebSocket(e.ctx, id, payload); err != nil {
				panic(vm.NewGoError(err))
			}
			return goja.Undefined()
		},
		"close": func(call goja.FunctionCall) goja.Value {
			id := uint64(call.Argument(0).ToInteger())
			if err := e.host.CloseWebSocket(e.ctx, id); err != nil {
				panic(vm.NewGoError(err))
			}
			return goja.Undefined()
		},
	}
	fetch := map[string]any{
		"start": func(call goja.FunctionCall) goja.Value {
			var request FetchRequest
			if err := vm.ExportTo(call.Argument(0), &request); err != nil {
				panic(vm.NewTypeError(err.Error()))
			}
			body, err := normalizeFetchBody(request.Body)
			if err != nil {
				panic(vm.NewTypeError(err.Error()))
			}
			request.Body = body
			callback, ok := goja.AssertFunction(call.Argument(1))
			if !ok {
				panic(vm.NewTypeError("fetch callback is required"))
			}
			id, err := e.host.StartFetch(
				e.ctx,
				request,
				func(result FetchResult) {
					e.loop.RunOnLoop(func(owner *goja.Runtime) {
						_, _ = callback(
							goja.Undefined(),
							owner.ToValue(result),
						)
					})
				},
			)
			if err != nil {
				panic(vm.NewGoError(err))
			}
			return vm.ToValue(id)
		},
		"abort": func(call goja.FunctionCall) goja.Value {
			id := uint64(call.Argument(0).ToInteger())
			if err := e.host.AbortFetch(e.ctx, id); err != nil {
				panic(vm.NewGoError(err))
			}
			return goja.Undefined()
		},
	}
	return vm.Set("__velaHost", map[string]any{
		"websocket": websocket,
		"fetch":     fetch,
	})
}

func normalizeFetchBody(value any) (any, error) {
	switch body := value.(type) {
	case nil:
		return nil, nil
	case string:
		return body, nil
	case []byte:
		return append([]byte(nil), body...), nil
	case goja.ArrayBuffer:
		return append([]byte(nil), body.Bytes()...), nil
	default:
		return nil, fmt.Errorf("unsupported fetch payload %T", value)
	}
}

func exportBytes(value goja.Value) ([]byte, error) {
	switch exported := value.Export().(type) {
	case []byte:
		return append([]byte(nil), exported...), nil
	case string:
		return []byte(exported), nil
	case goja.ArrayBuffer:
		return append([]byte(nil), exported.Bytes()...), nil
	default:
		return nil, fmt.Errorf(
			"unsupported websocket payload %T",
			exported,
		)
	}
}

func socketEventValue(
	vm *goja.Runtime,
	event SocketEvent,
) goja.Value {
	value := map[string]any{"type": event.Type}
	if event.Code != 0 {
		value["code"] = event.Code
	}
	if event.Reason != "" {
		value["reason"] = event.Reason
	}
	if payload, ok := event.Data.([]byte); ok {
		value["data"] = vm.NewArrayBuffer(
			append([]byte(nil), payload...),
		)
	} else if event.Data != nil {
		value["data"] = event.Data
	}
	return vm.ToValue(value)
}
