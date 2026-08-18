//go:build darwin || linux

package hermes

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"

	"golang.org/x/sys/unix"
	"velachat/agent/internal/common"
)

const managedProfileMarkerMaximum = 64 * 1024
const managedSkillMaximum = 64 * 1024

var managedProfileRuntimeStatePaths = []string{
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
}

var managedProfileSensitiveRootPaths = []string{
	".env",
	"config.yaml",
	managedProfileMarkerName,
}

var managedProfileLegacyIdentityPaths = []string{
	"MEMORY.md",
	"USER.md",
}

func enforceManagedProfilePostconditions(profileHome string) error {
	rootFD, err := unix.Open(
		profileHome,
		unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW,
		0,
	)
	if err != nil {
		return fmt.Errorf("open Hermes managed Profile without links: %w", err)
	}
	defer unix.Close(rootFD)

	if err := unix.Fchmod(rootFD, 0o700); err != nil {
		return fmt.Errorf("restrict Hermes managed Profile root: %w", err)
	}
	if err := rejectManagedRuntimeState(rootFD); err != nil {
		return err
	}
	if err := requireEmptyManagedSessions(rootFD); err != nil {
		return err
	}
	if err := validateLegacyIdentityTargets(rootFD); err != nil {
		return err
	}
	if err := restrictManagedSensitiveFiles(rootFD); err != nil {
		return err
	}
	return scrubLegacyIdentity(rootFD)
}

func ensureManagedVelaSkill(profileHome string) error {
	rootFD, err := unix.Open(
		profileHome,
		unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW,
		0,
	)
	if err != nil {
		return fmt.Errorf("open Hermes managed Profile for Vela Skill: %w", err)
	}
	defer unix.Close(rootFD)

	skillsFD, err := openOrCreateManagedDirectory(rootFD, "skills")
	if err != nil {
		return err
	}
	defer unix.Close(skillsFD)
	velaFD, err := openOrCreateManagedDirectory(
		skillsFD,
		managedVelaSkillDirectory,
	)
	if err != nil {
		return err
	}
	defer unix.Close(velaFD)

	existing, exists, err := readOptionalManagedFile(
		velaFD,
		managedVelaSkillFilename,
		managedSkillMaximum,
	)
	if err != nil {
		return err
	}
	want := []byte(managedVelaSkillContent)
	if exists && bytes.Equal(existing, want) {
		return chmodManagedFile(velaFD, managedVelaSkillFilename, 0o600)
	}
	if exists && !bytes.Contains(existing, []byte(managedVelaSkillMarker)) {
		return errors.New("Hermes Profile Vela Skill collides with an unmanaged Skill")
	}
	return writeManagedFileAtomic(
		velaFD,
		managedVelaSkillFilename,
		want,
		0o600,
	)
}

func openOrCreateManagedDirectory(parentFD int, name string) (int, error) {
	directoryFD, err := unix.Openat(
		parentFD,
		name,
		unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW,
		0,
	)
	if errors.Is(err, unix.ENOENT) {
		if err := unix.Mkdirat(parentFD, name, 0o700); err != nil &&
			!errors.Is(err, unix.EEXIST) {
			return -1, fmt.Errorf("create Hermes managed directory %s: %w", name, err)
		}
		directoryFD, err = unix.Openat(
			parentFD,
			name,
			unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW,
			0,
		)
	}
	if err != nil {
		return -1, fmt.Errorf("open Hermes managed directory %s: %w", name, err)
	}
	if err := unix.Fchmod(directoryFD, 0o700); err != nil {
		unix.Close(directoryFD)
		return -1, fmt.Errorf("restrict Hermes managed directory %s: %w", name, err)
	}
	return directoryFD, nil
}

func readOptionalManagedFile(
	parentFD int,
	name string,
	maximum int64,
) ([]byte, bool, error) {
	fileFD, err := unix.Openat(
		parentFD,
		name,
		unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW,
		0,
	)
	if errors.Is(err, unix.ENOENT) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("open Hermes managed file %s: %w", name, err)
	}
	file := os.NewFile(uintptr(fileFD), name)
	if file == nil {
		unix.Close(fileFD)
		return nil, false, fmt.Errorf("open Hermes managed file %s", name)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > maximum {
		return nil, false, fmt.Errorf("Hermes managed file %s is invalid", name)
	}
	data, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil {
		return nil, false, fmt.Errorf("read Hermes managed file %s: %w", name, err)
	}
	if int64(len(data)) > maximum {
		return nil, false, fmt.Errorf("Hermes managed file %s is too large", name)
	}
	return data, true, nil
}

func chmodManagedFile(parentFD int, name string, mode uint32) error {
	fileFD, err := unix.Openat(
		parentFD,
		name,
		unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW,
		0,
	)
	if err != nil {
		return err
	}
	defer unix.Close(fileFD)
	return unix.Fchmod(fileFD, mode)
}

