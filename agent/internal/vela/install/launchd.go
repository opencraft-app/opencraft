//go:build darwin

package install

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
)

type userLaunchAgent struct {
	home string
	uid  int
	gid  int
}

func NewUserLaunchAgent() (Launcher, error) {
	home, err := os.UserHomeDir()
	if err != nil || !filepath.IsAbs(home) || os.Geteuid() <= 0 {
		return nil, ErrServiceInvalid
	}
	return &userLaunchAgent{home: filepath.Clean(home), uid: os.Geteuid(), gid: os.Getegid()}, nil
}

func (launcher *userLaunchAgent) Start(ctx context.Context, spec LaunchSpec) error {
	if launcher == nil || ctx == nil || spec.Label != launchAgentLabel ||
		filepath.Clean(spec.ProgramPath) != filepath.Join(spec.InstallationRoot, "bin", ProgramName) ||
		filepath.Clean(spec.StateDirectory) != filepath.Join(spec.InstallationRoot, "state") {
		return ErrServiceInvalid
	}
	directory := filepath.Join(launcher.home, "Library", "LaunchAgents")
	if err := ensureLaunchAgentDirectory(directory, launcher.uid); err != nil {
		return err
	}
	if err := ensurePrivateDirectory(filepath.Join(spec.StateDirectory, "logs")); err != nil {
		return err
	}
	content, err := renderLaunchAgent(spec)
	if err != nil {
		return err
	}
	path := filepath.Join(directory, spec.Label+".plist")
	temporary, err := os.CreateTemp(directory, ".vela-launchagent-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if temporary.Chmod(0o600) != nil ||
		temporary.Chown(launcher.uid, launcher.gid) != nil {
		_ = temporary.Close()
		return ErrServiceInvalid
	}
	if _, err := temporary.Write(content); err != nil || temporary.Sync() != nil || temporary.Close() != nil {
		return ErrServiceInvalid
	}
	if err := os.Rename(temporaryPath, path); err != nil || syncDirectory(directory) != nil {
		return ErrServiceInvalid
	}
	domain := "gui/" + strconv.Itoa(launcher.uid)
	service := domain + "/" + spec.Label
	_, _ = exec.CommandContext(ctx, "/bin/launchctl", "bootout", service).CombinedOutput()
	if output, err := exec.CommandContext(ctx, "/bin/launchctl", "bootstrap", domain, path).CombinedOutput(); err != nil {
		return errors.New("无法注册 Vela Computer LaunchAgent: " + string(bytes.TrimSpace(output)))
	}
	if output, err := exec.CommandContext(ctx, "/bin/launchctl", "kickstart", "-k", service).CombinedOutput(); err != nil {
		return errors.New("无法启动 Vela Computer LaunchAgent: " + string(bytes.TrimSpace(output)))
	}
	return nil
}

func renderLaunchAgent(spec LaunchSpec) ([]byte, error) {
	arguments := []string{
		spec.ProgramPath, "daemon", "run", "--state-dir", spec.StateDirectory,
	}
	var output bytes.Buffer
	output.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>`)
	if err := xml.EscapeText(&output, []byte(spec.Label)); err != nil {
		return nil, err
	}
	output.WriteString("</string><key>ProgramArguments</key><array>")
	for _, argument := range arguments {
		output.WriteString("<string>")
		if err := xml.EscapeText(&output, []byte(argument)); err != nil {
			return nil, err
		}
		output.WriteString("</string>")
	}
	output.WriteString("</array><key>StandardOutPath</key><string>")
	if err := xml.EscapeText(&output, []byte(filepath.Join(spec.StateDirectory, "logs", "computer.stdout.log"))); err != nil {
		return nil, err
	}
	output.WriteString("</string><key>StandardErrorPath</key><string>")
	if err := xml.EscapeText(&output, []byte(filepath.Join(spec.StateDirectory, "logs", "computer.stderr.log"))); err != nil {
		return nil, err
	}
	output.WriteString(`</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ProcessType</key><string>Background</string><key>Umask</key><integer>63</integer>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string></dict>
</dict></plist>
`)
	return output.Bytes(), nil
}

func ensureLaunchAgentDirectory(directory string, uid int) error {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 ||
		(info.Mode().Perm() != 0o700 && info.Mode().Perm() != 0o755) {
		return ErrServiceInvalid
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != uid {
		return ErrServiceInvalid
	}
	return nil
}
