//go:build darwin && arm64

package selfupdate

func currentTarget() string { return "darwin-arm64" }

func CurrentTarget() string { return currentTarget() }
