package state

import "path/filepath"

func DefaultRoot(home string) string {
	return filepath.Join(home, ".vela", "state")
}
