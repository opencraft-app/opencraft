//go:build !wispcli

package cmd

import "github.com/urfave/cli/v2"

func commandSet() []*cli.Command {
	return []*cli.Command{
		cmdFormat(),
		cmdSFormat(),
		cmdConfig(),
		cmdQuota(),
		cmdDestroy(),
		cmdGC(),
		cmdFsck(),
		cmdRestore(),
		cmdDump(),
		cmdLoad(),
		cmdVersion(),
		cmdStatus(),
		cmdStats(),
		cmdProfile(),
		cmdInfo(),
		cmdMount(),
		cmdSMount(),
		cmdAssertMount(),
		cmdUmount(),
		cmdGateway(),
		cmdWebDav(),
		cmdBench(),
		cmdObjbench(),
		cmdMdtest(),
		cmdWarmup(),
		cmdRmr(),
		cmdSync(),
		cmdDebug(),
		cmdClone(),
		cmdSummary(),
		cmdCompact(),
		cmdMetaBarrier(),
		cmdFileBarrier(),
		cmdWritebackBarrier(),
		cmdWritebackCutBarrier(),
		cmdLitestreamMaintenance(),
		cmdExt4ReadWriteDemo(),
		cmdTier(),
	}
}

func mountCommandFlags() []cli.Flag {
	return cmdMount().Flags
}
