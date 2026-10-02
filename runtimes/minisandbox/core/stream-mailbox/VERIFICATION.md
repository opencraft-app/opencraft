# Verification record

Last run: 2026-08-17

The following checks were run from this directory:

| Check | Result |
| --- | --- |
| `cargo fmt --all -- --check` | Passed as part of the top-level workspace |
| `cargo test --workspace --all-targets` | Passed for the complete minisandbox workspace |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | Passed |
| `cargo check --locked --manifest-path fuzz/Cargo.toml` | Passed |
| `RUSTC_BOOTSTRAP=1 cargo-fuzz run protocol -- -runs=200000` with Rust 1.96 ASan instrumentation | Passed: 200,000 executions, `cov=494`, `ft=2487`, no crash or invariant failure |
| `cargo kani` | Not rerun for ABI v6: `cargo-kani` is not installed in this environment |
| `cargo xtask pvm-linux configure && cargo xtask pvm-linux build` | Passed against pinned Linux base; `minisandbox_guest.o` and `bzImage` rebuilt |
| PVM Linux initramfs smoke | Passed through `MINISANDBOX_PVM_LINUX_OK` |

The previous two Kani harnesses passed for wire ABI v1. Capability/session
types changed in ABI v2, `DnsQuery` was added in ABI v3, v4 made the four-slot
transport contract mandatory, v5 adds header event-index notification
suppression, and v6 adds bounded ingress commands. That result is deliberately
not claimed for current code. The
harness source remains a required rerun when `cargo-kani` is available.

The current libFuzzer target decodes arbitrary ABI v6 guest commands and host
events, exercises the socket endpoint parser, mutates wrapping producer and
consumer cursors, and drives capability/slot/reset transition sequences. Every
rejected state or cursor transition must leave its host-private state
unchanged, and every accepted descriptor must survive canonical round-trip
encoding. The installed nightly predates the workspace's Rust 1.96 minimum, so
the run used the current 1.96 compiler with `RUSTC_BOOTSTRAP=1` only to enable
libFuzzer's sanitizer/coverage flags; it did not relax project code checks.

The TLA+ model has been written but not yet executed because a Java/TLC runtime
is not installed in this environment. It is therefore a reviewable model, not
currently evidence of a completed TLC proof.

These are bounded checks of the protocol model. Shared-memory, broker, IRQ and
guest-kernel checks are recorded separately in `../socket-service/VERIFICATION.md`.
