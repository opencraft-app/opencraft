package policy

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
	"hypernode/internal/modelgateway"
	goja "hypernode/internal/policy/jsvm"
	"hypernode/internal/telemetry"
	"hypernode/internal/workspaces"
)

const maxHotUpgradeBundleSize = 8 << 20

type Engine struct {
	mu   sync.Mutex
	vm   *goja.Runtime
	host *hostRuntime
}

type Decision struct {
	Allow           bool   `json:"allow"`
	Sensitive       bool   `json:"sensitive"`
	CloseAfterWrite bool   `json:"closeAfterWrite"`
	Stdout          string `json:"stdout"`
	StdoutBytes     []byte `json:"stdoutBytes"`
	Stderr          string `json:"stderr"`
	ExitCode        int    `json:"exitCode"`
	Stream          string `json:"stream"`
}

type StateStore interface {
	Get(namespace, key string) (string, bool, error)
	Set(namespace, key, value string) error
	Delete(namespace, key string) (bool, error)
	GetOrInsert(namespace, key, value string) (string, error)
}

type RuntimeConfig struct {
	AuthenticationMode     string
	LocalhostRoot          string
	CodexExecutable        string
	UsersRoot              string
	EnforceUserCredentials bool
	RemoteControlBaseURL   string
	WorkspaceManager       *workspaces.Manager
	WorkspaceDriver        string
	ModelGateway           *modelgateway.Registry
	ModelGatewayBaseURL    string
	JavaScriptExecutable   string
	JavaScriptRuntimeRoot  string
	Telemetry              *telemetry.Manager
	// WorkspaceAgent enables the narrowly scoped interactive PTY primitive used
	// by the private workspace attachment endpoint. It is never enabled on the
	// outer HyperNode policy host.
	WorkspaceAgent bool
}

func New(path, expectedPassword string) (*Engine, error) {
	return NewWithStore(path, expectedPassword, newMemoryStore())
}

func NewWithStore(path, expectedPassword string, stateStore StateStore) (*Engine, error) {
	return NewWithStoreConfig(path, expectedPassword, stateStore, RuntimeConfig{AuthenticationMode: "bootstrap"})
}

