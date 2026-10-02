# Phase 2 COW Vertical Slice

Status: implementation and full gate complete; final commit pending

| ID | Requirement | RED evidence | Passing gate |
|---|---|---|---|
| P2-01 | Seal every writable user leaf in both PVM roots | paging API/test did not exist | exact supervisor/user PTE assertions pass |
| P2-02 | Share an immutable clean guest image | template/fork API did not exist | master, child, and sibling report the same sealed memfd identity |
| P2-03 | Resolve a real PVM write fault at 4 KiB granularity | real conformance test did not compile | first child write resumes and dirties exactly one page |
| P2-04 | Preserve master and sibling bytes | no runtime COW path existed | live PVM test observes unchanged master/sibling bytes |
| P2-05 | Reclaim child-private data on destruction | no ownership counter existed | 32 fork/run/drop turns return the live-private count to zero |
| P2-06 | Keep clean reads shared | no template instance existed | clean-read turn reports zero COW faults and dirty pages |
| P2-07 | Expose typed C lifecycle | template exports did not exist | generated ABI 1.1 header and live lifecycle test pass |
| P2-08 | Keep host preemption signal-safe under concurrency | parallel live tests were killed by signal 34 | shared signal manager and 30-round parallel stress pass |
| P2-09 | Classify all x86 exception vectors independently of syscalls | vector zero shared port `0x80` during review | live divide-error test returns `GuestFault` |

## Implemented ownership model

- A `Template` owns a sealed memfd baseline, immutable COW lookup plan, boot
  state, and a template-scoped live-private-page counter.
- Each `TurnInstance` owns a new VM/vCPU, a `MAP_PRIVATE` view of the same
  baseline, private root/PVCS pages, and its own dirty-page set.
- Writable user leaves are sealed read-only in both roots. A validated user
  write-protection fault materializes one 4 KiB data page, updates only the
  child's two leaf PTEs, and resumes through the PVM TLB invalidation path.
- Instance destruction unmaps its private view and decrements the template's
  exact live-private data-page count.

## Scope boundary

This slice proves the PVM COW substrate using validated static ELF programs.
It does not yet create a quiescent, warmed QuickJS heap checkpoint, reset an
existing child, implement transactional Actor state, or provide production
RSS/PSS density benchmarks. The installed legacy PVM ABI is live-tested;
modern ABI event offsets are encoded but not live-tested on this host.
