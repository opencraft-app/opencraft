//go:build (!darwin || !arm64) && (!linux || !amd64)

package install

func currentPlatform() (Platform, error) { return Platform{}, ErrServiceInvalid }
