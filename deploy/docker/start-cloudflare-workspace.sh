#!/bin/sh
set -eu

# Set limits only below this container's delegated cgroup namespace root.
group=/sys/fs/cgroup
workspace_group="$group/opencraft-workspace"
export OPENCRAFT_DATA_DIR=/var/lib/opencraft-workspace/data
export OPENCRAFT_WORKSPACE_DIR=/var/lib/opencraft-workspace/workspace
export OPENCRAFT_LOG_DIR=/var/lib/opencraft-workspace/logs
export OPENCRAFT_HANDS_EXECUTION_SOCKET="$OPENCRAFT_DATA_DIR/execution/exec-owner.sock"
export OPENCRAFT_HANDS_EXECUTION_TOKEN="$OPENCRAFT_DATA_DIR/execution/exec-owner.token"
export OPENCRAFT_CODEX_EXECUTABLE=/opt/opencraft/runtime/codex/bin/codex
export OPENCRAFT_PROXY_MODE=workspace-egress
export HOME="$OPENCRAFT_DATA_DIR"
test "$$" -eq 1
test "$OPENCRAFT_CLOUDFLARE_UID" -gt 0
test "$OPENCRAFT_CLOUDFLARE_GID" -gt 0
test "$(cat /proc/self/cgroup)" = '0::/'
test "$(cat "$group/memory.max")" -eq 8589934592

# Initialize private directories for a newly provisioned guest before dropping privileges.
install -d -m 0700 -o "$OPENCRAFT_CLOUDFLARE_UID" -g "$OPENCRAFT_CLOUDFLARE_GID" \
  /run/opencraft-agent /var/lib/opencraft-workspace \
  /var/lib/opencraft-workspace/data /var/lib/opencraft-workspace/data/execution \
  /var/lib/opencraft-workspace/workspace /var/lib/opencraft-workspace/logs

mkdir "$workspace_group"
printf '%s\n' "$$" > "$workspace_group/cgroup.procs"
# The provider may still have a short-lived identity probe in the parent group.
attempt=0
until (printf '+cpu +memory +pids\n' > "$group/cgroup.subtree_control") 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 100 ]; then
    echo 'Could not enable the Cloudflare workspace cgroup controllers' >&2
    exit 1
  fi
  sleep 0.1
done
printf '400000 100000\n' > "$workspace_group/cpu.max"
printf '8589934592\n' > "$workspace_group/memory.max"
printf '4096\n' > "$workspace_group/pids.max"

open_files=$(ulimit -Sn)
if [ "$open_files" != unlimited ] && [ "$open_files" -lt 65536 ]; then
  ulimit -Sn 65536
fi

# Give the existing Hands verifier a read-only view of the live cgroup.
exec /usr/bin/unshare --mount --propagation private /bin/sh -ec '
  mount --bind "$1" /sys/fs/cgroup
  mount -o remount,bind,ro /sys/fs/cgroup
  exec /usr/bin/setpriv --reuid "$2" --regid "$3" --clear-groups \
    --bounding-set=-all --inh-caps=-all --ambient-caps=-all \
    /opt/opencraft/bin/node /opt/opencraft/runtime/workspace-agent.mjs --role hands --role brain
' opencraft-cloudflare "$workspace_group" "$OPENCRAFT_CLOUDFLARE_UID" "$OPENCRAFT_CLOUDFLARE_GID"
