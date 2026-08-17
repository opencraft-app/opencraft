//go:build linux && amd64

package selfupdate

import "context"

const mainSystemdUnit = "vela-computer.service"

type systemdMainServiceManager struct {
	runner    helperCommandRunner
	systemctl string
}

func NewPlatformMainServiceManager() (MainServiceManager, error) {
	return &systemdMainServiceManager{
		runner: execHelperCommandRunner{}, systemctl: "/usr/bin/systemctl",
	}, nil
}

func (manager *systemdMainServiceManager) StopMain(ctx context.Context) error {
	_, err := manager.runner.Run(ctx, manager.systemctl, "stop", mainSystemdUnit)
	return err
}

func (manager *systemdMainServiceManager) StartMain(ctx context.Context) error {
	if _, err := manager.runner.Run(ctx, manager.systemctl, "start", mainSystemdUnit); err != nil {
		return err
	}
	_, err := manager.runner.Run(ctx, manager.systemctl, "is-active", "--quiet", mainSystemdUnit)
	return err
}

func (manager *systemdMainServiceManager) ResetFailed(ctx context.Context) error {
	_, err := manager.runner.Run(ctx, manager.systemctl, "reset-failed", mainSystemdUnit)
	return err
}
