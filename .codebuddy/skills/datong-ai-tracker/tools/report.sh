#!/bin/bash
# =============================================================================
# report.sh - Unified reporting tool for skill tracking.
#
# Combines init, complete, event reporting, and debug link generation
# into a single script with subcommands.
#
# Usage:
#   bash ./tools/report.sh init [event_name] [json_data]
#   bash ./tools/report.sh complete <status> [json_data]
#   bash ./tools/report.sh event <event_name> [json_data]
#   bash ./tools/report.sh debug
#
# Examples:
#   bash ./tools/report.sh init
#   bash ./tools/report.sh complete success '{"output_type":"code"}'
#   bash ./tools/report.sh event code_generated '{"language":"python"}'
#   bash ./tools/report.sh debug
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
SCRIPTS_DIR="$SKILL_DIR/scripts"

# =============================================================================
# !! CONFIGURE THESE FOR YOUR SKILL !!
# =============================================================================
APP_KEY="0WEB06ZTQYB8SZPK"
SKILL_NAME="datong-report"
# =============================================================================

DATONG_APP_ID="dt_datong_report_v3"
DATONG_BASE_URL="https://trackmate.woa.com/#/d/repRegistry-quality/debug/panel"

SUBCOMMAND="${1:-}"
shift 2>/dev/null || true

# --- Shared helpers ---
_is_codebuddy() {
    # Only trust runtime env vars. Do NOT fall back to $SKILL_DIR/.codebuddy
    # (package-time marker, not runtime) or ./.codebuddy (project may be
    # opened from a non-CodeBuddy runtime). Misclassifying OpenClaw as
    # CodeBuddy here suppresses shell-side reporting entirely.
    [ -n "${CODEBUDDY_PROJECT_DIR:-}" ] \
        || [ -n "${CODEBUDDY_ENV:-}" ] \
        || [ -n "${CODEBUDDY_VERSION:-}" ]
}

# _codebuddy_hook_registered checks whether .codebuddy/settings.json actually
# registers THIS skill's hooks.py for any lifecycle hook. If not, shell-side
# reporting must NOT defer to the hook (otherwise events are dropped).
#
# Returns 0 if a registered hook command line references "$SKILL_DIR/hooks/hooks.py".
# Returns 1 otherwise (settings.json missing OR registration absent OR mismatched).
#
# Cached per-process via _CB_HOOK_REGISTERED_CACHE to avoid repeated I/O.
_codebuddy_hook_registered() {
    if [ -n "${_CB_HOOK_REGISTERED_CACHE:-}" ]; then
        [ "$_CB_HOOK_REGISTERED_CACHE" = "yes" ] && return 0 || return 1
    fi

    local workspace="${CODEBUDDY_PROJECT_DIR:-$(pwd)}"
    local settings="$workspace/.codebuddy/settings.json"
    local hook_path="$SKILL_DIR/hooks/hooks.py"

    if [ ! -f "$settings" ]; then
        export _CB_HOOK_REGISTERED_CACHE="no"
        return 1
    fi

    # Match either the absolute path or its realpath form. We use grep -F
    # for fast literal matching; both the raw and resolved paths are tried
    # because users sometimes have symlinked skill directories.
    local resolved=""
    if command -v realpath &>/dev/null; then
        resolved=$(realpath "$hook_path" 2>/dev/null || true)
    elif command -v readlink &>/dev/null; then
        resolved=$(readlink -f "$hook_path" 2>/dev/null || true)
    fi

    if grep -F "$hook_path" "$settings" &>/dev/null; then
        export _CB_HOOK_REGISTERED_CACHE="yes"
        return 0
    fi
    if [ -n "$resolved" ] && grep -F "$resolved" "$settings" &>/dev/null; then
        export _CB_HOOK_REGISTERED_CACHE="yes"
        return 0
    fi

    export _CB_HOOK_REGISTERED_CACHE="no"
    return 1
}

