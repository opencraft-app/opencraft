# Findings

- Current master still contains the unused OpenCraft `agent/list` extension and joint agent/model query.
- Hermes Bridge still publishes an empty reasoning effort list, fabricates a default, ignores `turn/start.effort`, and returns null on start/resume.
- Official reference is `/Users/skipzhang/mono2/ref/hermes-agent@2cfb655d52e7e482523236c4012b61fcb54b37ce`.
- Official Desktop separates reasoning support, disable support, profile default, per-model preset, and live Session effort.
