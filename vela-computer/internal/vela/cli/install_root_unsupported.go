//go:build !darwin && !linux

package cli

import "path/filepath"

func defaultInstallationRoot(home string) string {
	return filepath.Join(home, ".vela", "computer")
}
