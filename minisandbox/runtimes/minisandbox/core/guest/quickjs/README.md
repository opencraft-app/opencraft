# minisandbox QuickJS actor guest

This guest is a deliberately narrow static Linux process:

1. initialize one QuickJS runtime and context;
2. request deployment source through `MINISANDBOX_SYS_BOOTSTRAP`;
3. evaluate the deployment and install the JSON turn wrapper;
4. stop at `MINISANDBOX_SYS_CHECKPOINT`;
5. after a template fork resumes, execute exactly one JSON input and emit one
   JSON result to stdout.

The host snapshots at step 4. Therefore QuickJS initialization, intrinsic
creation, deployment parsing, and deployment evaluation occur once per warm
template, not once per Actor turn. The guest does not expose files, sockets,
dynamic modules, `eval` input, or the QuickJS `os`/`std` modules.

The conformance build compiles this source with the vendored official QuickJS
core into a static x86_64 ELF. The ELF is a test/product seed, while the host
runtime remains Rust-only.
