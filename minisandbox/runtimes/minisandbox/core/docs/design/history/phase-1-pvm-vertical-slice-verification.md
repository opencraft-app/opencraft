# Phase 1 Verification Map

Status: complete (implementation commit `734a6da`)

| ID | Requirement | Red test/evidence | Passing gate |
|---|---|---|---|
| P1-01 | Published modern PVCS/MSR ABI is exact | `pvcs_contract` missing declarations | size/offset/value assertions pass |
| P1-02 | Installed 6.7 legacy ABI is supported without version guessing | scripted and live MSR probe fails | designated host classified as legacy |
| P1-03 | PVM is mandatory and never falls back | scripted missing-PVM probe | `UnsupportedPvm` returned before program creation |
| P1-04 | FSGSBASE and required KVM facilities are checked | scripted missing feature | diagnostic names exact missing capability |
| P1-05 | User/supervisor mappings are isolated | paging tests attempt forbidden lookup | user root cannot resolve supervisor/PVCS/PT pages |
| P1-06 | PVM user mode is reached through PVCS/ERETU | raw user-transition test has no engine | expected exit observed on remote host |
| P1-07 | Minimal ELF is validated before KVM use | malformed ELF matrix | every invalid fixture returns typed loader error |
| P1-08 | `write` resumes and `exit` terminates | minimal ELF black-box tests | exact output and exit code 73 |
| P1-09 | Timeout interrupts a running PVM vCPU | infinite-loop fixture | typed timeout and clean teardown |
| P1-10 | C ABI is stable and defensive | C compile/invalid-input tests | C11/C17 GCC/Clang and negative cases pass |
| P1-11 | Handles are process-local and generation checked | stale/wrong-kind/double-release tests | deterministic `INVALID_HANDLE`/`WRONG_HANDLE_KIND` |
| P1-12 | Panic never crosses C | injected panic test | stable internal status and retrievable error |
| P1-13 | Unsafe code is contained | `xtask unsafe-audit` initially reports violations | only approved files/blocks remain |
| P1-14 | Macro-first implementation reduces repetition | macro UI/expansion and LOC tests | compiler expansion and handwritten LOC gates pass; C-visible declarations remain explicit for cbindgen |
| P1-15 | No C++ compatibility trace is shipped | repository extension/content scan | no C++ source/build dependency/facade found |

## Evidence Rules

- Red and green outputs include command, exit status, UTC timestamp, Git commit,
  OS/kernel, and host classification.
- A test failure caused by a missing tool, network, permission, or unrelated
  compile error is not valid red evidence.
- Remote-only rows cannot be marked green from mocks or a hardware-KVM host.
- A later broad test pass cannot erase an earlier failed gate; the failure and
  its fixing commit remain in evidence.

## Remote Environment Record

Record before each phase gate:

```text
uname -a
cat /etc/os-release
modinfo kvm_pvm
sha256sum /lib/modules/6.7.12+/kernel/arch/x86/kvm/kvm-pvm.ko
rustc --version
cargo --version
git rev-parse HEAD
sha256sum Cargo.lock
```

## Phase 1 Release Command

The phase is green only when one remote command sequence runs formatting,
clippy, the full workspace tests, real PVM conformance, header drift checks,
unsafe audit, the C smoke consumer, and LOC reporting against the same commit.
