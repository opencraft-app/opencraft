package cmd

import (
	"net/url"
	"strings"

	"github.com/urfave/cli/v2"
)

func cmdSFormat() *cli.Command {
	return &cli.Command{
		Name:      "sformat",
		Action:    sformat,
		Category:  "ADMIN",
		Usage:     "Format a workspace-backed volume with templated S3-compatible metadata and data paths",
		ArgsUsage: "WORKSPACE",
		Description: `
Format a JuiceFS volume using a single workspace name. The command derives:

- local SQLite writable-VFS working file
- S3-compatible replica path for metadata
- S3-compatible data prefix
- volume name

This is the formatting counterpart of "smount".
`,
		Flags: expandFlags(
			formatStorageFlags(),
			formatFlags(),
			formatManagementFlags(),
			[]cli.Flag{
				&cli.BoolFlag{
					Name:  "force",
					Usage: "overwrite existing format",
				},
				&cli.BoolFlag{
					Name:  "no-update",
					Usage: "don't update existing volume",
				},
				&cli.StringFlag{
					Name:  "meta-base",
					Value: "/tmp/jfs-smount-meta",
					Usage: "base directory for the local SQLite writable-VFS working database",
				},
				&cli.StringFlag{
					Name:  "local-root",
					Usage: "local root prefix; when set, default meta-base is derived under <local-root>/<workspace>/",
				},
				&cli.StringFlag{
					Name:  "workspace-prefix",
					Value: "workspace",
					Usage: "S3-compatible prefix root used for metadata replica and data path under the workspace",
				},
				&cli.StringFlag{
					Name:  "sync-interval",
					Value: defaultSMountSyncInterval,
					Usage: "litestream writable-VFS sync interval encoded into the generated META-URL",
				},
				&cli.StringFlag{
					Name:  "barrier-timeout",
					Value: defaultSMountBarrierTimeout,
					Usage: "litestream writable-VFS barrier timeout encoded into the generated META-URL",
				},
				&cli.StringFlag{
					Name:  "runtime-maintenance",
					Value: defaultSMountRuntimeMode,
					Usage: "litestream runtime maintenance mode encoded into the generated META-URL",
				},
				&cli.StringFlag{
					Name:  "snapshot-interval",
					Value: defaultSMountSnapshotInterval,
					Usage: "litestream snapshot interval encoded into the generated META-URL",
				},
				&cli.StringFlag{
					Name:  "volume-name",
					Usage: "override the JuiceFS volume name; default is the workspace",
				},
			},
		),
	}
}

func sformat(c *cli.Context) error {
	setup(c, 1)

	workspace, err := sWorkspaceArg(c)
	if err != nil {
		return err
	}
	if err := applyLocalRootDefaults(c, workspace, false); err != nil {
		return err
	}

	addr, _, bucketURL, err := buildSMountTarget(c, workspace)
	if err != nil {
		return err
	}
	return formatSMountTarget(c, workspace, addr, bucketURL)
}

func disableSQLiteHydration(addr string) string {
	base, queryStr, ok := strings.Cut(addr, "?")
	if !ok {
		return addr
	}
	q, err := url.ParseQuery(queryStr)
	if err != nil {
		return addr
	}
	q.Del("litestream_hydration")
	encoded := q.Encode()
	if encoded == "" {
		return base
	}
	return base + "?" + encoded
}
