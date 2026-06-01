package wrapper

import (
	"context"
	"fmt"
	"strings"
)

const (
	runtimeHostTypeAGS       = "ags"
	runtimeHostTypeLocalWisp = "local_wisp"

	// localRuntimeHostToken is a non-secret compatibility sentinel. Older
	// runtime state fields require a non-empty envd token before calling host
	// operations; local_wisp does not use envd auth.
	localRuntimeHostToken = "local_wisp"
)

// RuntimeHostTarget is a neutral handle for one compute target owned by a
// RuntimeHost. AGS-specific envd/auth data lives in optional fields so the
// generic runtime path does not depend on AGS as the identity model.
type RuntimeHostTarget struct {
	ID                 string
	HostType           string
	Domain             string
	EnvdAccessToken    string
	TrafficAccessToken string
	Metadata           map[string]string
}

func runtimeHostTargetFromAGSSandbox(sb AGSSandbox) RuntimeHostTarget {
	return RuntimeHostTarget{
		ID:                 sb.SandboxID,
		HostType:           runtimeHostTypeAGS,
		Domain:             sb.Domain,
		EnvdAccessToken:    sb.EnvdAccessToken,
		TrafficAccessToken: sb.TrafficAccessToken,
		Metadata: map[string]string{
			"template_id":   sb.TemplateID,
			"envd_version":  sb.EnvdVersion,
			"alias":         sb.Alias,
			"compat_shape":  "ags_sandbox",
			"host_target_v": "1",
		},
	}
}

func (t RuntimeHostTarget) asAGSSandbox() AGSSandbox {
	return AGSSandbox{
		SandboxID:          t.ID,
		Domain:             t.Domain,
		EnvdAccessToken:    t.EnvdAccessToken,
		TrafficAccessToken: t.TrafficAccessToken,
	}
}

// RuntimeHost is the compute/capability boundary used by CloudAgent runtime.
//
// AGS, Talos, and local Linux/Wisp hosts should all implement this surface. The
// runtime/session layer should depend on this interface instead of assuming a
// specific sandbox control plane.
type RuntimeHost interface {
	CreateSandbox(context.Context, CreateSandboxOptions) (RuntimeHostTarget, error)
	DeleteSandbox(context.Context, string) error
	RefreshSandboxTimeout(context.Context, string, int) error
	RunCommand(context.Context, RuntimeHostTarget, string, map[string]string, func(string) error, func(string) error) (CommandResult, error)
	UploadFile(context.Context, RuntimeHostTarget, string, string, []byte) error
	DownloadFile(context.Context, RuntimeHostTarget, string) ([]byte, error)
	RuntimeHostEnv() RuntimeHostEnv
}

type RuntimeHostProcessGroupKillRequest struct {
	PIDFile                  string
	ProcessPattern           string
	AllowProcessNameFallback bool
}

type RuntimeHostProcessController interface {
	KillTargetProcessGroup(context.Context, RuntimeHostTarget, RuntimeHostProcessGroupKillRequest) error
}

func runtimeHostKillTargetProcessGroup(ctx context.Context, host RuntimeHost, target RuntimeHostTarget, req RuntimeHostProcessGroupKillRequest) error {
	if host == nil {
		return fmt.Errorf("runtime host is nil")
	}
	if controller, ok := host.(RuntimeHostProcessController); ok {
		return controller.KillTargetProcessGroup(ctx, target, req)
	}
	return runtimeHostRunProcessGroupKill(ctx, host, target, req)
}

func runtimeHostRunProcessGroupKill(ctx context.Context, host RuntimeHost, target RuntimeHostTarget, req RuntimeHostProcessGroupKillRequest) error {
	command, err := runtimeHostProcessGroupKillCommand(req)
	if err != nil {
		return err
	}
	result, err := host.RunCommand(ctx, target, command, nil, nil, nil)
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("kill target process group failed exit=%d stdout=%q stderr=%q", result.ExitCode, result.Stdout, result.Stderr)
	}
	return nil
}

func runtimeHostProcessGroupKillCommand(req RuntimeHostProcessGroupKillRequest) (string, error) {
	pidFile := strings.TrimSpace(req.PIDFile)
	if pidFile == "" {
		return "", fmt.Errorf("pid file is required")
	}
	command := "pid=$(cat " + shellQuote(pidFile) + " 2>/dev/null || true)\n" +
		"if [ -n \"$pid\" ]; then\n" +
		"  kill -TERM \"$pid\" 2>/dev/null || true\n" +
		"  exit 0\n" +
		"fi\n"
	if req.AllowProcessNameFallback && strings.TrimSpace(req.ProcessPattern) != "" {
		command += "pkill -TERM -f " + shellQuote(req.ProcessPattern) + " 2>/dev/null || true\n" +
			"exit 0\n"
	}
	return command +
		"echo CLOUDAGENT_DAEMON_PID_MISSING path=" + shellQuote(pidFile) + " >&2\n" +
		"exit 1\n", nil
}

type RuntimeHostEnv struct {
	APIKey   string
	APIURL   string
	Domain   string
	EnvdUser string
}

type AGSRuntimeHost struct {
	client *AGSClient
}

func NewAGSRuntimeHost(client *AGSClient) *AGSRuntimeHost {
	return &AGSRuntimeHost{client: client}
}

var _ RuntimeHost = (*AGSRuntimeHost)(nil)

func (h *AGSRuntimeHost) CreateSandbox(ctx context.Context, opts CreateSandboxOptions) (RuntimeHostTarget, error) {
	sb, err := h.client.CreateSandbox(ctx, opts)
	if err != nil {
		return RuntimeHostTarget{}, err
	}
	return runtimeHostTargetFromAGSSandbox(sb), nil
}

func (h *AGSRuntimeHost) DeleteSandbox(ctx context.Context, id string) error {
	return h.client.DeleteSandbox(ctx, id)
}

func (h *AGSRuntimeHost) RefreshSandboxTimeout(ctx context.Context, id string, timeoutSeconds int) error {
	return h.client.RefreshSandboxTimeout(ctx, id, timeoutSeconds)
}

func (h *AGSRuntimeHost) RunCommand(ctx context.Context, target RuntimeHostTarget, command string, env map[string]string, onStdout func(string) error, onStderr func(string) error) (CommandResult, error) {
	return h.client.RunCommand(ctx, target.asAGSSandbox(), command, env, onStdout, onStderr)
}

func (h *AGSRuntimeHost) UploadFile(ctx context.Context, target RuntimeHostTarget, remotePath, filename string, content []byte) error {
	return h.client.UploadFile(ctx, target.asAGSSandbox(), remotePath, filename, content)
}

func (h *AGSRuntimeHost) DownloadFile(ctx context.Context, target RuntimeHostTarget, remotePath string) ([]byte, error) {
	return h.client.DownloadFile(ctx, target.asAGSSandbox(), remotePath)
}

func (h *AGSRuntimeHost) RuntimeHostEnv() RuntimeHostEnv {
	if h == nil {
		return RuntimeHostEnv{}
	}
	return h.client.RuntimeHostEnv()
}

func (c *AGSClient) RuntimeHostEnv() RuntimeHostEnv {
	if c == nil {
		return RuntimeHostEnv{}
	}
	return RuntimeHostEnv{
		APIKey:   c.apiKey,
		APIURL:   c.apiURL,
		Domain:   c.domain,
		EnvdUser: c.envdUser,
	}
}