func NewWithStoreConfig(path, expectedPassword string, stateStore StateStore, config RuntimeConfig) (*Engine, error) {
	if config.JavaScriptRuntimeRoot == "" {
		absolutePolicyPath, pathErr := filepath.Abs(path)
		if pathErr != nil {
			return nil, fmt.Errorf("resolve policy path: %w", pathErr)
		}
		config.JavaScriptRuntimeRoot = filepath.Dir(filepath.Dir(absolutePolicyPath))
	}
	source, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	vm := goja.New()
	if err := installECMAScriptCompatibility(vm); err != nil {
		_ = vm.Close()
		return nil, err
	}
	if err := installConsole(vm); err != nil {
		_ = vm.Close()
		return nil, err
	}
	if err := installWorkerEncoding(vm); err != nil {
		_ = vm.Close()
		return nil, err
	}
	hypernodeConfig := vm.NewObject()
	_ = hypernodeConfig.Set("authenticationMode", config.AuthenticationMode)
	_ = hypernodeConfig.Set("usersRoot", config.UsersRoot)
	_ = hypernodeConfig.Set("remoteControlBaseUrl", config.RemoteControlBaseURL)
	_ = hypernodeConfig.Set("workspaceV2Enabled", config.WorkspaceManager != nil)
	_ = vm.Set("hypernodeConfig", hypernodeConfig)
	host, err := installHostRuntime(vm, config)
	if err != nil {
		_ = vm.Close()
		return nil, err
	}
	if err := installHostCrypto(vm); err != nil {
		_ = host.Close()
		_ = vm.Close()
		return nil, fmt.Errorf("install host crypto: %w", err)
	}
	if err := installHostWebCrypto(vm, func() {
		host.wakes.notify()
		host.tickWakes.notify()
	}); err != nil {
		_ = host.Close()
		_ = vm.Close()
		return nil, fmt.Errorf("install host web crypto: %w", err)
	}
	cryptoObject := vm.NewObject()
	_ = cryptoObject.Set("sha256", func(value string) string {
		sum := sha256.Sum256([]byte(value))
		return hex.EncodeToString(sum[:])
	})
	_ = cryptoObject.Set("randomBytes", func(size int) (string, error) {
		if size < 1 || size > 4096 {
			return "", fmt.Errorf("randomBytes size out of range")
		}
		value := make([]byte, size)
		if _, err := rand.Read(value); err != nil {
			return "", err
		}
		return hex.EncodeToString(value), nil
	})
	_ = cryptoObject.Set("timingSafeEqual", func(left, right string) bool {
		if len(left) != len(right) {
			return false
		}
		return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
	})
	_ = cryptoObject.Set("generateSSHKeyPair", func(comment string) (map[string]string, error) {
		publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return nil, err
		}
		marshaled, err := ssh.MarshalPrivateKey(privateKey, comment)
		if err != nil {
			return nil, err
		}
		sshPublicKey, err := ssh.NewPublicKey(publicKey)
		if err != nil {
			return nil, err
		}
		return map[string]string{
			"privateKey":  string(pem.EncodeToMemory(marshaled)),
			"publicKey":   string(ssh.MarshalAuthorizedKey(sshPublicKey)),
			"fingerprint": ssh.FingerprintSHA256(sshPublicKey),
		}, nil
	})
	_ = vm.Set("crypto", cryptoObject)
	secrets := vm.NewObject()
	_ = secrets.Set("verifyPassword", func(candidate string) bool {
		if len(candidate) != len(expectedPassword) {
			return false
		}
		return subtle.ConstantTimeCompare([]byte(candidate), []byte(expectedPassword)) == 1
	})
	_ = vm.Set("secrets", secrets)
	durableBridge, err := installDurableStorage(vm, stateStore)
	if err != nil {
		_ = host.Close()
		_ = vm.Close()
		return nil, fmt.Errorf("install durable storage: %w", err)
	}
	policyStore := vm.NewObject()
	_ = policyStore.Set("get", func(namespace, key string) (any, error) {
		if durableBridge != nil {
			return durableBridge.get(namespace, key)
		}
		value, found, err := stateStore.Get(namespace, key)
		if err != nil {
			return nil, err
		}
		if !found {
			return nil, nil
		}
		return value, nil
	})
	_ = policyStore.Set("set", func(namespace, key, value string) error {
		if durableBridge != nil {
			return durableBridge.set(namespace, key, value)
		}
		return stateStore.Set(namespace, key, value)
	})
	_ = policyStore.Set("delete", func(namespace, key string) (bool, error) {
		if durableBridge != nil {
			return durableBridge.delete(namespace, key)
		}
		return stateStore.Delete(namespace, key)
	})
	_ = policyStore.Set("getOrInsert", func(namespace, key, value string) (string, error) {
		if durableBridge != nil {
			return durableBridge.getOrInsert(namespace, key, value)
		}
		return stateStore.GetOrInsert(namespace, key, value)
	})
	_ = vm.Set("policyStore", policyStore)
	loaded, err := vm.RunString(string(source))
	if err != nil {
		_ = host.Close()
		_ = vm.Close()
		return nil, fmt.Errorf("load policy: %w", err)
	}
	loaded.Free()
	policyValue := vm.Get("policy")
	if goja.IsUndefined(policyValue) {
		policyValue.Free()
		_ = host.Close()
		_ = vm.Close()
		return nil, fmt.Errorf("policy script must define globalThis.policy")
	}
	policyValue.Free()
	bootPromise := vm.Get("hypernodeBootPromise")
	if !goja.IsUndefined(bootPromise) && !goja.IsNull(bootPromise) {
		bootResult, bootErr := vm.Await(bootPromise, 5*time.Second)
		bootPromise.Free()
		if bootResult != nil {
			bootResult.Free()
		}
		if bootErr != nil {
			diagnostics := "unavailable"
			if value, diagnosticsErr := vm.RunString("JSON.stringify(hypernodeBootDiagnostics())"); diagnosticsErr == nil {
				diagnostics = value.String()
				value.Free()
			}
			_ = host.Close()
			_ = vm.Close()
			return nil, fmt.Errorf("initialize policy services: %w; diagnostics=%s", bootErr, diagnostics)
		}
	} else {
		bootPromise.Free()
	}
	return &Engine{vm: vm, host: host}, nil
}

