//go:build linux && amd64

package selfupdate

func currentTarget() string { return "linux-amd64" }

func CurrentTarget() string { return currentTarget() }
