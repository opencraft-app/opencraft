# Hermes Agent PVM profile

This profile builds the complete pinned Hermes Agent process tree into the
read-only EROFS/DAX image. Docker Buildx is a build-time frontend only; neither
Docker nor its socket is present at runtime.

The shared warm template contains a live Python interpreter with the one-shot
and side-effect-free gateway CLI module graphs imported under the final
`hermes` identity (UID/GID 10000). The resource-owning `gateway.run` module is
deliberately imported only after clone restore and configuration injection.
It also completes the credential-independent OpenAI SDK class load and local
Python environment probe; this moves deterministic import/compile work out of
every clone without constructing a provider client or `AIAgent`.
`/opt/data` contains only Hermes' deterministic default skeleton, empty state
database and image-local tool-discovery cache. A fail-closed checkpoint audit
rejects live threads, unexpected file descriptors, credentials, configuration,
sessions, symlinks, unknown profile files and nonempty state. User profiles,
credentials, sessions and plugins must be supplied only after cloning.

The publisher starts as guest root only to create a mode-0600 Unix listener and
open `/dev/minisandbox`. It then permanently drops groups, GID and UID before
importing Hermes. The already-open checkpoint descriptor is the sole retained
capability; it is closed immediately after clone resume. The bootstrap accepts
strictly bounded requests on `/run/minisandbox-hermes/agent.sock` and never adds
a host hypercall, host parser or public guest listener.

There are two explicit post-clone paths. `hermes-invoke.py` retains the bounded
one-shot path used by deterministic chat benchmarks and constructs a fresh
`AIAgent` in the clone. `hermes-launch.py` performs a one-time handoff to the
canonical upstream `hermes_cli.gateway.run_gateway()` lifecycle. The handoff
copies only explicitly named environment entries, rejects Python/loader/path
overrides, closes and unlinks the bootstrap listener, and waits for upstream's
own `gateway_state.json` to report `running` or `degraded`. Configuration files
can be written into the clone-private `/opt/data` before that handoff. This
makes the long-lived process the real Hermes GatewayRunner rather than a second
minisandbox agent protocol. Credentials, event loops, PID files, platform
sockets and background workers are all created after clone restore.

The upstream source revision is recorded in `hermes.lock.json` and validated by
`rootfs/build.py hermes`. Updating it is an explicit source review operation.
The pinned Dockerfile's symbolic `COPY --chmod` is rewritten to an equivalent
`COPY` plus `RUN chmod` because stable Dockerfile frontends accept only octal
COPY modes. After the editable install, the same reviewed build patch compiles
both Hermes and its virtual environment to PEP 552 checked-hash, optimization-0
bytecode. This does not import application modules, remains valid when EROFS
normalizes timestamps, and lets the immutable image satisfy cold imports while
runtime bytecode writes stay disabled. The builder requires both exact upstream
anchors and records the patch, bytecode policy and both Dockerfile hashes in
artifact metadata.

Inside a restored clone, launch the credential-free cron-only gateway with:

```text
/opt/hermes/.venv/bin/python /opt/minisandbox/hermes-launch.py
```

To pass clone-private secrets without putting their values in argv:

```text
OPENROUTER_API_KEY=... /opt/hermes/.venv/bin/python \
  /opt/minisandbox/hermes-launch.py --env OPENROUTER_API_KEY
```

Each clone accepts at most one gateway handoff. The sandbox control file API
may atomically install `/opt/data/config.yaml` before invoking the launcher. A
gateway handoff is rejected after any one-shot attempt, so the upstream daemon
always starts from the audited pristine restore boundary; benchmarks that use
the one-shot endpoint launch a separate clone.