func writeManagedFileAtomic(
	parentFD int,
	name string,
	content []byte,
	mode uint32,
) error {
	random := make([]byte, 12)
	if _, err := rand.Read(random); err != nil {
		return err
	}
	tempName := ".vela-skill-" + hex.EncodeToString(random) + ".tmp"
	tempFD, err := unix.Openat(
		parentFD,
		tempName,
		unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_CLOEXEC|unix.O_NOFOLLOW,
		mode,
	)
	if err != nil {
		return fmt.Errorf("create Hermes managed Vela Skill: %w", err)
	}
	removeTemp := true
	defer func() {
		if removeTemp {
			_ = unix.Unlinkat(parentFD, tempName, 0)
		}
	}()
	temp := os.NewFile(uintptr(tempFD), tempName)
	if temp == nil {
		unix.Close(tempFD)
		return errors.New("open Hermes managed Vela Skill temporary file")
	}
	if _, err := temp.Write(content); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := unix.Renameat(parentFD, tempName, parentFD, name); err != nil {
		return fmt.Errorf("commit Hermes managed Vela Skill: %w", err)
	}
	removeTemp = false
	return unix.Fsync(parentFD)
}

func rejectManagedRuntimeState(rootFD int) error {
	for _, relativePath := range managedProfileRuntimeStatePaths {
		var stat unix.Stat_t
		err := unix.Fstatat(
			rootFD,
			relativePath,
			&stat,
			unix.AT_SYMLINK_NOFOLLOW,
		)
		switch {
		case err == nil:
			return fmt.Errorf(
				"Hermes managed Profile unexpectedly contains %s",
				relativePath,
			)
		case errors.Is(err, unix.ENOENT):
			continue
		default:
			return fmt.Errorf(
				"inspect Hermes managed Profile path %s: %w",
				relativePath,
				err,
			)
		}
	}
	return nil
}

func requireEmptyManagedSessions(rootFD int) error {
	sessionsFD, err := unix.Openat(
		rootFD,
		"sessions",
		unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW,
		0,
	)
	if errors.Is(err, unix.ENOENT) {
		return nil
	}
	if err != nil {
		return fmt.Errorf(
			"open Hermes managed Profile sessions without links: %w",
			err,
		)
	}
	sessions := os.NewFile(uintptr(sessionsFD), "Hermes managed sessions")
	if sessions == nil {
		unix.Close(sessionsFD)
		return errors.New("open Hermes managed Profile sessions")
	}
	defer sessions.Close()

	names, err := sessions.Readdirnames(1)
	if err == nil && len(names) != 0 {
		return errors.New(
			"Hermes managed Profile unexpectedly contains sessions",
		)
	}
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect Hermes managed Profile sessions: %w", err)
	}
	return nil
}

func validateLegacyIdentityTargets(rootFD int) error {
	memoriesFD, exists, err := openOptionalManagedDirectory(
		rootFD,
		"memories",
	)
	if err != nil {
		return err
	}
	if !exists {
		return nil
	}
	defer unix.Close(memoriesFD)

	for _, name := range managedProfileLegacyIdentityPaths {
		var stat unix.Stat_t
		err := unix.Fstatat(
			memoriesFD,
			name,
			&stat,
			unix.AT_SYMLINK_NOFOLLOW,
		)
		if errors.Is(err, unix.ENOENT) {
			continue
		}
		if err != nil {
			return fmt.Errorf(
				"inspect Hermes legacy identity %s: %w",
				name,
				err,
			)
		}
		if stat.Mode&unix.S_IFMT != unix.S_IFREG {
			return fmt.Errorf(
				"Hermes legacy identity %s is not a regular file",
				name,
			)
		}
		fileFD, err := unix.Openat(
			memoriesFD,
			name,
			unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW,
			0,
		)
		if err != nil {
			return fmt.Errorf(
				"open Hermes legacy identity %s without links: %w",
				name,
				err,
			)
		}
		if err := unix.Close(fileFD); err != nil {
			return fmt.Errorf("close Hermes legacy identity %s: %w", name, err)
		}
	}
	return nil
}

