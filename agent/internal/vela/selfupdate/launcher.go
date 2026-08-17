package selfupdate

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

var ErrHelperLaunch = errors.New("Computer Update helper 启动失败")

type helperCommandRunner interface {
	Run(context.Context, string, ...string) ([]byte, error)
}

type systemdHelperLauncher struct {
	runner     helperCommandRunner
	systemdRun string
}

func newSystemdHelperLauncher(
	runner helperCommandRunner,
	systemdRun string,
) (*systemdHelperLauncher, error) {
	if runner == nil || !cleanAbsolute(systemdRun) {
		return nil, ErrHelperLaunch
	}
	return &systemdHelperLauncher{runner: runner, systemdRun: systemdRun}, nil
}

func (launcher *systemdHelperLauncher) Launch(ctx context.Context, command HelperLaunch) error {
	if launcher == nil || ctx == nil || validateHelperLaunch(command, "linux-amd64") != nil {
		return ErrHelperLaunch
	}
	unit := "vela-computer-upgrade-" + command.TransactionID
	_, err := launcher.runner.Run(
		ctx,
		launcher.systemdRun,
		"--unit", unit,
		"--collect",
		"--property=Type=exec",
		"--property=Restart=no",
		"--property=UMask=0077",
		"--",
		command.HelperProgram,
		"upgrade", "apply",
		"--state-dir", command.StateRoot,
		"--transaction-id", command.TransactionID,
		"--parent-pid", strconv.Itoa(command.ParentPID),
	)
	if err != nil {
		return ErrHelperLaunch
	}
	return nil
}

type launchdHelperLauncher struct {
	runner    helperCommandRunner
	launchctl string
	uid       int
}

func newLaunchdHelperLauncher(
	runner helperCommandRunner,
	launchctl string,
	uid int,
) (*launchdHelperLauncher, error) {
	if runner == nil || !cleanAbsolute(launchctl) || uid < 0 {
		return nil, ErrHelperLaunch
	}
	return &launchdHelperLauncher{runner: runner, launchctl: launchctl, uid: uid}, nil
}

func (launcher *launchdHelperLauncher) Launch(ctx context.Context, command HelperLaunch) error {
	if launcher == nil || ctx == nil || validateHelperLaunch(command, "darwin-arm64") != nil {
		return ErrHelperLaunch
	}
	directory := filepath.Dir(command.HelperProgram)
	plist := filepath.Join(directory, "helper.plist")
	label := "com.agentnetwork.vela.computer.upgrade." + strings.ReplaceAll(command.TransactionID, "-", "")
	content := renderHelperLaunchdPlist(label, command)
	if err := writeExclusiveSynced(plist, content, 0o600); err != nil {
		return ErrHelperLaunch
	}
	_, err := launcher.runner.Run(
		ctx, launcher.launchctl, "bootstrap", "gui/"+strconv.Itoa(launcher.uid), plist,
	)
	if err != nil {
		return ErrHelperLaunch
	}
	return nil
}

func validateHelperLaunch(command HelperLaunch, target string) error {
	parsed, err := uuid.Parse(command.TransactionID)
	if err != nil || parsed.Version() != 7 || command.ParentPID <= 0 ||
		command.Target != target || !cleanAbsolute(command.StateRoot) ||
		!cleanAbsolute(command.HelperProgram) ||
		!pathWithin(command.StateRoot, command.HelperProgram) {
		return ErrHelperLaunch
	}
	info, err := os.Lstat(command.HelperProgram)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 ||
		info.Mode().Perm() != 0o700 {
		return ErrHelperLaunch
	}
	return nil
}

func renderHelperLaunchdPlist(label string, command HelperLaunch) []byte {
	var output bytes.Buffer
	output.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n")
	output.WriteString(`<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">` + "\n")
	output.WriteString(`<plist version="1.0"><dict><key>Label</key><string>`)
	_ = xml.EscapeText(&output, []byte(label))
	output.WriteString(`</string><key>ProgramArguments</key><array>`)
	for _, argument := range []string{
		command.HelperProgram, "upgrade", "apply", "--state-dir", command.StateRoot,
		"--transaction-id", command.TransactionID, "--parent-pid", strconv.Itoa(command.ParentPID),
	} {
		output.WriteString(`<string>`)
		_ = xml.EscapeText(&output, []byte(argument))
		output.WriteString(`</string>`)
	}
	output.WriteString(`</array><key>RunAtLoad</key><true/><key>ProcessType</key><string>Background</string>`)
	output.WriteString(`<key>Umask</key><integer>63</integer></dict></plist>` + "\n")
	return output.Bytes()
}

func writeExclusiveSynced(filename string, content []byte, mode os.FileMode) error {
	file, err := os.OpenFile(filename, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(content)
	if writeErr == nil {
		writeErr = file.Sync()
	}
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		_ = os.Remove(filename)
		return ErrHelperLaunch
	}
	return syncDirectory(filepath.Dir(filename))
}

type execHelperCommandRunner struct{}

func (execHelperCommandRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}
