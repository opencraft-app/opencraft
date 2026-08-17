//go:build !(darwin && arm64) && !(linux && amd64)

package selfupdate

func currentTarget() string { return "unsupported" }

func CurrentTarget() string { return currentTarget() }
