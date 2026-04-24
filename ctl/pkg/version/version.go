// Package version ...
package version

// should be set by ldflags
var version = "default-version"

// Version ...
func Version() string {
	return version
}
