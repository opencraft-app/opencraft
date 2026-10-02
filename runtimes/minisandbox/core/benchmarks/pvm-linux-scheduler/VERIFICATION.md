# PVM idle attribution verification

Verified on 2026-08-16 with the pinned PVM Linux 6.7.12 guest, a 6.7.12+ host,
four host CPUs, 256 MiB virtual RAM per clone, and 64 concurrent clones. Each
variant uses a synchronized 30-second interval after all guests emit
`MSBENCH_IDLE_READY`. The driver also waits one second before readiness so the
one-time boot-clocksource switch and its serial output cannot pollute steady
idle attribution.

Three order-rotated repetitions produced these medians; brackets show the
observed host CPU range:

| Variant | Host CPU | One-core share | Runner CPU | voluntary CS | KVM_RUN | UART exits | Guest timer IRQ | kvm-pit CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native PVM halt | 258.975 ms [256.517, 265.887] | 0.863% | 255.387 ms | 1,641 | 1,472 | 960 | 903 | 0 ns* |
| halt polling off | 249.144 ms [239.491, 261.019] | 0.830% | 245.893 ms | 1,644 | 1,472 | 960 | 921 | 0 ns* |
| `HC_WAIT_UNTIL` | 266.967 ms [229.553, 279.232] | 0.890% | 263.980 ms | 937 | 2,112 | 960 | 914 | 0 ns* |

`*` The three rotated runs initially bounded `kvm-pit` CPU with coarse process
ticks. A final independent A/B/C run used every matching thread's nanosecond
`/proc/<pid>/task/<tid>/schedstat` counter: all 64 `kvm-pit/<pid>` threads were
found in every variant and their aggregate runtime delta was exactly zero.

Disabling halt polling reduced median host CPU by 3.8%, but that is only 9.831
ms across 64 clones over 30 seconds (0.033% of one core), and it changed no exit
count. It remains a promising host-policy knob, but needs the wake-latency suite
before becoming a default. The final `HC_WAIT_UNTIL` path increased median host
CPU by 3.1%, added a median 704 fixed hypercall exits and bounded host polls,
and did not reduce UART exits. It did reduce voluntary context switches by
about 43%, but that did not translate to a CPU reduction on this host.
`KVM_EXIT_HLT` was zero in every run because the PVM provider handles
`PVM_HC_IRQ_HALT` inside the kernel rather than returning HLT to userspace. The
evidence therefore says to retain native PVM halt as the default and keep
`HC_WAIT_UNTIL` opt-in.

An early implementation incorrectly called `tick_nohz_get_sleep_length()`
after Linux had already stopped the tick. That mutates NO_HZ bookkeeping and
triggered `tick_nohz_idle_enter/exit` warnings plus thousands of console exits.
The final patch only reads `tick_nohz_get_next_hrtimer()` and was rebuilt and
retested without those warnings.