func restrictManagedSensitiveFiles(rootFD int) error {
	for _, relativePath := range managedProfileSensitiveRootPaths {
		fileFD, err := unix.Openat(
			rootFD,
			relativePath,
			unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW,
			0,
		)
		if errors.Is(err, unix.ENOENT) {
			continue
		}
		if err != nil {
			return fmt.Errorf(
				"open Hermes sensitive Profile file %s without links: %w",
				relativePath,
				err,
			)
		}
		var stat unix.Stat_t
		if err := unix.Fstat(fileFD, &stat); err != nil {
			unix.Close(fileFD)
			return fmt.Errorf(
				"inspect Hermes sensitive Profile file %s: %w",
				relativePath,
				err,
			)
		}
		if stat.Mode&unix.S_IFMT != unix.S_IFREG {
			unix.Close(fileFD)
			return fmt.Errorf(
				"Hermes sensitive Profile file %s is not regular",
				relativePath,
			)
		}
		if err := unix.Fchmod(fileFD, 0o600); err != nil {
			unix.Close(fileFD)
			return fmt.Errorf(
				"restrict Hermes sensitive Profile file %s: %w",
				relativePath,
				err,
			)
		}
		if err := unix.Close(fileFD); err != nil {
			return fmt.Errorf(
				"close Hermes sensitive Profile file %s: %w",
				relativePath,
				err,
			)
		}
	}
	return nil
}

func scrubLegacyIdentity(rootFD int) error {
	memoriesFD, exists, err := openOptionalManagedDirectory(
		rootFD,
		"memories",
	)
	if err != nil {
		return err
	}
	if !exists {
		return nil
	}
	defer unix.Close(memoriesFD)

	for _, name := range managedProfileLegacyIdentityPaths {
		err := unix.Unlinkat(memoriesFD, name, 0)
		if errors.Is(err, unix.ENOENT) {
			continue
		}
		if err != nil {
			return fmt.Errorf(
				"remove cloned Hermes legacy identity %s: %w",
				name,
				err,
			)
		}
	}
	return nil
}

func openOptionalManagedDirectory(
	parentFD int,
	name string,
) (int, bool, error) {
	directoryFD, err := unix.Openat(
		parentFD,
		name,
		unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW,
		0,
	)
	if errors.Is(err, unix.ENOENT) {
		return -1, false, nil
	}
	if err != nil {
		return -1, false, fmt.Errorf(
			"open Hermes managed Profile directory %s without links: %w",
			name,
			err,
		)
	}
	return directoryFD, true, nil
}

func readManagedProfileMarker(profileHome string, destination any) error {
	rootFD, err := unix.Open(
		profileHome,
		unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW,
		0,
	)
	if err != nil {
		return fmt.Errorf("open Hermes Profile ownership root without links: %w", err)
	}
	defer unix.Close(rootFD)

	markerFD, err := unix.Openat(
		rootFD,
		managedProfileMarkerName,
		unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW,
		0,
	)
	if err != nil {
		return fmt.Errorf(
			"open Hermes Profile ownership marker without links: %w",
			err,
		)
	}
	marker := os.NewFile(uintptr(markerFD), managedProfileMarkerName)
	if marker == nil {
		unix.Close(markerFD)
		return errors.New("open Hermes Profile ownership marker")
	}
	defer marker.Close()

	info, err := marker.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("Hermes Profile ownership marker is not regular")
	}
	data, err := io.ReadAll(io.LimitReader(
		marker,
		managedProfileMarkerMaximum+1,
	))
	if err != nil {
		return err
	}
	if len(data) > managedProfileMarkerMaximum {
		return errors.New("Hermes Profile ownership marker is too large")
	}
	return common.Unmarshal(data, destination)
}

func writeManagedProfileMarker(profileHome string, marker any) error {
	data, err := common.Marshal(marker)
	if err != nil {
		return err
	}
	if len(data) > managedProfileMarkerMaximum {
		return errors.New("Hermes Profile ownership marker is too large")
	}
	rootFD, err := unix.Open(
		profileHome,
		unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW,
		0,
	)
	if err != nil {
		return fmt.Errorf("open Hermes Profile ownership root without links: %w", err)
	}
	defer unix.Close(rootFD)

	random := make([]byte, 12)
	if _, err := rand.Read(random); err != nil {
		return err
	}
	tempName := ".vela-profile-marker-" + hex.EncodeToString(random) + ".tmp"
	tempFD, err := unix.Openat(
		rootFD,
		tempName,
		unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_CLOEXEC|unix.O_NOFOLLOW,
		0o600,
	)
	if err != nil {
		return fmt.Errorf("create Hermes Profile ownership marker: %w", err)
	}
	removeTemp := true
	defer func() {
		if removeTemp {
			_ = unix.Unlinkat(rootFD, tempName, 0)
		}
	}()
	temp := os.NewFile(uintptr(tempFD), tempName)
	if temp == nil {
		unix.Close(tempFD)
		return errors.New("create Hermes Profile ownership marker")
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := unix.Renameat(
		rootFD,
		tempName,
		rootFD,
		managedProfileMarkerName,
	); err != nil {
		return fmt.Errorf("commit Hermes Profile ownership marker: %w", err)
	}
	removeTemp = false
	if err := unix.Fsync(rootFD); err != nil {
		return fmt.Errorf("sync Hermes Profile ownership marker: %w", err)
	}
	return nil
}
