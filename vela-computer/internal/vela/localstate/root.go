// Package localstate resolves and names the Vela Computer local state.
package localstate

import (
	"errors"
	"path/filepath"
	"strings"
)

const EnvironmentName = "VELA_COMPUTER_HOME"

var ErrWorkingDirectory = errors.New("无法解析 Vela Computer 工作目录")

func ResolveRoot(
	explicit string,
	getenv func(string) string,
	getwd func() (string, error),
) (string, error) {
	if getenv == nil || getwd == nil {
		return "", ErrWorkingDirectory
	}
	workingDirectory, err := getwd()
	if err != nil || strings.TrimSpace(workingDirectory) == "" {
		return "", ErrWorkingDirectory
	}
	selected := strings.TrimSpace(explicit)
	if selected == "" {
		selected = strings.TrimSpace(getenv(EnvironmentName))
	}
	if selected == "" {
		home := strings.TrimSpace(getenv("HOME"))
		if home == "" || !filepath.IsAbs(home) {
			return "", ErrWorkingDirectory
		}
		return filepath.Join(filepath.Clean(home), ".vela", "computer", "state"), nil
	}
	if !filepath.IsAbs(selected) {
		selected = filepath.Join(workingDirectory, selected)
	}
	return filepath.Clean(selected), nil
}
