# ext4sdk

Experimental CGO wrapper for `lwext4`.

This package is intentionally isolated from the main JuiceFS runtime. The goal
is to provide:

- a Go-facing block device interface
- a small wrapper over `lwext4` mount/mkfs/file APIs
- a path to later plug a JuiceFS-backed large file in as the ext4 block device

## Build model

The package has two modes:

- default builds: stub only, no `lwext4` dependency
- experimental builds: `linux + cgo + lwext4sdk`

The real implementation expects vendored `lwext4` sources under:

`third_party/lwext4`

and a prebuilt static library at:

`third_party/lwext4/build_lib_only/src/liblwext4.a`

## Build the vendored static library

From the JuiceFS repo root:

```bash
make lwext4.lib
```

## Run the experimental smoke test

```bash
make test.ext4sdk
```

or directly:

```bash
go test ./pkg/ext4sdk -tags lwext4sdk -run TestFileBackendMkfsMountReadWrite -v
```

## Current status

Currently implemented:

- blockdev bridge for `lwext4`
- file-backed `BlockBackend`
- JuiceFS-backed large-file `BlockBackend`
- `mkfs -> mount -> mkdir -> write -> read -> readdir`

There is also a demo command in the JuiceFS CLI:

```bash
juicefs ext4readwritedemo META-URL --block-path /block.bin --size-gb 100
```

The demo:

- opens a JuiceFS volume internally without FUSE
- ensures `/block.bin` exists as a sparse JuiceFS file
- formats it as ext4 when needed
- mounts it through `lwext4`
- demonstrates `mkdir`, `write`, `read`, and `readdir`

Not implemented yet:

- lifecycle/recovery policy for production use
