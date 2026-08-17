//go:build linux && amd64

package install

func currentPlatform() (Platform, error) {
	return Platform{
		OSType: "linux", Architecture: "amd64", Target: "linux-amd64",
		ServiceName: linuxSystemdUnit,
	}, nil
}
