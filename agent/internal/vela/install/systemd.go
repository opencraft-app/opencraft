package install

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

const linuxSystemdUnit = "vela-computer.service"

type systemdCommandRunner interface {
	Run(context.Context, string, ...string) ([]byte, error)
}

type systemdLauncherConfig struct {
	Runner       systemdCommandRunner
	Systemctl    string
	UnitPath     string
	EffectiveUID func() int
}

type computerSystemdLauncher struct{ config systemdLauncherConfig }

func newComputerSystemdLauncher(config systemdLauncherConfig) (*computerSystemdLauncher, error) {
	if config.Runner == nil || !cleanAbsolute(config.Systemctl) || !cleanAbsolute(config.UnitPath) ||
		config.EffectiveUID == nil {
		return nil, ErrServiceInvalid
	}
	return &computerSystemdLauncher{config: config}, nil
}

func (launcher *computerSystemdLauncher) Start(ctx context.Context, spec LaunchSpec) error {
	if launcher == nil || ctx == nil || launcher.config.EffectiveUID() != 0 ||
		spec.Label != linuxSystemdUnit || !cleanAbsolute(spec.ProgramPath) ||
		!cleanAbsolute(spec.InstallationRoot) || !cleanAbsolute(spec.StateDirectory) ||
		filepath.Clean(spec.ProgramPath) != filepath.Join(spec.InstallationRoot, "bin", ProgramName) ||
		filepath.Clean(spec.StateDirectory) != filepath.Join(spec.InstallationRoot, "state") ||
		len(spec.ProgramSHA256) != 64 || len(spec.RuntimeConfigDigest) != 64 {
		return ErrServiceInvalid
	}
	if err := ensurePrivateDirectory(spec.StateDirectory); err != nil {
		return err
	}
	unit := renderSystemdUnit(spec)
	changed, err := writeSystemdUnit(launcher.config.UnitPath, unit)
	if err != nil {
		return errors.New("Unable to write the Vela Computer systemd unit.")
	}
	if changed {
		if _, err := launcher.config.Runner.Run(ctx, launcher.config.Systemctl, "daemon-reload"); err != nil {
			return errors.New("Unable to reload systemd for Vela Computer.")
		}
	}
	if _, err := launcher.config.Runner.Run(
		ctx, launcher.config.Systemctl, "enable", "--now", linuxSystemdUnit,
	); err != nil {
		return errors.New("Unable to enable and start Vela Computer with systemd.")
	}
	enabled, err := launcher.config.Runner.Run(ctx, launcher.config.Systemctl, "is-enabled", linuxSystemdUnit)
	if err != nil || strings.TrimSpace(string(enabled)) != "enabled" {
		return errors.New("Unable to verify that Vela Computer is enabled in systemd.")
	}
	active, err := launcher.config.Runner.Run(ctx, launcher.config.Systemctl, "is-active", linuxSystemdUnit)
	if err != nil || strings.TrimSpace(string(active)) != "active" {
		return errors.New("Unable to verify that Vela Computer is active in systemd.")
	}
	mainPID, err := launcher.config.Runner.Run(
		ctx, launcher.config.Systemctl, "show", linuxSystemdUnit, "--property", "MainPID", "--value",
	)
	pid, parseErr := strconv.ParseUint(strings.TrimSpace(string(mainPID)), 10, 64)
	if err != nil || parseErr != nil || pid == 0 {
		return errors.New("Unable to verify the Vela Computer systemd process.")
	}
	return nil
}

func renderSystemdUnit(spec LaunchSpec) []byte {
	return []byte("[Unit]\n" +
		"Description=Vela Computer\n" +
		"After=network-online.target\n" +
		"Wants=network-online.target\n\n" +
		"[Service]\n" +
		"Type=simple\n" +
		"ExecStart=" + spec.ProgramPath + " daemon run --state-dir " + spec.StateDirectory + "\n" +
		"WorkingDirectory=" + spec.StateDirectory + "\n" +
		"Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n" +
		"Restart=always\n" +
		"RestartSec=3\n" +
		"KillMode=mixed\n" +
		"TimeoutStopSec=20\n" +
		"UMask=0077\n" +
		"# ProgramSHA256=" + spec.ProgramSHA256 + "\n" +
		"# RuntimeConfigDigest=" + spec.RuntimeConfigDigest + "\n\n" +
		"[Install]\n" +
		"WantedBy=multi-user.target\n")
}

func writeSystemdUnit(filename string, content []byte) (bool, error) {
	if info, err := os.Lstat(filename); err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return false, ErrServiceInvalid
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	current, err := os.ReadFile(filename)
	if err == nil && bytes.Equal(current, content) {
		return false, nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	directory := filepath.Dir(filename)
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false, ErrServiceInvalid
	}
	temporary, err := os.CreateTemp(directory, ".vela-computer.service-*.tmp")
	if err != nil {
		return false, err
	}
	temporaryName := temporary.Name()
	ok := false
	defer func() {
		_ = temporary.Close()
		if !ok {
			_ = os.Remove(temporaryName)
		}
	}()
	if err := temporary.Chmod(0o644); err != nil {
		return false, err
	}
	if _, err := temporary.Write(content); err != nil {
		return false, err
	}
	if err := temporary.Sync(); err != nil || temporary.Close() != nil {
		return false, errors.New("systemd unit sync failed")
	}
	if err := os.Rename(temporaryName, filename); err != nil {
		return false, err
	}
	if err := syncDirectory(directory); err != nil {
		return false, err
	}
	ok = true
	return true, nil
}

func cleanAbsolute(value string) bool {
	return filepath.IsAbs(value) && filepath.Clean(value) == value &&
		!strings.ContainsAny(value, " \t\r\n\x00")
}

type execSystemdRunner struct{}

func (execSystemdRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}
