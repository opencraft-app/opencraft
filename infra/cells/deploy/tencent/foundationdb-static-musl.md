# FoundationDB client source/static-musl qualification

## Target

`rivet-engine` must not require the host's glibc or a runtime `libfdb_c.so`. The intended artifact
is one `x86_64-unknown-linux-musl` ELF that contains the FoundationDB 7.3.79 C/C++ client compiled
from the exact source revision recorded in `foundationdb-source.lock`.

This is a source-build qualification, not an assertion that Apple distributes or supports a static
musl client. FoundationDB 7.3.79's upstream CMake creates `fdb_c` as `SHARED` on Linux and the
official C API documentation describes `libfdb_c.so`. This repository therefore carries an
explicit `FDB_STATIC_C_CLIENT` source patch and must own the additional ABI and upgrade testing.

The build may use a disposable build environment. The runtime deployment remains native systemd;
there is no runtime container image and no extracted `.so` sidecar.

## Required gates

| Gate | Pass condition |
|---|---|
| Source provenance | Repository, tag, commit, source tree hash, compiler, CMake and Rust versions are recorded |
| Real static client | No embedded/extracted `libfdb_c.so`; no compatibility loader or glibc bundle |
| ELF | `readelf -l` has no program interpreter and `ldd` reports a non-dynamic executable |
| Native symbols | `readelf -d` has no `NEEDED`; `nm` proves the selected FDB C API is defined in the artifact |
| API compatibility | Client selects API 730 and connects to the real Beijing 7.3.79 cluster |
| Correctness | Existing UniversalDB FDB driver tests plus real commit/read/range/atomic/versionstamp/retry gates pass |
| Runtime lifecycle | FDB network boot/shutdown, Engine restart, DNS/cluster-file errors and TLS policy fail deterministically |
| Failure | One FDB process and one AZ loss are repeated with the static client; no stale success or data mismatch |
| Upgrade | The exact client source version is an immutable release input; changing it requires the full gate again |
| License | Apache-2.0 license and required notices ship with the release provenance |

## Non-solutions

- Linking the Rust portion with musl while retaining `DT_NEEDED=libfdb_c.so` is not static.
- Packing the glibc `.so` as bytes and extracting it at startup is still a glibc runtime dependency.
- Adding `gcompat`, a glibc layer, or a runtime container only hides the dependency.
- Using the multi-version shim still uses `dlopen` and does not meet this artifact contract.

## Current status

The exact upstream source is cloned at `upstream/foundationdb-7.3.79`. Its C binding CMake now has
an opt-in static target and publishes the native client dependency edge to static consumers. The
source tree also guards glibc-only profiling, unwind, device-number and allocation paths; makes
Clang's `libatomic`, Boost `-nostdlib++`, and ELF build-ID flags explicitly configurable; and
includes the missing POSIX type declarations. `foundationdb-source.lock` pins both upstream commit
`0074653ee0113fc39da0fa088b056c7210ab3191` and the complete tracked patch SHA-256
`2d1a4bacd4739bb7ff53c94b9c947f86f4ea4bad4996ddafc732865373a93772`. Untracked source inputs or
any patch drift fail before compilation.

The reproducible build entry points are:

- `build-foundationdb-static-musl.sh`: accepts only Zig 0.14.1 and the locked FDB commit, downloads
  zlib 1.3.2 and OpenSSL 3.5.7 from their official sites, verifies their pinned SHA-256 values,
  builds the complete C++ client graph for `x86_64-linux-musl`, and rejects an FDB probe with an
  interpreter or `DT_NEEDED` entry.
- `build-rivet-engine-static-musl.sh`: gives `foundationdb-sys` an explicit, ordered static archive
  graph, links the Engine for Rust's musl target, rejects GLIBC/shared dependencies, and proves the
  final ELF defines `fdb_select_api_version_impl`.
- `qualify-foundationdb-static-musl.sh`: links the UniversalDB integration and FDB-network lifecycle
  tests through the same static archive graph and runs them against an explicitly acknowledged,
  non-production FDB cluster. The opt-in is required because the suite owns and clears its reserved
  `test` subspace.
