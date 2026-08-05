//go:build darwin

package launchd

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

type commandRunner func(context.Context, ...string) ([]byte, error)

type managerConfig struct {
	home              string
	uid               int
	gid               int
	run               commandRunner
	transitionTimeout time.Duration
	retryInterval     time.Duration
}

type Manager struct{ config managerConfig }

type Stage string

const (
	StageLock      Stage = "lock"
	StageProgram   Stage = "program"
	StageWrite     Stage = "write"
	StageBootout   Stage = "bootout"
	StageBootstrap Stage = "bootstrap"
	StageObserve   Stage = "observe"
)

type OperationError struct {
	Stage Stage
	Err   error
}

func (err *OperationError) Error() string {
	if err == nil {
		return "launchd operation failed"
	}
	return "launchd " + string(err.Stage) + ": " + err.Err.Error()
}

func (err *OperationError) Unwrap() error {
	if err == nil {
		return nil
	}
	return err.Err
}

func systemLaunchctl(ctx context.Context, arguments ...string) ([]byte, error) {
	return exec.CommandContext(ctx, "/bin/launchctl", arguments...).CombinedOutput()
}

func NewUserManager() (*Manager, error) {
	home, err := os.UserHomeDir()
	if err != nil || !filepath.IsAbs(home) || os.Geteuid() <= 0 {
		return nil, ErrInvalidDirectory
	}
	return newManager(managerConfig{
		home: filepath.Clean(home), uid: os.Geteuid(), gid: os.Getegid(),
		run: systemLaunchctl, transitionTimeout: 3 * time.Second, retryInterval: 50 * time.Millisecond,
	}), nil
}

func newManager(config managerConfig) *Manager {
	if config.run == nil {
		config.run = systemLaunchctl
	}
	if config.transitionTimeout <= 0 {
		config.transitionTimeout = 3 * time.Second
	}
	if config.retryInterval <= 0 {
		config.retryInterval = 50 * time.Millisecond
	}
	return &Manager{config: config}
}

var keyedProcessLocks = struct {
	sync.Mutex
	items map[string]chan struct{}
}{items: make(map[string]chan struct{})}

func (manager *Manager) EnsureLoaded(ctx context.Context, definition Definition) error {
	if manager == nil || ctx == nil || validateDefinition(definition) != nil {
		return ErrInvalidDefinition
	}
	directory := filepath.Join(manager.config.home, "Library", "LaunchAgents")
	if err := ensureLaunchAgentsDirectory(directory, manager.config.uid); err != nil {
		return err
	}
	releaseProcess, err := acquireProcessLock(ctx, strconv.Itoa(manager.config.uid)+":"+definition.Label)
	if err != nil {
		return &OperationError{Stage: StageLock, Err: err}
	}
	defer releaseProcess()
	fileLock, err := acquireFileLock(ctx, filepath.Join(directory, "."+definition.Label+".plist.lock"), manager.config.uid, manager.config.retryInterval)
	if err != nil {
		return &OperationError{Stage: StageLock, Err: err}
	}
	defer fileLock.release()
	if err := verifyProgram(definition.Program, definition.ProgramSHA256); err != nil {
		return &OperationError{Stage: StageProgram, Err: ErrInvalidDefinition}
	}
	content, err := renderDefinition(definition)
	if err != nil {
		return &OperationError{Stage: StageWrite, Err: err}
	}
	plistPath := filepath.Join(directory, definition.Label+".plist")
	service := "gui/" + strconv.Itoa(manager.config.uid) + "/" + definition.Label
	domain := "gui/" + strconv.Itoa(manager.config.uid)
	fingerprint, _ := definitionFingerprint(definition)
	expected := launchAgentObservation{
		plistPath: plistPath, program: definition.Program,
		arguments: append([]string{definition.Program}, definition.Arguments...), fingerprint: fingerprint,
	}
	if diskDefinitionMatches(plistPath, content, manager.config.uid) {
		if output, printErr := manager.config.run(ctx, "print", service); printErr == nil {
			if observation, parseErr := parseLaunchAgentObservation(output); parseErr == nil && observation.matches(expected) {
				return nil
			}
		}
	}
	if err := writePlistAtomically(directory, plistPath, content, manager.config.uid, manager.config.gid); err != nil {
		return &OperationError{Stage: StageWrite, Err: err}
	}
	_, _ = manager.config.run(ctx, "bootout", service)
	if err := manager.waitUntilUnloaded(ctx, service); err != nil {
		return &OperationError{Stage: StageBootout, Err: err}
	}
	bootstrapOutput, bootstrapErr := manager.config.run(ctx, "bootstrap", domain, plistPath)
	if err := manager.waitUntilLoaded(ctx, service, expected); err != nil {
		if bootstrapErr != nil {
			return &OperationError{Stage: StageBootstrap, Err: errors.New(string(bytes.TrimSpace(bootstrapOutput)))}
		}
		return &OperationError{Stage: StageObserve, Err: err}
	}
	return nil
}

