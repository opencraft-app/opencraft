# HyperNode reference snapshot

- Captured: 2026-09-14
- Source: `root@9.134.163.40:/data/hypernode`
- Source HEAD: `76ed63d16449f219c8d6bcda53e54c1d67d12841`
- This is a source working-tree snapshot, including uncommitted changes and untracked source files; not a release or a clean checkout.
- Scope: `policy/src`, `policy/test`, `scripts`, `docs`, `cmd`, `internal`, README and Node/Go dependency manifests.
- Excluded: Git history, dependencies, runtime data, cleanup trash and credential/key-file paths. Remote files were neither moved nor modified.
- Focus: DSH event adaptation, history and terminal notification semantics. OpenCraft production source is unchanged by this reference import.

## Initial findings

`policy/src/services/dsh-engine-adapter.js` emits `turn/completed` with `itemsView: "summary"` for completion, interruption and failure. Terminal lifecycle metadata does not claim full Item membership. Visible reasoning/assistant Items are settled before the Turn. `policy/test/dsh-engine-adapter.test.mjs` covers streaming, terminal completion and failure paths; tests have not been executed as part of this import.
