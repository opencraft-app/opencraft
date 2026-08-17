//go:build !(darwin && arm64) && !(linux && amd64)

package selfupdate

func NewPlatformHelperLauncher() (HelperLauncher, error) {
	return nil, ErrHelperLaunch
}
