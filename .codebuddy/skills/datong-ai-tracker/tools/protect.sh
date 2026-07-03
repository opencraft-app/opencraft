#!/bin/bash
# =============================================================================
# protect.sh - Unified skill protection tool (snapshot / verify / rollback).
#
# Combines pre-modification backup, post-modification verification, and
# one-click rollback into a single script with subcommands.
#
# Usage:
#   bash ./tools/protect.sh snapshot [target_skill_dir]
#   bash ./tools/protect.sh verify [target_skill_dir]
#   bash ./tools/protect.sh rollback [target_skill_dir] [--list|--force]
#
# Examples:
#   bash ./tools/protect.sh snapshot /path/to/my-skill
#   bash ./tools/protect.sh verify .
#   bash ./tools/protect.sh rollback . --force
# =============================================================================

set -e

SUBCOMMAND="${1:-}"
shift 2>/dev/null || true

# =============================================================================
# Helper: compute centralised backup base directory
#   ~/.skill-tracker/backups/<slug>/
# where <slug> is derived from the absolute target_dir path via md5.
# A file "target_dir.txt" is written inside so we can reverse-lookup later.
# =============================================================================
_backup_base_for() {
    local target_dir="$1"
    local slug
    if command -v md5sum &>/dev/null; then
        slug=$(printf '%s' "$target_dir" | md5sum | cut -c1-16)
    elif command -v md5 &>/dev/null; then
        slug=$(printf '%s' "$target_dir" | md5 | cut -c1-16)
    else
        # fallback: replace non-alnum chars
        slug=$(printf '%s' "$target_dir" | tr -cs 'a-zA-Z0-9' '_')
    fi
    local base="$HOME/.skill-tracker/backups/$slug"
    mkdir -p "$base"
    # record the original target directory for reverse lookup
    echo "$target_dir" > "$base/target_dir.txt"
    echo "$base"
}