# _should_shell_report returns 0 when the shell layer must send the event
# itself (no hook will pick it up). This is the canonical guard combining
# both runtime detection and registration verification.
_should_shell_report() {
    if ! _is_codebuddy; then
        return 0  # Not in CodeBuddy → shell is the only path
    fi
    if ! _codebuddy_hook_registered; then
        return 0  # In CodeBuddy but hook NOT registered → shell must fall back
    fi
    return 1  # Hook will handle it
}

_track_bg() {
    local event="$1"
    local data="$2"
    if [ ! -f "$SCRIPTS_DIR/track.sh" ]; then
        export _LAST_TRACK_BG_STATUS="dropped_no_script"
        return 1
    fi
    # nohup + disown detaches the child from the parent's controlling tty,
    # so when an IDE hook process is reaped (SIGHUP/SIGTERM with short
    # timeout), the in-flight Beacon POST still completes.
    nohup bash "$SCRIPTS_DIR/track.sh" "$APP_KEY" "$SKILL_NAME" "$event" "$data" \
        </dev/null >/dev/null 2>&1 &
    disown 2>/dev/null || true
    export _LAST_TRACK_BG_STATUS="forked"
    return 0
}

# --- Generate stable device fingerprint (A2) ---
generate_a2() {
    local raw_hostname=""
    local raw_username=""
    local device_id=""

    raw_hostname=$(hostname 2>/dev/null || echo "unknown-host")
    raw_username=$(whoami 2>/dev/null || echo "unknown-user")

    if [ -z "$device_id" ] && [ -f /etc/machine-id ]; then
        device_id=$(cat /etc/machine-id 2>/dev/null | tr -d '[:space:]')
    fi
    if [ -z "$device_id" ] && [ -f /var/lib/dbus/machine-id ]; then
        device_id=$(cat /var/lib/dbus/machine-id 2>/dev/null | tr -d '[:space:]')
    fi
    if [ -z "$device_id" ] && command -v reg.exe &>/dev/null; then
        device_id=$(reg.exe query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid 2>/dev/null \
            | grep -i "MachineGuid" | awk '{print $NF}' | tr -d '[:space:]')
    fi
    if [ -z "$device_id" ] && command -v ioreg &>/dev/null; then
        device_id=$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null \
            | grep IOPlatformUUID | sed 's/.*= "//;s/"//' | tr -d '[:space:]')
    fi
    if [ -z "$device_id" ]; then
        local raw_mac=""
        if command -v ifconfig &>/dev/null; then
            raw_mac=$(ifconfig 2>/dev/null | grep -oE '([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}' | head -1)
        elif command -v ip &>/dev/null; then
            raw_mac=$(ip link 2>/dev/null | grep -oE '([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}' | head -1)
        elif command -v getmac &>/dev/null; then
            raw_mac=$(getmac /FO CSV /NH 2>/dev/null | head -1 | cut -d',' -f1 | tr -d '"' | tr '-' ':')
        fi
        if [ -z "$raw_mac" ] && [ -d /sys/class/net ]; then
            for iface in /sys/class/net/*/address; do
                local addr=""
                addr=$(cat "$iface" 2>/dev/null | tr -d '[:space:]')
                # Reject all-zero MACs in any common form (loopback / placeholder).
                if [ -n "$addr" ] \
                    && [ "$addr" != "00:00:00:00:00:00" ] \
                    && [ "$addr" != "00-00-00-00-00-00" ] \
                    && [ "$addr" != "000000000000" ]; then
                    raw_mac="$addr"
                    break
                fi
            done
        fi
        [ -n "$raw_mac" ] && device_id=$(echo "$raw_mac" | tr '[:upper:]' '[:lower:]')
    fi
    if [ -z "$device_id" ]; then
        local did_dir="$HOME/.skill-tracker"
        local did_file="$did_dir/device-id"
        if [ -f "$did_file" ]; then
            device_id=$(cat "$did_file" 2>/dev/null | tr -d '[:space:]')
        fi
        if [ -z "$device_id" ]; then
            local new_did=""
            if command -v uuidgen &>/dev/null; then
                new_did=$(uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]')
            elif command -v python3 &>/dev/null; then
                new_did=$(python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null)
            elif [ -f /proc/sys/kernel/random/uuid ]; then
                new_did=$(cat /proc/sys/kernel/random/uuid 2>/dev/null)
            fi
            if [ -n "$new_did" ]; then
                mkdir -p "$did_dir" 2>/dev/null && echo "$new_did" > "$did_file" 2>/dev/null
                device_id="$new_did"
            fi
        fi
    fi
    [ -z "$device_id" ] && device_id="no-device-id"

    local fingerprint="${raw_hostname}:${raw_username}:${device_id}"
    if command -v md5sum &>/dev/null; then
        echo -n "$fingerprint" | md5sum | cut -c1-32
    elif command -v md5 &>/dev/null; then
        echo -n "$fingerprint" | md5 -q
    elif command -v openssl &>/dev/null; then
        echo -n "$fingerprint" | openssl md5 | sed 's/.*= //'
    elif command -v python3 &>/dev/null; then
        echo -n "$fingerprint" | python3 -c "import hashlib,sys; print(hashlib.md5(sys.stdin.buffer.read()).hexdigest())" 2>/dev/null
    else
        local ck
        ck=$(echo -n "$fingerprint" | cksum | awk '{print $1}')
        printf '%032s' "$ck" | tr ' ' '0'
    fi
}

# --- Generate stable device fingerprint v2 (A2_v2) ---
# Identical algorithm across shell + python + python-sdk (single source of truth).
# Formula:  MD5(hostname:username:stable_id)
#   stable_id = machine-id (Linux/Win/macOS) OR persistent ~/.skill-tracker/device-id
# Drops MAC / sysfs / ifconfig branches so all 5 implementations produce the
# SAME 32-char hash on the same machine. Reported as common.A2_v2 alongside
# legacy A2 to allow side-by-side observation before any UV migration.
generate_a2_v2() {
    local h u sid fp
    h=$(hostname 2>/dev/null || echo "unknown-host")
    u=$(whoami 2>/dev/null || echo "unknown-user")
    sid=""

    # 1. Linux machine-id
    if [ -z "$sid" ] && [ -f /etc/machine-id ]; then
        sid=$(cat /etc/machine-id 2>/dev/null | tr -d '[:space:]')
    fi
    if [ -z "$sid" ] && [ -f /var/lib/dbus/machine-id ]; then
        sid=$(cat /var/lib/dbus/machine-id 2>/dev/null | tr -d '[:space:]')
    fi
    # 2. Windows MachineGuid
    if [ -z "$sid" ] && command -v reg.exe &>/dev/null; then
        sid=$(reg.exe query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid 2>/dev/null \
            | grep -i "MachineGuid" | awk '{print $NF}' | tr -d '[:space:]')
    fi
    # 3. macOS IOPlatformUUID
    if [ -z "$sid" ] && command -v ioreg &>/dev/null; then
        sid=$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null \
            | grep IOPlatformUUID | sed 's/.*= "//;s/"//' | tr -d '[:space:]')
    fi
    # 4. Persistent UUID file (~/.skill-tracker/device-id), shared with v1.
    if [ -z "$sid" ]; then
        local did_dir="$HOME/.skill-tracker"
        local did_file="$did_dir/device-id"
        if [ -f "$did_file" ]; then
            sid=$(cat "$did_file" 2>/dev/null | tr -d '[:space:]')
        fi
        if [ -z "$sid" ]; then
            local new_did=""
            if command -v uuidgen &>/dev/null; then
                new_did=$(uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]')
            elif command -v python3 &>/dev/null; then
                new_did=$(python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null)
            elif [ -f /proc/sys/kernel/random/uuid ]; then
                new_did=$(cat /proc/sys/kernel/random/uuid 2>/dev/null)
            fi
            if [ -n "$new_did" ]; then
                mkdir -p "$did_dir" 2>/dev/null && echo "$new_did" > "$did_file" 2>/dev/null
                sid="$new_did"
            fi
        fi
    fi
    [ -z "$sid" ] && sid="no-device-id"

    fp="${h}:${u}:${sid}"
    if command -v md5sum &>/dev/null; then
        echo -n "$fp" | md5sum | cut -c1-32
    elif command -v md5 &>/dev/null; then
        echo -n "$fp" | md5 -q
    elif command -v openssl &>/dev/null; then
        echo -n "$fp" | openssl md5 | sed 's/.*= //'
    elif command -v python3 &>/dev/null; then
        echo -n "$fp" | python3 -c "import hashlib,sys; print(hashlib.md5(sys.stdin.buffer.read()).hexdigest())" 2>/dev/null
    else
        local ck
        ck=$(echo -n "$fp" | cksum | awk '{print $1}')
        printf '%032s' "$ck" | tr ' ' '0'
    fi
}

# =============================================================================
# Subcommand: init
# =============================================================================
cmd_init() {
    local event_name="${1:-skill_invoked}"
    local custom_data="${2:-}"

    # On CodeBuddy with hook registered, hook handles this; otherwise shell falls back.
    if _should_shell_report; then
        _track_bg "$event_name" "$custom_data"
    fi

    echo "=== Task Context ==="
    echo "Skill: $SKILL_NAME"
    echo "Time: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "OS: $(uname -s) $(uname -m)"
    echo "User: $(whoami 2>/dev/null || echo 'unknown')"
    echo "Working Directory: $(pwd)"
    echo ""

    echo "=== Workspace Files ==="
    if command -v find &>/dev/null; then
        find . -maxdepth 2 -type f \
            ! -path './.git/*' \
            ! -path './node_modules/*' \
            ! -path './__pycache__/*' \
            ! -path './.venv/*' \
            2>/dev/null | head -20
    fi
    echo ""

    echo "=== Project Info ==="
    if [ -f "package.json" ]; then
        echo "Type: Node.js"
        echo "Name: $(grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' package.json 2>/dev/null | head -1)"
    elif [ -f "requirements.txt" ] || [ -f "setup.py" ] || [ -f "pyproject.toml" ]; then
        echo "Type: Python"
    elif [ -f "go.mod" ]; then
        echo "Type: Go"
        echo "Module: $(head -1 go.mod 2>/dev/null)"
    elif [ -f "Cargo.toml" ]; then
        echo "Type: Rust"
    elif [ -f "pom.xml" ] || [ -f "build.gradle" ]; then
        echo "Type: Java"
    else
        echo "Type: Unknown"
    fi
    echo ""

    local a2 a2v2
    a2=$(generate_a2)
    a2v2=$(generate_a2_v2)
    echo "=== Debug Info ==="
    echo "A2:    $a2"
    echo "A2_v2: $a2v2"
    echo "Debug Link: ${DATONG_BASE_URL}?debugId=${a2}&appId=${DATONG_APP_ID}&showHistory=0&autoRegistDeviceId=1"
    echo ""

    echo "=== Ready ==="
    echo "TASK_READY"
}

# =============================================================================
# Subcommand: complete
# =============================================================================
cmd_complete() {
    local status="${1:-success}"
    local custom_data="${2:-}"

    local event_data="{\"status\":\"$status\""
    if [ -n "$custom_data" ]; then
        local stripped
        stripped=$(echo "$custom_data" | sed 's/^[[:space:]]*{//;s/}[[:space:]]*$//')
        if [ -n "$stripped" ]; then
            event_data="$event_data,$stripped"
        fi
    fi
    event_data="$event_data}"

    if _should_shell_report; then
        _track_bg "task_completed" "$event_data"
    fi

    echo "=== Task Complete ==="
    echo "Status: $status"
    echo "Time: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "TASK_DONE"
}

# =============================================================================
# Subcommand: event
#
# Output contract (all paths exit 0 to keep `&& echo "EVENT_OK"` chains intact):
#   - Hook will handle the event   → stdout: EVENT_OK
#                                    stderr: [skill-tracker] event '<n>' deferred to hook
#   - Shell sent the event         → stdout: EVENT_OK
#   - Shell SHOULD send but failed → stdout: EVENT_OK    (back-compat)
#                                    stderr: [skill-tracker] WARNING: event '<n>' DROPPED (<reason>)
# =============================================================================
cmd_event() {
    local event_name="${1:-custom_event}"
    local custom_data="${2:-}"

    local status="ok"
    if _should_shell_report; then
        if _track_bg "$event_name" "$custom_data"; then
            status="shell_sent"
        else
            status="dropped"
            echo "[skill-tracker] WARNING: event '$event_name' DROPPED (${_LAST_TRACK_BG_STATUS:-unknown}). Beacon will not receive this event." >&2
        fi
    else
        status="hook_deferred"
        echo "[skill-tracker] event '$event_name' deferred to registered CodeBuddy hook." >&2
    fi

    echo "Event '$event_name' recorded ($status)."
    echo "EVENT_OK"
}

# =============================================================================
# Subcommand: batch  (report multiple events in one call)
# Usage: bash report.sh batch 'evt1|json1' 'evt2|json2' ...
# Each argument is "event_name|json_data" (pipe-separated).
# If no pipe, the whole argument is treated as event_name with empty data.
# =============================================================================
cmd_batch() {
    local count=0
    for item in "$@"; do
        local event_name=""
        local custom_data=""
        if [[ "$item" == *"|"* ]]; then
            event_name="${item%%|*}"
            custom_data="${item#*|}"
        else
            event_name="$item"
        fi
        if [ -z "$event_name" ]; then
            continue
        fi
        if _should_shell_report; then
            _track_bg "$event_name" "$custom_data" || true
        fi
        count=$((count + 1))
        echo "  [$count] '$event_name' recorded."
    done
    echo "BATCH_OK ($count events)"
}

# =============================================================================
# Subcommand: debug
# =============================================================================
cmd_debug() {
    local a2 a2v2
    a2=$(generate_a2)
    a2v2=$(generate_a2_v2)
    local debug_url="${DATONG_BASE_URL}?debugId=${a2}&appId=${DATONG_APP_ID}&showHistory=0&autoRegistDeviceId=1"

    echo "=== Skill Tracker Debug ==="
    echo "Skill:    $SKILL_NAME"
    echo "A2:       $a2"
    echo "A2_v2:    $a2v2"
    echo ""
    # Hook registration self-check (helps user diagnose silent drops on CodeBuddy)
    if _is_codebuddy; then
        if _codebuddy_hook_registered; then
            echo "Hook:     registered (settings.json points to this skill)"
        else
            echo "Hook:     NOT registered — shell-side fallback will send events"
        fi
    else
        echo "Runtime:  non-CodeBuddy (shell-side path is the only reporter)"
    fi
    echo ""
    echo "Click the link below to start debugging on Datong platform:"
    echo ""
    echo "  $debug_url"
    echo ""
    echo "DEBUG_READY"
}

# =============================================================================
# Dispatcher
# =============================================================================
case "$SUBCOMMAND" in
    init)     cmd_init "$@" ;;
    complete) cmd_complete "$@" ;;
    event)    cmd_event "$@" ;;
    batch)    cmd_batch "$@" ;;
    debug)    cmd_debug "$@" ;;
    *)
        echo "Usage: bash report.sh <init|complete|event|debug|batch> [args...]" >&2
        echo "" >&2
        echo "Subcommands:" >&2
        echo "  init [event_name] [json_data]     Initialize task + report" >&2
        echo "  complete <status> [json_data]      Report task completion" >&2
        echo "  event <event_name> [json_data]     Report custom event" >&2
        echo "  batch 'evt|json' 'evt|json' ...    Report multiple events" >&2
        echo "  debug                              Generate debug link" >&2
        exit 1
        ;;
esac
