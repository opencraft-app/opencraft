//go:build darwin || linux

package hermes

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestManagedProfilePostconditionsScrubOnlyLegacyIdentity(t *testing.T) {
	t.Parallel()

	profileHome := t.TempDir()
	mustWriteProfileFile(
		t,
		profileHome,
		"memories/MEMORY.md",
		[]byte("default memory"),
		0o600,
	)
	mustWriteProfileFile(
		t,
		profileHome,
		"memories/USER.md",
		[]byte("default user"),
		0o600,
	)
	preserved := map[string]string{
		"config.yaml":            "model: test",
		".env":                   "TEST_ONLY=value",
		"SOUL.md":                "identity",
		"skills/local/SKILL.md":  "skill",
		"hooks/on_start.py":      "hook",
		"memories/operator-note": "keep",
		"unknown.data":           "keep",
	}
	for relativePath, value := range preserved {
		mustWriteProfileFile(
			t,
			profileHome,
			relativePath,
			[]byte(value),
			0o666,
		)
	}
	if err := os.MkdirAll(
		filepath.Join(profileHome, "sessions"),
		0o700,
	); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(profileHome, 0o755); err != nil {
		t.Fatal(err)
	}

	if err := enforceManagedProfilePostconditions(profileHome); err != nil {
		t.Fatal(err)
	}
	for _, relativePath := range []string{
		"memories/MEMORY.md",
		"memories/USER.md",
	} {
		if _, err := os.Lstat(
			filepath.Join(profileHome, relativePath),
		); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("scrubbed path %q still exists: %v", relativePath, err)
		}
	}
	for relativePath, want := range preserved {
		data, err := os.ReadFile(filepath.Join(profileHome, relativePath))
		if err != nil {
			t.Fatalf("read preserved %q: %v", relativePath, err)
		}
		if string(data) != want {
			t.Fatalf("preserved %q = %q", relativePath, data)
		}
	}
	for _, relativePath := range []string{"config.yaml", ".env"} {
		info, err := os.Stat(filepath.Join(profileHome, relativePath))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("%s mode = %o", relativePath, info.Mode().Perm())
		}
	}
	info, err := os.Stat(profileHome)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("Profile root mode = %o", info.Mode().Perm())
	}
}

func TestManagedProfilePostconditionsRejectRuntimeStateWithoutDeleting(t *testing.T) {
	t.Parallel()

	for _, relativePath := range []string{
		"state.db",
		"state.db-shm",
		"state.db-wal",
		"hermes_state.db",
		"response_store.db",
		"response_store.db-shm",
		"response_store.db-wal",
		"gateway.pid",
		"gateway_state.json",
		"processes.json",
		"active_profile",
	} {
		relativePath := relativePath
		t.Run(relativePath, func(t *testing.T) {
			t.Parallel()

			profileHome := t.TempDir()
			mustWriteProfileFile(
				t,
				profileHome,
				relativePath,
				[]byte("do not delete"),
				0o600,
			)
			err := enforceManagedProfilePostconditions(profileHome)
			if err == nil || !strings.Contains(err.Error(), relativePath) {
				t.Fatalf("runtime-state error = %v", err)
			}
			data, readErr := os.ReadFile(
				filepath.Join(profileHome, relativePath),
			)
			if readErr != nil || string(data) != "do not delete" {
				t.Fatalf(
					"runtime state mutated: data=%q err=%v",
					data,
					readErr,
				)
			}
		})
	}
}

func TestManagedProfilePostconditionsRequireEmptySessions(t *testing.T) {
	t.Parallel()

	profileHome := t.TempDir()
	mustWriteProfileFile(
		t,
		profileHome,
		"sessions/existing.json",
		[]byte("{}"),
		0o600,
	)

	err := enforceManagedProfilePostconditions(profileHome)
	if err == nil || !strings.Contains(err.Error(), "sessions") {
		t.Fatalf("sessions error = %v", err)
	}
	if _, statErr := os.Stat(
		filepath.Join(profileHome, "sessions/existing.json"),
	); statErr != nil {
		t.Fatalf("existing session was deleted: %v", statErr)
	}
}

func TestManagedProfilePostconditionsRejectSymlinkEscape(t *testing.T) {
	t.Parallel()

	t.Run("root", func(t *testing.T) {
		t.Parallel()

		parent := t.TempDir()
		outside := t.TempDir()
		profileHome := filepath.Join(parent, "profile")
		if err := os.Symlink(outside, profileHome); err != nil {
			t.Fatal(err)
		}
		if err := enforceManagedProfilePostconditions(profileHome); err == nil {
			t.Fatal("symlink Profile root was accepted")
		}
	})

	t.Run("memories ancestor", func(t *testing.T) {
		t.Parallel()

		profileHome := t.TempDir()
		outside := t.TempDir()
		outsideMemory := filepath.Join(outside, "MEMORY.md")
		if err := os.WriteFile(
			outsideMemory,
			[]byte("outside"),
			0o600,
		); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(
			outside,
			filepath.Join(profileHome, "memories"),
		); err != nil {
			t.Fatal(err)
		}
		if err := enforceManagedProfilePostconditions(profileHome); err == nil {
			t.Fatal("symlink scrub ancestor was accepted")
		}
		if data, err := os.ReadFile(outsideMemory); err != nil ||
			string(data) != "outside" {
			t.Fatalf("outside memory changed: data=%q err=%v", data, err)
		}
	})

	t.Run("scrub target", func(t *testing.T) {
		t.Parallel()

		profileHome := t.TempDir()
		outside := filepath.Join(t.TempDir(), "outside.md")
		if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(
			filepath.Join(profileHome, "memories"),
			0o700,
		); err != nil {
			t.Fatal(err)
		}
		target := filepath.Join(profileHome, "memories", "MEMORY.md")
		if err := os.Symlink(outside, target); err != nil {
			t.Fatal(err)
		}
		if err := enforceManagedProfilePostconditions(profileHome); err == nil {
			t.Fatal("symlink scrub target was accepted")
		}
		if data, err := os.ReadFile(outside); err != nil ||
			string(data) != "outside" {
			t.Fatalf("outside target changed: data=%q err=%v", data, err)
		}
		if info, err := os.Lstat(target); err != nil ||
			info.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("symlink target was mutated: info=%v err=%v", info, err)
		}
	})
}

func mustWriteProfileFile(
	t *testing.T,
	root string,
	relativePath string,
	data []byte,
	mode os.FileMode,
) {
	t.Helper()
	path := filepath.Join(root, relativePath)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}
