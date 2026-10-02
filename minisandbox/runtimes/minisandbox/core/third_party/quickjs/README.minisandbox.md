# QuickJS provenance

This directory contains the minimal QuickJS core source set required by the
minisandbox guest runtime. It intentionally excludes the `qjs` CLI,
`quickjs-libc`, dynamic module loading, examples, tests, and build products.

- Upstream: <https://github.com/bellard/quickjs>
- Upstream commit: `04be246001599f5995fa2f2d8c91a0f198d3f34c`
- Upstream version: `2026-06-04`
- Imported: `2026-08-14`
- License: MIT; see `LICENSE`

The imported files are byte-for-byte copies of the named upstream commit.
`conformance/build.rs` compiles them into a static, stripped x86_64 Linux guest
fixture; QuickJS is never linked into the minisandbox host process.
