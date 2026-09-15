//go:build darwin && arm64

package selfupdate

import "os"

func NewPlatformHelperLauncher() (HelperLauncher, error) {
	return newLaunchdHelperLauncher(execHelperCommandRunner{}, "/bin/launchctl", os.Getuid())
}
