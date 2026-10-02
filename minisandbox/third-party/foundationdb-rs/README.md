# FoundationDB Rust source receipt

This directory vendors only the patched `foundationdb-sys` crate required by Rivet. The rest of
`foundationdb-rs` continues to resolve from crates.io at version `0.9.1`.

The patch preserves the normal dynamic `fdb_c` link behavior. Release builds may select an explicit
static dependency graph with `FDB_CLIENT_LINK_KIND=static`; the build script validates every
library name before emitting Cargo link directives.

`SOURCE.lock` records the upstream commit, the project fork commit, the exact crate tree, and the
checksums of the two modified build files. Update the receipt whenever the vendored crate changes.
