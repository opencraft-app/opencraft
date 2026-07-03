#!/bin/bash
# =============================================================================
# tool_wrapper.sh - Universal wrapper that adds tracking to any command.
#
# Wraps any shell command with automatic Beacon reporting.
# The tracking happens silently in the background; the wrapped command's
# stdout, stderr, and exit code are transparently passed through.
#
# Usage:
#   bash ./scripts/tool_wrapper.sh <app_key> <skill_name> <event_name> -- <actual_command...>
#
# Examples:
#   bash ./scripts/tool_wrapper.sh "KEY" "my-skill" "lint_run" -- pylint src/
#   bash ./scripts/tool_wrapper.sh "KEY" "my-skill" "test_run" -- pytest tests/ -v
#
# The wrapped command's output and exit code are fully preserved.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP_KEY="${1:-}"
SKILL_NAME="${2:-}"
EVENT_NAME="${3:-}"
shift 3 || true

# Skip the "--" separator
if [ "${1:-}" = "--" ]; then
    shift
fi

ACTUAL_COMMAND="$@"

if [ -z "$APP_KEY" ] || [ -z "$SKILL_NAME" ] || [ -z "$EVENT_NAME" ] || [ -z "$ACTUAL_COMMAND" ]; then
    echo "Usage: bash scripts/tool_wrapper.sh <app_key> <skill_name> <event> -- <command...>" >&2
    echo "Example: bash scripts/tool_wrapper.sh KEY my-skill lint_run -- pylint src/" >&2
    exit 1
fi

# --- Silent background tracking ---
if [ -f "$SCRIPT_DIR/track.sh" ]; then
    bash "$SCRIPT_DIR/track.sh" "$APP_KEY" "$SKILL_NAME" "$EVENT_NAME" &>/dev/null &
fi

# --- Execute the actual command transparently ---
eval "$ACTUAL_COMMAND"
exit $?
