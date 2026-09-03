import json
import unittest
from pathlib import Path


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())
SCRIPT = REPO_ROOT / ".ci/runtime/commands/publish_frontend_preview.sh"


class PublishFrontendPreviewTests(unittest.TestCase):
    def test_variants_use_isolated_workspaces_and_external_artifacts(self) -> None:
        source = SCRIPT.read_text()

        self.assertIn('FRONTEND_PREVIEW_SOURCE_ROOT="$REPO_ROOT"', source)
        self.assertIn('FRONTEND_PREVIEW_BUILD_ROOT="$(mktemp -d', source)
        self.assertIn('FRONTEND_PREVIEW_WORKSPACE_ROOT="$FRONTEND_PREVIEW_BUILD_ROOT/workspaces"', source)
        self.assertIn('FRONTEND_PREVIEW_ARTIFACT_ROOT="$FRONTEND_PREVIEW_BUILD_ROOT/artifacts"', source)
        self.assertIn('FRONTEND_PREVIEW_CN_ARTIFACT_DIR="$FRONTEND_PREVIEW_ARTIFACT_ROOT/cn"', source)
        self.assertIn('FRONTEND_PREVIEW_INTL_ARTIFACT_DIR="$FRONTEND_PREVIEW_ARTIFACT_ROOT/intl"', source)
        self.assertIn('local workspace="$FRONTEND_PREVIEW_WORKSPACE_ROOT/$variant"', source)
        self.assertIn('cp -a --reflink=auto "$FRONTEND_PREVIEW_SOURCE_ROOT/." "$workspace/"', source)
        self.assertIn('mv out "$artifact_dir"', source)
        self.assertIn('verify_frontend_preview_artifact "$variant" out', source)
        self.assertIn("self\\.__next_f\\.push|</script><script>", source)
        self.assertIn('rm -rf "$workspace"', source)
        self.assertLess(source.index('mv out "$artifact_dir"'), source.index('rm -rf "$workspace"'))
        self.assertIn(
            'FRONTEND_PREVIEW_NODE_MAX_OLD_SPACE_MB="${FRONTEND_PREVIEW_NODE_MAX_OLD_SPACE_MB:-6144}"',
            source,
        )
        self.assertIn(
            'export NODE_OPTIONS="${inherited_node_options}${inherited_node_options:+ }--max-old-space-size=${FRONTEND_PREVIEW_NODE_MAX_OLD_SPACE_MB}"',
            source,
        )
        self.assertIn('FRONTEND_PREVIEW_BUILD_HEARTBEAT_SECONDS="${FRONTEND_PREVIEW_BUILD_HEARTBEAT_SECONDS:-60}"', source)
        self.assertIn('FRONTEND_PREVIEW_BUILD_TIMEOUT_SECONDS="${FRONTEND_PREVIEW_BUILD_TIMEOUT_SECONDS:-2700}"', source)
        self.assertIn('run_with_build_heartbeat "$PNPM_BIN" run build:next', source)
        self.assertIn('frontend next 构建心跳：', source)
        self.assertIn("ps -eo pid,ppid,stat,etime,%cpu,%mem,rss,args", source)
        self.assertNotIn('FRONTEND_NEXT_CN_DIR="$FRONTEND_DIR/out-cn"', source)
        self.assertNotIn('FRONTEND_NEXT_GLOBAL_DIR="$FRONTEND_DIR/out-global"', source)
        self.assertIn('du -sh "$FRONTEND_PREVIEW_CN_ARTIFACT_DIR" "$FRONTEND_PREVIEW_INTL_ARTIFACT_DIR"', source)
        self.assertIn('upload_staticpages_preview cn "$FRONTEND_PREVIEW_CN_ARTIFACT_DIR"', source)
        self.assertIn('upload_staticpages_preview intl "$FRONTEND_PREVIEW_INTL_ARTIFACT_DIR"', source)
        self.assertIn('--upload-mode packs', source)
        self.assertIn('ci_cleanup_sops_age_key || true', source)
        self.assertGreaterEqual(source.count('trap cleanup_frontend_preview_build EXIT'), 2)

    def test_build_command_does_not_own_cross_variant_artifact_state(self) -> None:
        package_json = json.loads((REPO_ROOT / "frontend/package.json").read_text())
        build_next = package_json["scripts"]["build:next"]

        self.assertNotIn("preserve-next-preview-output.mjs", build_next)
        self.assertNotIn("next build --webpack", build_next)
        self.assertIn("next build", build_next)
        self.assertFalse((REPO_ROOT / "frontend/scripts/preserve-next-preview-output.mjs").exists())


if __name__ == "__main__":
    unittest.main()