// installConsole gives policy code the small, Worker-like logging surface it
// needs for protocol diagnostics without coupling Go to SSH-specific events.
// Policy callers are responsible for redacting secrets before logging.
func installConsole(vm *goja.Runtime) error {
	console := vm.NewObject()
	for _, level := range []string{"debug", "info", "log", "warn", "error"} {
		level := level
		if err := console.Set(level, func(call goja.FunctionCall) goja.Value {
			parts := make([]string, 0, len(call.Arguments))
			for _, argument := range call.Arguments {
				exported := argument.Export()
				if text, ok := exported.(string); ok {
					parts = append(parts, text)
				} else {
					parts = append(parts, fmt.Sprint(exported))
				}
			}
			log.Printf("policy.console level=%s %s", level, strings.Join(parts, " "))
			return goja.Undefined()
		}); err != nil {
			return err
		}
	}
	return vm.Set("console", console)
}

type memoryStore struct {
	mu     sync.Mutex
	values map[string]string
}

func newMemoryStore() *memoryStore {
	return &memoryStore{values: make(map[string]string)}
}

func storeKey(namespace, key string) string { return namespace + "\x00" + key }

func (s *memoryStore) Get(namespace, key string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, found := s.values[storeKey(namespace, key)]
	return value, found, nil
}

func (s *memoryStore) Set(namespace, key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.values[storeKey(namespace, key)] = value
	return nil
}

func (s *memoryStore) Delete(namespace, key string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	storedKey := storeKey(namespace, key)
	_, found := s.values[storedKey]
	delete(s.values, storedKey)
	return found, nil
}

func (s *memoryStore) GetOrInsert(namespace, key, value string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	storedKey := storeKey(namespace, key)
	if existing, found := s.values[storedKey]; found {
		return existing, nil
	}
	s.values[storedKey] = value
	return value, nil
}

func (e *Engine) Authenticate(context map[string]any) (bool, error) {
	decision, err := e.call("authenticate", context)
	return decision.Allow, err
}

func (e *Engine) AuthenticateNone(context map[string]any) (bool, error) {
	decision, err := e.call("authenticateNone", context)
	return decision.Allow, err
}

func (e *Engine) AuthenticatePublicKey(context map[string]any) (bool, error) {
	decision, err := e.call("authenticatePublicKey", context)
	return decision.Allow, err
}

func (e *Engine) Exec(context map[string]any) (Decision, error) {
	return e.call("onExec", context)
}

func (e *Engine) Request(context map[string]any) (Decision, error) {
	return e.call("onRequest", context)
}

func (e *Engine) StreamData(context map[string]any) (Decision, error) {
	return e.call("onStreamData", context)
}

func (e *Engine) StreamPoll(context map[string]any) (Decision, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	policyValue := e.vm.Get("policy")
	defer policyValue.Free()
	policy := policyValue.ToObject(e.vm)
	methodValue := policy.Get("onStreamPoll")
	defer methodValue.Free()
	callable, ok := goja.AssertFunction(methodValue)
	if !ok {
		return Decision{Allow: true}, nil
	}
	contextValue := e.vm.ToValue(context)
	defer contextValue.Free()
	value, err := callable(policy, contextValue)
	if err != nil {
		return Decision{}, err
	}
	defer value.Free()
	return exportDecision(e.vm, value)
}

