//go:build linux && amd64

package selfupdate

func NewPlatformHelperLauncher() (HelperLauncher, error) {
	return newSystemdHelperLauncher(execHelperCommandRunner{}, "/usr/bin/systemd-run")
}
