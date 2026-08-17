//go:build darwin && arm64

package install

func currentPlatform() (Platform, error) {
	return Platform{
		OSType: "macos", Architecture: "arm64", Target: "darwin-arm64",
		ServiceName: launchAgentLabel,
	}, nil
}
