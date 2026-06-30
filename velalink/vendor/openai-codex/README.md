# OpenAI Codex Vendor Source

This directory vendors the OpenAI Codex source used by `crates/vela-engine`.

- Upstream: `https://github.com/openai/codex.git`
- Imported commit: see `VENDOR.toml`
- Rust entry point used by Vela: `codex-rs/`

Keep Vela integration code outside this directory. Treat files here as upstream
source and update them as a subtree/vendor import instead of editing them for
Vela-specific behavior.