func acquireProcessLock(ctx context.Context, key string) (func(), error) {
	keyedProcessLocks.Lock()
	semaphore := keyedProcessLocks.items[key]
	if semaphore == nil {
		semaphore = make(chan struct{}, 1)
		keyedProcessLocks.items[key] = semaphore
	}
	keyedProcessLocks.Unlock()
	select {
	case semaphore <- struct{}{}:
		return func() { <-semaphore }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

type heldFileLock struct{ file *os.File }

func acquireFileLock(ctx context.Context, path string, uid int, retryInterval time.Duration) (*heldFileLock, error) {
	fd, err := unix.Open(path, unix.O_CREAT|unix.O_RDWR|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	var stat unix.Stat_t
	if unix.Fstat(fd, &stat) != nil || int(stat.Uid) != uid || stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Mode&0o777 != 0o600 || stat.Nlink != 1 {
		file.Close()
		return nil, ErrInvalidDirectory
	}
	for {
		if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err == nil {
			return &heldFileLock{file: file}, nil
		} else if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
			file.Close()
			return nil, err
		}
		timer := time.NewTimer(retryInterval)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			file.Close()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

func (lock *heldFileLock) release() {
	if lock == nil || lock.file == nil {
		return
	}
	_ = unix.Flock(int(lock.file.Fd()), unix.LOCK_UN)
	_ = lock.file.Close()
}

func verifyProgram(path, expectedHash string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return ErrInvalidDefinition
	}
	digest := sha256.New()
	if _, err := file.WriteTo(digest); err != nil {
		return err
	}
	returnHash := hex.EncodeToString(digest.Sum(nil))
	if returnHash != expectedHash {
		return ErrInvalidDefinition
	}
	return nil
}

func ensureLaunchAgentsDirectory(directory string, uid int) error {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 ||
		(info.Mode().Perm() != 0o700 && info.Mode().Perm() != 0o755) {
		return ErrInvalidDirectory
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != uid {
		return ErrInvalidDirectory
	}
	return nil
}

func writePlistAtomically(directory, path string, content []byte, uid, gid int) error {
	temporary, err := os.CreateTemp(directory, ".launchd-agent-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if temporary.Chmod(0o600) != nil || temporary.Chown(uid, gid) != nil {
		_ = temporary.Close()
		return ErrInvalidDirectory
	}
	if _, err := temporary.Write(content); err != nil || temporary.Sync() != nil || temporary.Close() != nil {
		return ErrInvalidDirectory
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	return syncDirectory(directory)
}

func syncDirectory(directory string) error {
	file, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}

func diskDefinitionMatches(path string, expected []byte, uid int) bool {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 || info.Mode()&os.ModeSymlink != 0 {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != uid {
		return false
	}
	actual, err := os.ReadFile(path)
	return err == nil && bytes.Equal(actual, expected)
}

func (manager *Manager) waitUntilUnloaded(ctx context.Context, service string) error {
	return manager.poll(ctx, func() (bool, error) {
		_, err := manager.config.run(ctx, "print", service)
		return err != nil, nil
	})
}

func (manager *Manager) waitUntilLoaded(ctx context.Context, service string, expected launchAgentObservation) error {
	return manager.poll(ctx, func() (bool, error) {
		output, err := manager.config.run(ctx, "print", service)
		if err != nil {
			return false, nil
		}
		observation, err := parseLaunchAgentObservation(output)
		if err != nil {
			return false, nil
		}
		if !observation.matches(expected) {
			return false, ErrIdentityMismatch
		}
		return true, nil
	})
}

func (manager *Manager) poll(ctx context.Context, check func() (bool, error)) error {
	deadline := time.NewTimer(manager.config.transitionTimeout)
	defer deadline.Stop()
	for {
		ready, err := check()
		if err != nil || ready {
			return err
		}
		retry := time.NewTimer(manager.config.retryInterval)
		select {
		case <-ctx.Done():
			if !retry.Stop() {
				<-retry.C
			}
			return ctx.Err()
		case <-deadline.C:
			if !retry.Stop() {
				<-retry.C
			}
			return errors.New("launchd transition timeout")
		case <-retry.C:
		}
	}
}

type launchAgentObservation struct {
	plistPath   string
	program     string
	arguments   []string
	fingerprint string
}

func (observation launchAgentObservation) matches(expected launchAgentObservation) bool {
	return filepath.Clean(observation.plistPath) == filepath.Clean(expected.plistPath) &&
		filepath.Clean(observation.program) == filepath.Clean(expected.program) &&
		reflect.DeepEqual(observation.arguments, expected.arguments) &&
		observation.fingerprint == expected.fingerprint
}

func parseLaunchAgentObservation(output []byte) (launchAgentObservation, error) {
	var observation launchAgentObservation
	section := ""
	for _, rawLine := range strings.Split(string(output), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "arguments = {" || line == "environment = {" {
			section = strings.TrimSuffix(line, " = {")
			continue
		}
		if line == "}" {
			section = ""
			continue
		}
		switch section {
		case "arguments":
			if line != "" {
				observation.arguments = append(observation.arguments, line)
			}
		case "environment":
			parts := strings.SplitN(line, " => ", 2)
			if len(parts) == 2 && parts[0] == definitionFingerprintEnvironmentKey {
				observation.fingerprint = strings.TrimSpace(parts[1])
			}
		default:
			parts := strings.SplitN(line, " = ", 2)
			if len(parts) != 2 {
				continue
			}
			switch parts[0] {
			case "path":
				observation.plistPath = strings.TrimSpace(parts[1])
			case "program":
				observation.program = strings.TrimSpace(parts[1])
			}
		}
	}
	if !filepath.IsAbs(observation.plistPath) || !filepath.IsAbs(observation.program) || len(observation.arguments) == 0 {
		return launchAgentObservation{}, errors.New("invalid launchd observation")
	}
	return observation, nil
}