func (e *Engine) StreamClose(context map[string]any) (Decision, error) {
	return e.call("onStreamClose", context)
}

func (e *Engine) TCPOpen(context map[string]any) (Decision, error) {
	return e.call("onTCPOpen", context)
}

func (e *Engine) TCPData(context map[string]any) (Decision, error) {
	return e.call("onTCPData", context)
}

func (e *Engine) TCPPoll(context map[string]any) (Decision, error) {
	return e.call("onTCPPoll", context)
}

// SubscribeWake receives coalesced notifications when host-backed services or
// policy fanout may have produced output. The caller must drain policy state.
func (e *Engine) SubscribeWake() (<-chan struct{}, func()) {
	return e.host.wakes.subscribe()
}

// SubscribeTickWake is narrower than SubscribeWake: it is emitted only when a
// background host service (currently host WebSocket I/O) needs policy Tick.
func (e *Engine) SubscribeTickWake() (<-chan struct{}, func()) {
	return e.host.tickWakes.subscribe()
}

func (e *Engine) TCPClose(context map[string]any) (Decision, error) {
	return e.call("onTCPClose", context)
}

// Tick lets policy-owned background services make progress even when no SSH
// stream is open. Network I/O itself runs outside QuickJS; this method only drains
// bounded queues while holding the VM lock.
func (e *Engine) Tick() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	policyValue := e.vm.Get("policy")
	defer policyValue.Free()
	policy := policyValue.ToObject(e.vm)
	methodValue := policy.Get("onTick")
	defer methodValue.Free()
	callable, ok := goja.AssertFunction(methodValue)
	if !ok {
		return nil
	}
	value, err := callable(policy)
	if value != nil {
		value.Free()
	}
	return err
}

func (e *Engine) Close() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.host == nil && e.vm == nil {
		return nil
	}
	var hostErr error
	if e.host != nil {
		hostErr = e.host.Close()
		e.host = nil
	}
	if e.vm != nil {
		vmErr := e.vm.Close()
		e.vm = nil
		if hostErr == nil {
			hostErr = vmErr
		}
	}
	return hostErr
}

