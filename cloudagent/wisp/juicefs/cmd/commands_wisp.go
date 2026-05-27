//go:build wispcli

package cmd

import "github.com/urfave/cli/v2"

func commandSet() []*cli.Command {
	return []*cli.Command{
		cmdVersion(),
		cmdSFormat(),
		cmdSMount(),
		cmdAssertMount(),
		cmdClone(),
		cmdMetaBarrier(),
		cmdFileBarrier(),
		cmdWritebackBarrier(),
		cmdWritebackCutBarrier(),
		cmdLitestreamMaintenance(),
	}
}

func mountCommandFlags() []cli.Flag {
	return cmdSMount().Flags
}
