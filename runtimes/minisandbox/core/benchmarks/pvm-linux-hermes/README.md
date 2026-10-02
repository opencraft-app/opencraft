# PVM Linux Hermes benchmarks

This directory drives the pinned Hermes profile through distinct lifecycle
boundaries instead of combining them into one ambiguous startup number:

- offline identity, permissions, version and no-credential CLI startup;
- real upstream GatewayRunner startup to its persisted `running` state;
- deterministic local end-to-end chat through the PVM socket broker;
- sequential clone construction and checkpoint resume;
- concurrent clone construction and checkpoint resume;
- 1, 4, 8 and 20 concurrent fresh-clone-to-answer runs;
- 1, 4, 8 and 20 concurrent live-interpreter clone-to-answer runs;
- 1, 4, 8 and 20 concurrent clone-to-upstream-gateway-ready runs;
- an optional real-provider answer with clone-only credential injection.

The local chat peer implements the bounded subset Hermes actually uses:
OpenAI model probes plus streamed `/v1/chat/completions`. It validates the
prompt and model and returns a fixed marker over SSE. This is a protocol E2E
test, not a model-quality test, and deliberately excludes WAN/model latency.
Every chat concurrency point is run both through a fresh Hermes process and
through the credential-free warm one-shot endpoint restored with the clone.
That endpoint remains a request-latency benchmark; the smoke's gateway check
separately exercises the long-lived upstream daemon lifecycle.

Run the matrix after building the pinned kernel, shared base EROFS,
Hermes-version application EROFS and writable upper image:

```text
./benchmarks/pvm-linux-hermes/run-suite.sh
```

Override artifact paths with `MS_HERMES_KERNEL`, `MS_HERMES_BASE`,
`MS_HERMES_APP`, `MS_HERMES_UPPER`, or `MS_HERMES_MEMORY_MIB`. Real
inference is opt-in:

```text
export OPENROUTER_API_KEY=...
MS_HERMES_REAL_PROVIDER=openrouter \
MS_HERMES_REAL_MODEL=openai/gpt-5-mini \
MS_HERMES_REAL_CREDENTIAL_ENV=OPENROUTER_API_KEY \
  ./benchmarks/pvm-linux-hermes/run-suite.sh
```

The credential value is read by the host harness, added only to the direct
command environment of a fresh clone, and never printed or persisted in the
template. The environment variable name is also checked against a fixed
provider/key allowlist.

Check host capacity before interpreting high-concurrency results. Reserved
hugepages reduce ordinary RAM available to private COW pages even when the
hugepages are unused:

```text
grep -E 'MemAvailable|HugePages_Total|Hugepagesize' /proc/meminfo
```

The suite does not change host hugepage policy automatically.

The gateway handoff contract, security boundary and measured single/4/20-clone
results are recorded in `gateway-daemon.md`.