# =============================================================================
# Subcommand: snapshot
# =============================================================================
cmd_snapshot() {
    local target_dir="${1:-.}"

    if [ -d "$target_dir" ]; then
        target_dir="$(cd "$target_dir" && pwd)"
    else
        echo "ERROR: Target directory '$target_dir' does not exist." >&2
        exit 1
    fi

    local backup_base
    backup_base=$(_backup_base_for "$target_dir")

    local timestamp
    timestamp=$(date '+%Y%m%d_%H%M%S')
    local backup_dir="$backup_base/$timestamp"
    local manifest_file="$backup_dir/manifest.txt"
    local latest_link="$backup_base/latest"

    echo "=== Skill Tracker: Pre-Modification Snapshot ==="
    echo "Target:  $target_dir"
    echo "Backup:  $backup_dir"
    echo ""

    mkdir -p "$backup_dir"

    local backup_count=0

    _backup_file() {
        local src="$1"
        local rel_path="${src#$target_dir/}"

        if [ -f "$src" ]; then
            local dest_dir="$backup_dir/$(dirname "$rel_path")"
            mkdir -p "$dest_dir"
            cp "$src" "$backup_dir/$rel_path"
            echo "$rel_path" >> "$manifest_file"
            echo "  ✓ Backed up: $rel_path"
            backup_count=$((backup_count + 1))
        fi
    }

    echo "[1/5] Scanning skill prompt files..."
    for f in "$target_dir"/SKILL.md "$target_dir"/skill.md "$target_dir"/skill.yaml "$target_dir"/README.md; do
        _backup_file "$f"
    done

    echo "[2/5] Scanning CodeBuddy configuration..."
    _backup_file "$target_dir/.codebuddy/settings.json"

    echo "[3/5] Scanning existing hooks..."
    if [ -d "$target_dir/hooks" ]; then
        for f in "$target_dir/hooks"/*; do
            [ -f "$f" ] && _backup_file "$f"
        done
    fi

    echo "[4/5] Scanning existing tools..."
    if [ -d "$target_dir/tools" ]; then
        for f in "$target_dir/tools"/*; do
            [ -f "$f" ] && _backup_file "$f"
        done
    fi

    echo "[5/5] Scanning source code files..."
    for ext in py js ts; do
        while IFS= read -r f; do
            case "$f" in
                */hooks/*|*/tools/*|*/node_modules/*|*/.venv/*|*/__pycache__/*)
                    continue
                    ;;
            esac
            _backup_file "$f"
        done < <(find "$target_dir" -maxdepth 3 -name "*.$ext" -type f 2>/dev/null)
    done

    _backup_file "$target_dir/scripts/track.sh"
    _backup_file "$target_dir/scripts/tool_wrapper.sh"

    rm -f "$latest_link"
    ln -sf "$timestamp" "$latest_link"

    echo ""
    echo "=== Snapshot Complete ==="
    echo "Files backed up: $backup_count"
    echo "Backup location: $backup_dir"
    echo "Manifest: $manifest_file"
    echo ""

    if [ "$backup_count" -eq 0 ]; then
        echo "ℹ️  No existing files found to back up (fresh skill directory)."
        echo "   This is normal for first-time tracking setup."
    else
        echo "✅ All existing files have been safely backed up."
        echo "   If anything goes wrong, run:"
        echo "   bash ./tools/protect.sh rollback $target_dir"
    fi

    echo ""
    echo "SNAPSHOT_READY"
}

# =============================================================================
# Subcommand: verify
# =============================================================================
cmd_verify() {
    local target_dir="${1:-.}"

    if [ -d "$target_dir" ]; then
        target_dir="$(cd "$target_dir" && pwd)"
    else
        echo "ERROR: Target directory '$target_dir' does not exist." >&2
        exit 1
    fi

    local backup_base
    backup_base=$(_backup_base_for "$target_dir")
    local backup_dir="$backup_base/latest"
    local pass_count=0
    local fail_count=0
    local warn_count=0

    _check_pass() {
        echo "  ✅ PASS: $1"
        pass_count=$((pass_count + 1))
    }

    _check_fail() {
        echo "  ❌ FAIL: $1"
        fail_count=$((fail_count + 1))
    }

    _check_warn() {
        echo "  ⚠️  WARN: $1"
        warn_count=$((warn_count + 1))
    }

    echo "=== Skill Tracker: Post-Modification Verification ==="
    echo "Target: $target_dir"
    echo ""

    # Check 1: Skill prompt file integrity
    echo "[1/6] Checking skill prompt files..."
    for prompt_file in "$target_dir"/SKILL.md "$target_dir"/skill.md; do
        if [ -f "$prompt_file" ]; then
            local filename
            filename=$(basename "$prompt_file")

            if [ ! -s "$prompt_file" ]; then
                _check_fail "$filename is empty!"
                continue
            fi

            local first_line
            first_line=$(head -1 "$prompt_file")
            if [ "$first_line" = "---" ]; then
                # Scan the whole file (starting from line 2) for the closing
                # "---" delimiter. Using a fixed head window would produce
                # false positives when the front matter is long (e.g. contains
                # a multi-line description or hooks block).
                local closing_line
                closing_line=$(awk 'NR>1 && /^---[[:space:]]*$/ {print NR; exit}' "$prompt_file")
                if [ -n "$closing_line" ]; then
                    _check_pass "$filename YAML front matter is intact"
                else
                    _check_fail "$filename YAML front matter is broken (missing closing ---)"
                fi
            else
                _check_pass "$filename has no YAML front matter (OK)"
            fi

            local last_line
            last_line=$(tail -1 "$prompt_file")
            if [ -z "$last_line" ] || echo "$last_line" | grep -qE '^\s*$'; then
                _check_pass "$filename ends cleanly"
            else
                if echo "$last_line" | grep -qE '^#{1,6}\s*$'; then
                    _check_warn "$filename ends with an empty markdown header (possible truncation)"
                else
                    _check_pass "$filename ends cleanly"
                fi
            fi

            if grep -q "description" "$prompt_file" 2>/dev/null; then
                _check_pass "$filename still contains description"
            else
                _check_warn "$filename may be missing description section"
            fi
        fi
    done

    # Check 2: JSON configuration validity
    echo ""
    echo "[2/6] Checking JSON configuration files..."
    local settings_file="$target_dir/.codebuddy/settings.json"
    if [ -f "$settings_file" ]; then
        if command -v python3 &>/dev/null; then
            if python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$settings_file" 2>/dev/null; then
                _check_pass ".codebuddy/settings.json is valid JSON"
            else
                _check_fail ".codebuddy/settings.json has invalid JSON syntax"
            fi

            local has_hooks
            has_hooks=$(python3 -c "
import json,sys
with open(sys.argv[1]) as f:
    data = json.load(f)
print('yes' if 'hooks' in data else 'no')
" "$settings_file" 2>/dev/null || echo "error")
            if [ "$has_hooks" = "yes" ]; then
                _check_pass ".codebuddy/settings.json contains hooks configuration"
            elif [ "$has_hooks" = "no" ]; then
                _check_fail ".codebuddy/settings.json is missing hooks section"
            fi
        elif command -v node &>/dev/null; then
            if node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$settings_file" 2>/dev/null; then
                _check_pass ".codebuddy/settings.json is valid JSON"
            else
                _check_fail ".codebuddy/settings.json has invalid JSON syntax"
            fi
        else
            _check_warn ".codebuddy/settings.json exists but no JSON validator available"
        fi
    else
        _check_warn ".codebuddy/settings.json not found (hooks won't work on CodeBuddy)"
    fi

    # Check 3: Python file syntax
    echo ""
    echo "[3/6] Checking Python file syntax..."
    if command -v python3 &>/dev/null; then
        if [ -d "$target_dir/hooks" ]; then
            for pyfile in "$target_dir/hooks"/*.py; do
                [ -f "$pyfile" ] || continue
                local filename="hooks/$(basename "$pyfile")"
                if python3 -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$pyfile" 2>/dev/null; then
                    _check_pass "$filename syntax OK"
                else
                    _check_fail "$filename has Python syntax errors"
                fi
            done
        fi

        while IFS= read -r pyfile; do
            case "$pyfile" in
                */hooks/*|*/tools/*|*/__pycache__/*|*/.venv/*)
                    continue
                    ;;
            esac
            local rel_path="${pyfile#$target_dir/}"
            if python3 -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$pyfile" 2>/dev/null; then
                _check_pass "$rel_path syntax OK"
            else
                _check_fail "$rel_path has Python syntax errors"
            fi
        done < <(find "$target_dir" -maxdepth 3 -name "*.py" -type f 2>/dev/null)
    else
        _check_warn "python3 not available, skipping Python syntax checks"
    fi

    # Check 4: Shell script syntax
    echo ""
    echo "[4/6] Checking shell script syntax..."
    for sh_dir in "$target_dir/tools" "$target_dir"; do
        if [ -d "$sh_dir" ] || [ "$sh_dir" = "$target_dir" ]; then
            for shfile in "$sh_dir"/*.sh; do
                [ -f "$shfile" ] || continue
                local rel_path="${shfile#$target_dir/}"
                if bash -n "$shfile" 2>/dev/null; then
                    _check_pass "$rel_path syntax OK"
                else
                    _check_fail "$rel_path has shell syntax errors"
                fi
            done
        fi
    done

    # Check 5: Original hook configuration preservation
    echo ""
    echo "[5/6] Checking original configuration preservation..."
    if [ -L "$backup_dir" ] && [ -f "$backup_dir/.codebuddy/settings.json" ]; then
        if command -v python3 &>/dev/null; then
            local preservation_result
            preservation_result=$(python3 -c "
import json, sys
try:
    with open(sys.argv[1]) as f:
        original = json.load(f)
    with open(sys.argv[2]) as f:
        current = json.load(f)
    orig_hooks = set(original.get('hooks', {}).keys())
    curr_hooks = set(current.get('hooks', {}).keys())
    missing = orig_hooks - curr_hooks
    if missing:
        print(f'FAIL:Original hook types lost: {missing}')
    else:
        print('PASS:All original hook types preserved')
except Exception as e:
    print(f'WARN:Could not compare hooks: {e}')
" "$backup_dir/.codebuddy/settings.json" "$settings_file" 2>/dev/null || echo "WARN:Python comparison failed")

            local result_type="${preservation_result%%:*}"
            local result_msg="${preservation_result#*:}"
            case "$result_type" in
                PASS) _check_pass "$result_msg" ;;
                FAIL) _check_fail "$result_msg" ;;
                WARN) _check_warn "$result_msg" ;;
            esac
        fi
    else
        _check_warn "No backup found, skipping configuration preservation check"
    fi

    # Check 6: Generate modification summary
    echo ""
    echo "[6/6] Generating modification summary..."
    if [ -L "$backup_dir" ]; then
        local real_backup="$backup_base/$(readlink "$backup_dir")"
        local manifest="$real_backup/manifest.txt"

        if [ -f "$manifest" ]; then
            echo ""
            echo "  ┌─────────────────────────────────────────────────┐"
            echo "  │           📋 Modification Summary                │"
            echo "  └─────────────────────────────────────────────────┘"
            echo ""

            local modified_count=0
            local unchanged_count=0

            while IFS= read -r rel_path; do
                local original="$real_backup/$rel_path"
                local current="$target_dir/$rel_path"

                if [ ! -f "$current" ]; then
                    echo "  🗑️  DELETED: $rel_path"
                    modified_count=$((modified_count + 1))
                elif ! diff -q "$original" "$current" &>/dev/null; then
                    echo "  ✏️  MODIFIED: $rel_path"
                    modified_count=$((modified_count + 1))
                    if command -v diff &>/dev/null; then
                        local added removed
                        added=$(diff "$original" "$current" 2>/dev/null | grep -c "^>" || true)
                        removed=$(diff "$original" "$current" 2>/dev/null | grep -c "^<" || true)
                        echo "       (+$added lines, -$removed lines)"
                    fi
                else
                    unchanged_count=$((unchanged_count + 1))
                fi
            done < "$manifest"

            echo ""
            local new_count=0
            for new_dir in hooks tools trackmate scripts; do
                if [ -d "$target_dir/$new_dir" ]; then
                    for f in "$target_dir/$new_dir"/*; do
                        [ -f "$f" ] || continue
                        local rel_path="${f#$target_dir/}"
                        if [ ! -f "$real_backup/$rel_path" ]; then
                            echo "  🆕 NEW: $rel_path"
                            new_count=$((new_count + 1))
                        fi
                    done
                fi
            done
            for f in "$target_dir/scripts/track.sh" "$target_dir/scripts/tool_wrapper.sh"; do
                if [ -f "$f" ]; then
                    local rel_path="${f#$target_dir/}"
                    if [ ! -f "$real_backup/$rel_path" ]; then
                        echo "  🆕 NEW: $rel_path"
                        new_count=$((new_count + 1))
                    fi
                fi
            done

            echo ""
            echo "  Summary: $new_count new, $modified_count modified, $unchanged_count unchanged"
        else
            _check_warn "No manifest found in backup, cannot generate diff summary"
        fi
    else
        echo "  ℹ️  No backup found, skipping modification summary."
        echo "     (Run protect.sh snapshot before implementing tracking to enable this feature)"
    fi

    # Final verdict
    echo ""
    echo "==========================================="
    echo "  Verification Results"
    echo "==========================================="
    echo "  ✅ Passed:  $pass_count"
    echo "  ❌ Failed:  $fail_count"
    echo "  ⚠️  Warnings: $warn_count"
    echo "==========================================="
    echo ""

    if [ "$fail_count" -gt 0 ]; then
        echo "❌ VERIFICATION FAILED"
        echo ""
        echo "Some checks did not pass. It is recommended to roll back:"
        echo "  bash ./tools/protect.sh rollback $target_dir"
        echo ""
        echo "VERIFY_FAILED"
        exit 1
    else
        if [ "$warn_count" -gt 0 ]; then
            echo "✅ VERIFICATION PASSED (with $warn_count warnings)"
        else
            echo "✅ VERIFICATION PASSED"
        fi
        echo ""
        echo "All critical checks passed. The original skill functionality should be intact."
        echo "If you still want to undo the changes, you can run:"
        echo "  bash ./tools/protect.sh rollback $target_dir"
        echo ""
        echo "VERIFY_OK"
        exit 0
    fi
}

# =============================================================================
# Subcommand: rollback
# =============================================================================
cmd_rollback() {
    local target_dir="${1:-.}"
    local mode="${2:-}"

    # Handle case where first arg is a flag
    case "$target_dir" in
        --list|--force)
            mode="$target_dir"
            target_dir="."
            ;;
    esac

    if [ -d "$target_dir" ]; then
        target_dir="$(cd "$target_dir" && pwd)"
    else
        echo "ERROR: Target directory '$target_dir' does not exist." >&2
        exit 1
    fi

    local backup_base
    backup_base=$(_backup_base_for "$target_dir")
    local latest_link="$backup_base/latest"

    if [ ! -L "$latest_link" ] && [ ! -d "$latest_link" ]; then
        echo "ERROR: No backup found at $backup_base/latest" >&2
        echo "" >&2
        echo "No snapshot was taken before tracking was implemented." >&2
        echo "Manual rollback is required (e.g., using git if available)." >&2
        exit 1
    fi

    local backup_timestamp backup_dir
    if [ -L "$latest_link" ]; then
        backup_timestamp=$(readlink "$latest_link")
        backup_dir="$backup_base/$backup_timestamp"
    else
        backup_dir="$latest_link"
        backup_timestamp="unknown"
    fi

    local manifest="$backup_dir/manifest.txt"

    if [ ! -f "$manifest" ]; then
        echo "ERROR: Manifest file not found at $manifest" >&2
        echo "The backup may be corrupted." >&2
        exit 1
    fi

    echo "=== Skill Tracker: Rollback ==="
    echo "Target:    $target_dir"
    echo "Backup:    $backup_dir"
    echo "Timestamp: $backup_timestamp"
    echo ""

    # Tracking files that were added (not modified)
    local tracking_files=(
        "track.sh"
        "tool_wrapper.sh"
        "hooks/_common.py"
        "hooks/hooks.py"
        "tools/report.sh"
        "tools/protect.sh"
    )

    # Phase 1: Show what will be done
    echo "📋 Rollback Plan:"
    echo ""

    local restore_count=0
    local delete_count=0

    echo "  Files to RESTORE (from backup):"
    while IFS= read -r rel_path; do
        if [ -f "$backup_dir/$rel_path" ]; then
            local current="$target_dir/$rel_path"
            if [ -f "$current" ] && ! diff -q "$backup_dir/$rel_path" "$current" &>/dev/null; then
                echo "    ↩️  $rel_path (modified → original)"
                restore_count=$((restore_count + 1))
            elif [ ! -f "$current" ]; then
                echo "    ↩️  $rel_path (deleted → restored)"
                restore_count=$((restore_count + 1))
            fi
        fi
    done < "$manifest"

    if [ "$restore_count" -eq 0 ]; then
        echo "    (none - no modified files to restore)"
    fi

    echo ""

    echo "  Files to DELETE (added by tracking):"
    for rel_path in "${tracking_files[@]}"; do
        local full_path="$target_dir/$rel_path"
        if [ -f "$full_path" ]; then
            if [ ! -f "$backup_dir/$rel_path" ]; then
                echo "    🗑️  $rel_path"
                delete_count=$((delete_count + 1))
            fi
        fi
    done

    if [ -d "$target_dir/trackmate" ]; then
        local trackmate_files
        trackmate_files=$(find "$target_dir/trackmate" -type f 2>/dev/null | wc -l | tr -d ' ')
        if [ "$trackmate_files" -gt 0 ]; then
            echo "    🗑️  trackmate/ ($trackmate_files files)"
            delete_count=$((delete_count + trackmate_files))
        fi
    fi

    if [ "$delete_count" -eq 0 ]; then
        echo "    (none - no new tracking files to remove)"
    fi

    echo ""
    echo "  Total: $restore_count files to restore, $delete_count files to delete"
    echo ""

    if [ "$mode" = "--list" ]; then
        echo "ℹ️  Dry run complete. No changes were made."
        echo "   Run without --list to execute the rollback."
        exit 0
    fi

    if [ "$mode" != "--force" ]; then
        if [ "$restore_count" -eq 0 ] && [ "$delete_count" -eq 0 ]; then
            echo "ℹ️  Nothing to roll back. All files match the original backup."
            exit 0
        fi

        echo -n "Proceed with rollback? [y/N] "
        read -r confirm
        if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
            echo "Rollback cancelled."
            exit 0
        fi
    fi

    # Phase 2: Execute rollback
    echo ""
    echo "Executing rollback..."

    local restored=0
    while IFS= read -r rel_path; do
        local backup_file="$backup_dir/$rel_path"
        local target_file="$target_dir/$rel_path"

        if [ -f "$backup_file" ]; then
            local target_file_dir
            target_file_dir=$(dirname "$target_file")
            mkdir -p "$target_file_dir"
            cp "$backup_file" "$target_file"
            echo "  ✓ Restored: $rel_path"
            restored=$((restored + 1))
        fi
    done < "$manifest"

    local deleted=0
    for rel_path in "${tracking_files[@]}"; do
        local full_path="$target_dir/$rel_path"
        if [ -f "$full_path" ] && [ ! -f "$backup_dir/$rel_path" ]; then
            rm -f "$full_path"
            echo "  ✓ Deleted: $rel_path"
            deleted=$((deleted + 1))
        fi
    done

    if [ -d "$target_dir/trackmate" ]; then
        if [ ! -d "$backup_dir/trackmate" ]; then
            rm -rf "$target_dir/trackmate"
            echo "  ✓ Deleted: trackmate/ (entire directory)"
        fi
    fi

    for dir in "$target_dir/hooks" "$target_dir/tools"; do
        if [ -d "$dir" ]; then
            if [ -z "$(ls -A "$dir" 2>/dev/null)" ]; then
                if [ ! -d "$backup_dir/$(basename "$dir")" ]; then
                    rmdir "$dir" 2>/dev/null || true
                    echo "  ✓ Removed empty directory: $(basename "$dir")/"
                fi
            fi
        fi
    done

    echo ""
    echo "=== Rollback Complete ==="
    echo "  Restored: $restored files"
    echo "  Deleted:  $deleted files"
    echo ""
    echo "✅ Your skill has been restored to its pre-tracking state."
    echo ""
    echo "Note: The backup at $backup_dir has been preserved."
    echo "You can safely delete it with:"
    echo "  rm -rf $backup_base"
    echo ""
    echo "ROLLBACK_DONE"
}

# =============================================================================
# Dispatcher
# =============================================================================
case "$SUBCOMMAND" in
    snapshot) cmd_snapshot "$@" ;;
    verify)   cmd_verify "$@" ;;
    rollback) cmd_rollback "$@" ;;
    *)
        echo "Usage: bash protect.sh <snapshot|verify|rollback> [args...]" >&2
        echo "" >&2
        echo "Subcommands:" >&2
        echo "  snapshot [target_dir]                Pre-modification backup" >&2
        echo "  verify [target_dir]                  Post-modification check" >&2
        echo "  rollback [target_dir] [--list|--force]  One-click rollback" >&2
        exit 1
        ;;
esac
