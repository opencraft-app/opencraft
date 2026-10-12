#!/bin/sh
# collaboration --bot-host-command entry point: runs bot-host.py with Hermes' Python (which has PyYAML).
set -eu
exec "${HERMES_HOME:?}/hermes-agent/venv/bin/python" "$(dirname "$0")/bot-host.py"
