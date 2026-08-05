//go:build darwin

package install

import (
	"context"
	"errors"
	"path/filepath"

	launchdservice "velachat/agent/internal/launchd"
)

type launchdManager interface {
	EnsureLoaded(context.Context, launchdservice.Definition) error
}

type computerLaunchAgent struct{ manager launchdManager }

func NewUserLaunchAgent() (Launcher, error) {
	manager, err := launchdservice.NewUserManager()
	if err != nil {
		return nil, ErrServiceInvalid
	}
	return &computerLaunchAgent{manager: manager}, nil
}

func (launcher *computerLaunchAgent) Start(ctx context.Context, spec LaunchSpec) error {
	if launcher == nil || launcher.manager == nil || ctx == nil ||
		spec.Label != launchAgentLabel ||
		filepath.Clean(spec.ProgramPath) != filepath.Join(spec.InstallationRoot, "bin", ProgramName) ||
		filepath.Clean(spec.StateDirectory) != filepath.Join(spec.InstallationRoot, "state") ||
		len(spec.RuntimeConfigDigest) != 64 {
		return ErrServiceInvalid
	}
	logs := filepath.Join(spec.StateDirectory, "logs")
	if err := ensurePrivateDirectory(logs); err != nil {
		return err
	}
	err := launcher.manager.EnsureLoaded(ctx, launchdservice.Definition{
		Label: spec.Label, Program: spec.ProgramPath, ProgramSHA256: spec.ProgramSHA256,
		RuntimeConfigDigest: spec.RuntimeConfigDigest,
		Arguments:           []string{"daemon", "run", "--state-dir", spec.StateDirectory},
		StdoutPath:          filepath.Join(logs, "computer.stdout.log"),
		StderrPath:          filepath.Join(logs, "computer.stderr.log"),
		Environment:         map[string]string{"PATH": "/usr/local/bin:/usr/bin:/bin"},
		KeepAlive:           true, RunAtLoad: true,
		ProcessType: launchdservice.ProcessTypeBackground, Umask: 0o077,
	})
	if err == nil {
		return nil
	}
	var operationError *launchdservice.OperationError
	if errors.As(err, &operationError) && operationError.Stage == launchdservice.StageBootstrap {
		return errors.New("Unable to register Vela Computer with macOS.")
	}
	return errors.New("Unable to verify that Vela Computer was registered with macOS.")
}
