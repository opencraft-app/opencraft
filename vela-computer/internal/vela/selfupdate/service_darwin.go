//go:build darwin && arm64

package selfupdate

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
)

const mainLaunchAgentLabel = "com.agentnetwork.vela.computer"

type launchdMainServiceManager struct {
	runner    helperCommandRunner
	launchctl string
	domain    string
	plist     string
}

func NewPlatformMainServiceManager() (MainServiceManager, error) {
	home, err := os.UserHomeDir()
	if err != nil || !cleanAbsolute(home) {
		return nil, ErrTransactionInvalid
	}
	return &launchdMainServiceManager{
		runner: execHelperCommandRunner{}, launchctl: "/bin/launchctl",
		domain: "gui/" + strconv.Itoa(os.Getuid()),
		plist:  filepath.Join(home, "Library", "LaunchAgents", mainLaunchAgentLabel+".plist"),
	}, nil
}

func (manager *launchdMainServiceManager) StopMain(ctx context.Context) error {
	_, err := manager.runner.Run(ctx, manager.launchctl, "bootout", manager.domain+"/"+mainLaunchAgentLabel)
	return err
}

func (manager *launchdMainServiceManager) StartMain(ctx context.Context) error {
	if _, err := manager.runner.Run(ctx, manager.launchctl, "bootstrap", manager.domain, manager.plist); err != nil {
		return err
	}
	_, err := manager.runner.Run(ctx, manager.launchctl, "kickstart", "-k", manager.domain+"/"+mainLaunchAgentLabel)
	return err
}

func (*launchdMainServiceManager) ResetFailed(context.Context) error { return nil }
