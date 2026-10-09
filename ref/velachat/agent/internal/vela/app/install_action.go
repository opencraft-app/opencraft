package app

import (
	"context"

	velacli "velachat/agent/internal/vela/cli"
	velainstall "velachat/agent/internal/vela/install"
)

func (a *Actions) Install(ctx context.Context, options velacli.InstallOptions) error {
	factory := a.config.InstallerFactory
	if factory == nil {
		factory = func() (FirstInstaller, error) {
			return velainstall.NewService(velainstall.ServiceConfig{
				Stdout: a.config.Stdout,
				TAT:    a.config.TAT,
			})
		}
	}
	installer, err := factory()
	if err != nil {
		return err
	}
	return installer.Install(ctx, velainstall.Options{
		PlatformURL:               options.PlatformURL,
		AllowInsecurePlatformHTTP: options.AllowInsecurePlatformHTTP,
		TokenFile:                 options.TokenFile, ManifestFile: options.ManifestFile,
		SignatureFile: options.SignatureFile, SigningPublicKey: options.SigningPublicKey,
		ReleaseVersion: options.ReleaseVersion, Target: options.Target,
		ProgramFile: options.ProgramFile, InstallationRoot: options.InstallationRoot,
		StateDirectory: options.StateDirectory,
	})
}
