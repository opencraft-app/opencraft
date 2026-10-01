package runtime

import "os"

// writeRuntimeFile gives the unprivileged sandbox read access even when the
// manager uses a private umask. The containing store stays root-only on the host;
// only the selected immutable bundle is bind-mounted into the sandbox.
func writeRuntimeFile(path string, body []byte) error {
	if err := os.WriteFile(path, body, 0444); err != nil {
		return err
	}
	return os.Chmod(path, 0444)
}