- `test-foundationdb-static-link-config.sh`: tests dynamic backward compatibility, mandatory static
  dependency declaration, archive ordering, linker-argument injection rejection, source pins, and
  the ELF gates. It also avoids `grep -q` in large `nm`/`readelf` pipelines so SIGPIPE cannot create
  a false build failure.

`foundationdb-sys` still defaults to its upstream dynamic behavior. Static linkage is an explicit
release input (`FDB_CLIENT_LINK_KIND=static`) and fails closed unless the transitive archive graph
is supplied. This prevents a developer build from accidentally claiming to be the static release.

### Beijing source-build evidence — 2026-08-16

The existing Beijing builder compiled the full FDB 7.3.79 client graph with Zig 0.14.1 for
`x86_64-linux-musl`; no new VM, TKE node, container image, or runtime filesystem layer was created.
The final PIC build invocation was `inv-67ffb6gw4i`, and immutable artifact freeze invocation
`inv-67ffbhgf9d` produced:

- artifact directory: `/var/lib/actor-build/fdb-musl-artifacts-pic-e719998b1c3a91b4`;
- `MANIFEST.sha256` SHA-256:
  `e719998b1c3a91b4d285eaaf8c6939469551aa7993a43a05105e6f45b5172069`;
- `SOURCE.lock` SHA-256:
  `bc90ba7b6e19801d481642d05c2c44410c1242cf89d203e3cec2d3d2e10d37a8`;
- patched source tree SHA-256:
  `2464add756d92ee646970e13c70b0b16a6b76cc9f34da6bce5310f9b50741e5c`;
- static PIE probe SHA-256:
  `67ce1876673ec6ce5c1aaadc6eddde790880b72a8ebd3e58fea705d5af8eaf2`;
- `libfdb_c.a` SHA-256: `c758c9be60a42e5fc5d5b78010beea66a7ea1577c096a5b76c77445dfef132af`;
- no ELF interpreter, `DT_NEEDED`, or `GLIBC_*` version requirement;
- defined `fdb_select_api_version_impl` and successful probe execution.

Final Engine build invocation `inv-77fh9jggv9` produced SHA-256
`61e0c94e3211d841818f6be93aff619c7e7821bdb47abed2102f6378c3042eb1`. Independent ELF gate
`inv-67fhp9g98e` proved a stripped `ET_DYN` static PIE with no interpreter, `DT_NEEDED`,
`GLIBC_*`, `libfdb_c.so`, or no-FoundationDB feature marker. Real Cell B FDB qualification
`inv-67fhpxgd5c` passed the UniversalDB commit/read/range/conflict/atomic/versionstamp/retry test
and all three process-network and error-classification tests.

Deployment and bounded restart invocation `inv-77fhsngk6n` installed native release
`7951f4fa88283bde-9e8fc1af5f753202-61e0c94e3211d841`. On shutdown, all stateful services drained,
the Sentry transport reached its explicit five-second deadline, Tokio reached its separate
five-second blocking-pool deadline, and systemd recorded `Succeeded` and `Stopped` after 10 seconds.
There was no stop timeout or SIGKILL. The permanent unit has `TimeoutStopSec=620s`; the temporary
20-second proof drop-in was removed after the test.

Cloud-side Actor lifecycle invocation `inv-67fhvqg9ji` then passed with eight Actors and 24
acknowledged increments. The exact registry sequence was `0 -> 8 -> 0 -> 8 -> 0`; every Actor
advanced from generation 1 to generation 2 with the same SQL count, and cleanup had no errors.
The result is
`/var/lib/actor-loadgen/results/static-musl-bounded-shutdown-8-20260816T102449Z.json`, SHA-256
`638ee71084ca05f371cdd6925ccab535e2c695dedbd856c8b0645d04194e76d2`.

This closes the static client, real-cluster correctness, native deployment, and bounded Engine
lifecycle gates. It does not substitute for repeating the one-AZ and compound-fault load gates
with this exact Engine SHA.
