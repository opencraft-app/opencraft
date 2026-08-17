//go:build linux

package install

import "os"

func NewUserLaunchAgent() (Launcher, error) {
	return newComputerSystemdLauncher(systemdLauncherConfig{
		Runner: execSystemdRunner{}, Systemctl: "/usr/bin/systemctl",
		UnitPath:     "/etc/systemd/system/" + linuxSystemdUnit,
		EffectiveUID: os.Geteuid,
	})
}
