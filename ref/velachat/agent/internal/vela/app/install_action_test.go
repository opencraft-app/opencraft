package app

import (
	"bytes"
	"context"
	"path/filepath"
	"testing"

	velacli "velachat/agent/internal/vela/cli"
	velainstall "velachat/agent/internal/vela/install"
)

func TestInstallDelegatesCanonicalFirstInstallOptions(t *testing.T) {
	t.Parallel()

	recorder := &recordingFirstInstaller{}
	actions, err := NewActions(Config{
		Root: t.TempDir(), Version: "test-version",
		Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{},
		InstallerFactory: func() (FirstInstaller, error) { return recorder, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	options := velacli.InstallOptions{
		PlatformURL: "http://192.0.2.10", AllowInsecurePlatformHTTP: true,
		TokenFile: filepath.Join(root, "token"), ManifestFile: filepath.Join(root, "manifest"),
		SignatureFile: filepath.Join(root, "signature"), SigningPublicKey: "key",
		ReleaseVersion: "0.2.0", Target: "darwin-arm64",
		ProgramFile:      filepath.Join(root, "vela-computer"),
		InstallationRoot: filepath.Join(root, ".vela"),
		StateDirectory:   filepath.Join(root, ".vela", "state"),
	}
	if err := actions.Install(context.Background(), options); err != nil {
		t.Fatal(err)
	}
	if recorder.options.ProgramFile != options.ProgramFile ||
		recorder.options.InstallationRoot != options.InstallationRoot {
		t.Fatalf("installer options = %#v", recorder.options)
	}
}

type recordingFirstInstaller struct{ options velainstall.Options }

func (installer *recordingFirstInstaller) Install(_ context.Context, options velainstall.Options) error {
	installer.options = options
	return nil
}
