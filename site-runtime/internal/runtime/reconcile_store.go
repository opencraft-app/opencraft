package runtime

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

var startupDirectory = regexp.MustCompile(`^\.startup-probe-[0-9]+$`)
var preparingDirectory = regexp.MustCompile(`^\.preparing-[0-9]+$`)

// reconcileStore runs only while the executable owns the exclusive store lock,
// after all this store's containers have been reaped and before serving requests.
// Temporary directories cannot be referenced as immutable releases. Never remove
// a real revision: its activation/retention state belongs to the control plane.
func reconcileStore(root string) error {
	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("unexpected store symlink")
		}
		if !entry.IsDir() {
			continue
		}
		path := filepath.Join(root, entry.Name())
		if startupDirectory.MatchString(entry.Name()) {
			if err := os.RemoveAll(path); err != nil {
				return err
			}
			continue
		}
		if !identifier.MatchString(entry.Name()) {
			continue
		}
		revisions, err := os.ReadDir(path)
		if err != nil {
			return err
		}
		for _, revision := range revisions {
			if revision.Type()&os.ModeSymlink != 0 {
				return fmt.Errorf("unexpected revision symlink")
			}
			if revision.IsDir() && preparingDirectory.MatchString(revision.Name()) {
				if err := os.RemoveAll(filepath.Join(path, revision.Name())); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
