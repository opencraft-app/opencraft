# Findings

Before this migration, OpenCraft retained an unused `agent/list` extension and
joint agent/model query. Hermes Bridge published no reasoning choices, fabricated
a default, ignored `turn/start.effort`, and returned null effort on start/resume.

The official Hermes reference at `2cfb655d52e7e482523236c4012b61fcb54b37ce`
separates reasoning support, disable support, profile default, per-model preset,
and live Session effort. Its UI uses the Hermes effort ladder while provider
transports clamp to their wire vocabulary.

The resolved design reuses existing AppServer model/Turn fields: an empty set
means no configurable reasoning; `none` appears only when disabling reasoning
is supported. Product Bot identity belongs to `bot/*`, so the unused OpenCraft
Agent catalog is removed rather than replaced with a synthetic Hermes Agent.