// ActivateRuntimePlugin evaluates a trusted, pre-verified release bundle inside
// the stable QuickJS runtime and replaces only the named Cordis plugin Fiber.
// Code outside that Fiber is never replaced and active transports remain attached.
func (e *Engine) ActivateRuntimePlugin(source []byte, id, revision, sourceDigest string) error {
	if len(source) == 0 || len(source) > maxHotUpgradeBundleSize {
		return fmt.Errorf("hot-upgrade bundle size is invalid: %d", len(source))
	}
	if id == "" || revision == "" || sourceDigest == "" {
		return fmt.Errorf("runtime plugin id, revision and source digest are required")
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.host == nil {
		return fmt.Errorf("policy engine is closed")
	}
	_ = e.vm.Set("hypernodeHotCandidate", goja.Undefined())
	_ = e.vm.Set("hypernodeRuntimePluginCandidate", goja.Undefined())
	evaluated, err := e.vm.RunScript("runtime-plugin:"+id+":"+revision, string(source))
	if err != nil {
		return fmt.Errorf("evaluate runtime plugin candidate: %w", err)
	}
	evaluated.Free()
	defer func() {
		_ = e.vm.Set("hypernodeHotCandidate", goja.Undefined())
		_ = e.vm.Set("hypernodeRuntimePluginCandidate", goja.Undefined())
	}()
	candidate := e.vm.Get("hypernodeRuntimePluginCandidate")
	if goja.IsUndefined(candidate) || goja.IsNull(candidate) {
		candidate.Free()
		candidate = e.vm.Get("hypernodeHotCandidate")
	}
	defer candidate.Free()
	if goja.IsUndefined(candidate) || goja.IsNull(candidate) {
		return fmt.Errorf("runtime plugin bundle did not define globalThis.hypernodeRuntimePluginCandidate")
	}
	object := candidate.ToObject(e.vm)
	idValue := object.Get("id")
	bundleID := ""
	if !goja.IsUndefined(idValue) && !goja.IsNull(idValue) {
		bundleID = idValue.String()
	}
	idValue.Free()
	if bundleID == "" {
		slotValue := object.Get("slot")
		if !goja.IsUndefined(slotValue) && !goja.IsNull(slotValue) {
			bundleID = slotValue.String()
		}
		slotValue.Free()
	}
	if bundleID != id {
		return fmt.Errorf("runtime plugin id mismatch: manifest=%s bundle=%s", id, bundleID)
	}
	revisionValue := object.Get("revision")
	bundleRevision := revisionValue.String()
	revisionValue.Free()
	if bundleRevision != revision {
		return fmt.Errorf("runtime plugin revision mismatch: manifest=%s bundle=%s", revision, bundleRevision)
	}
	if err := object.Set("sourceDigest", sourceDigest); err != nil {
		return fmt.Errorf("attach runtime plugin digest: %w", err)
	}
	api := e.vm.Get("hypernodeRuntimePlugins")
	if goja.IsUndefined(api) || goja.IsNull(api) {
		api.Free()
		api = e.vm.Get("hypernodeHotUpgrade")
	}
	defer api.Free()
	if goja.IsUndefined(api) || goja.IsNull(api) {
		return fmt.Errorf("policy does not expose the runtime plugin control plane")
	}
	apiObject := api.ToObject(e.vm)
	stageValue := apiObject.Get("stage")
	defer stageValue.Free()
	stage, ok := goja.AssertFunction(stageValue)
	if !ok {
		return fmt.Errorf("runtime plugin stage is not callable")
	}
	staged, err := stage(apiObject, candidate)
	if err != nil {
		return fmt.Errorf("stage runtime plugin candidate: %w", err)
	}
	staged.Free()
	activateValue := apiObject.Get("activate")
	defer activateValue.Free()
	activate, ok := goja.AssertFunction(activateValue)
	if !ok {
		return fmt.Errorf("runtime plugin activate is not callable")
	}
	fiberValue := e.vm.ToValue(id)
	defer fiberValue.Free()
	activationRevision := e.vm.ToValue(revision)
	defer activationRevision.Free()
	value, err := activate(apiObject, fiberValue, activationRevision)
	if err != nil {
		return fmt.Errorf("activate runtime plugin candidate: %w", err)
	}
	defer value.Free()
	if err := settledPromiseError(value); err != nil {
		return fmt.Errorf("activate runtime plugin candidate: %w", err)
	}
	return nil
}

func (e *Engine) ActivateHotUpgrade(source []byte, revision, sourceDigest string) error {
	return e.ActivateRuntimePlugin(source, "evolution", revision, sourceDigest)
}

func (e *Engine) RollbackRuntimePlugin(id string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.host == nil {
		return fmt.Errorf("policy engine is closed")
	}
	api := e.vm.Get("hypernodeRuntimePlugins")
	if goja.IsUndefined(api) || goja.IsNull(api) {
		api.Free()
		api = e.vm.Get("hypernodeHotUpgrade")
	}
	defer api.Free()
	if goja.IsUndefined(api) || goja.IsNull(api) {
		return fmt.Errorf("policy does not expose the runtime plugin control plane")
	}
	apiObject := api.ToObject(e.vm)
	rollbackValue := apiObject.Get("rollback")
	defer rollbackValue.Free()
	rollback, ok := goja.AssertFunction(rollbackValue)
	if !ok {
		return fmt.Errorf("runtime plugin rollback is not callable")
	}
	idValue := e.vm.ToValue(id)
	defer idValue.Free()
	value, err := rollback(apiObject, idValue)
	if err != nil {
		return fmt.Errorf("rollback runtime plugin: %w", err)
	}
	defer value.Free()
	return settledPromiseError(value)
}

func (e *Engine) RollbackHotUpgrade() error {
	return e.RollbackRuntimePlugin("evolution")
}

func (e *Engine) HotUpgradeStatus() (map[string]any, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	api := e.vm.Get("hypernodeHotUpgrade")
	defer api.Free()
	if goja.IsUndefined(api) || goja.IsNull(api) {
		return nil, fmt.Errorf("policy does not expose the hot-upgrade control plane")
	}
	apiObject := api.ToObject(e.vm)
	statusValue := apiObject.Get("status")
	defer statusValue.Free()
	status, ok := goja.AssertFunction(statusValue)
	if !ok {
		return nil, fmt.Errorf("hypernodeHotUpgrade.status is not callable")
	}
	value, err := status(apiObject)
	if err != nil {
		return nil, err
	}
	defer value.Free()
	var result map[string]any
	if err := e.vm.ExportTo(value, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func settledPromiseError(value goja.Value) error {
	promise, ok := value.Export().(*goja.Promise)
	if !ok {
		return nil
	}
	switch promise.State() {
	case goja.PromiseStateFulfilled:
		return nil
	case goja.PromiseStateRejected:
		result := promise.Result()
		if result == nil {
			return fmt.Errorf("hot-upgrade transition rejected without a reason")
		}
		defer result.Free()
		return fmt.Errorf("%v", result.Export())
	default:
		return fmt.Errorf("hot-upgrade transition did not settle synchronously")
	}
}

func (e *Engine) call(method string, context map[string]any) (Decision, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.vm == nil {
		return Decision{}, fmt.Errorf("policy engine is closed")
	}
	policyValue := e.vm.Get("policy")
	defer policyValue.Free()
	policy := policyValue.ToObject(e.vm)
	methodValue := policy.Get(method)
	defer methodValue.Free()
	callable, ok := goja.AssertFunction(methodValue)
	if !ok {
		return Decision{}, fmt.Errorf("policy.%s is not a function", method)
	}
	contextValue := e.vm.ToValue(context)
	defer contextValue.Free()
	value, err := callable(policy, contextValue)
	if err != nil {
		return Decision{}, err
	}
	defer value.Free()
	return exportDecision(e.vm, value)
}

func exportDecision(vm *goja.Runtime, value goja.Value) (Decision, error) {
	var exported map[string]any
	if err := vm.ExportTo(value, &exported); err != nil {
		return Decision{}, err
	}
	decision := Decision{
		Allow:           boolean(exported["allow"]),
		Sensitive:       boolean(exported["sensitive"]),
		CloseAfterWrite: boolean(exported["closeAfterWrite"]),
		Stdout:          text(exported["stdout"]),
		StdoutBytes:     byteArray(exported["stdoutBytes"]),
		Stderr:          text(exported["stderr"]),
		ExitCode:        integer(exported["exitCode"]),
		Stream:          text(exported["stream"]),
	}
	return decision, nil
}

func byteArray(value any) []byte {
	if values, ok := value.([]byte); ok {
		if len(values) > 8*1024*1024 {
			return nil
		}
		return values
	}
	values, ok := value.([]any)
	if !ok || len(values) > 8*1024*1024 {
		return nil
	}
	result := make([]byte, 0, len(values))
	for _, value := range values {
		number := integer(value)
		if number < 0 || number > 255 {
			return nil
		}
		result = append(result, byte(number))
	}
	return result
}

func boolean(value any) bool {
	result, _ := value.(bool)
	return result
}

func text(value any) string {
	result, _ := value.(string)
	return result
}

func integer(value any) int {
	switch value := value.(type) {
	case int64:
		return int(value)
	case int32:
		return int(value)
	case int:
		return value
	case float64:
		return int(value)
	default:
		return 0
	}
}
