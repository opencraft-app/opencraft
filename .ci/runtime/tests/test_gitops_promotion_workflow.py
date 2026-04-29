import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


class GitOpsPromotionWorkflowTests(unittest.TestCase):
    def test_sandbox2_branch_is_matched_before_sandbox1(self) -> None:
        workflow = (REPO_ROOT / ".ci/gitops-promotion.yml").read_text()
        sandbox2_index = workflow.index("promote-beijing-sandbox-2-*)")
        sandbox1_index = workflow.index("promote-beijing-sandbox-*)")

        self.assertLess(sandbox2_index, sandbox1_index)
        self.assertIn("TARGET_ENV=beijing-sandbox-2", workflow)
        self.assertIn("--env \"$TARGET_ENV\"", workflow)

    def test_all_auto_stages_route_sandbox2_promote_branches(self) -> None:
        workflow = (REPO_ROOT / ".ci/gitops-promotion.yml").read_text()

        self.assertGreaterEqual(workflow.count("promote-beijing-sandbox-2-*"), 4)
        self.assertIn("gitops_merge_request.py", workflow)
        self.assertIn("verify_gitops_release.py", workflow)
        self.assertIn("gitops_cleanup_source_branch.py", workflow)

    def test_build_and_promote_fans_out_auto_pin_envs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fake_bin = Path(tmp)
            pins_file = fake_bin / "pins.log"
            fake_python = fake_bin / "python3"
            fake_pin = fake_bin / "pin_image_to_gitops.sh"
            fake_python.write_text(
                textwrap.dedent(
                    f"""\
                    #!/bin/bash
                    if [[ "$1" == "{REPO_ROOT}/.ci/runtime/harness_ci/commands/build_release_image.py" ]]; then
                      env_name=""
                      output_file=""
                      while [[ $# -gt 0 ]]; do
                        case "$1" in
                          --env)
                            env_name="$2"
                            shift 2
                            ;;
                          --image-output-file)
                            output_file="$2"
                            shift 2
                            ;;
                          *)
                            shift
                            ;;
                        esac
                      done
                      printf '{{"images":{{"SANDBOX_API_IMAGE":"example.com/%s:test-tag"}}}}\\n' "$env_name" > "$output_file"
                      exit 0
                    fi
                    exec "{sys.executable}" "$@"
                    """
                )
            )
            fake_pin.write_text(
                textwrap.dedent(
                    """\
                    #!/bin/bash
                    printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" >> "$PIN_LOG_FILE"
                    """
                )
            )
            fake_python.chmod(0o755)
            fake_pin.chmod(0o755)
            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{fake_bin}:{env['PATH']}",
                    "TCR_BEIJING_PASSWORD": "fake-password",
                    "BUILD_TAG_OVERRIDE": "test-tag",
                    "DEPLOYED_AT": "2026-04-29T00:00:00Z",
                    "PIN_SCRIPT_OVERRIDE": str(fake_pin),
                    "PIN_LOG_FILE": str(pins_file),
                }
            )

            subprocess.run(
                [
                    "/bin/bash",
                    str(REPO_ROOT / ".ci/runtime/build_and_promote_to_gitops.sh"),
                    "sandbox",
                    "sandbox",
                    "beijing-sandbox,beijing-sandbox-2",
                    "beijing-sandbox,beijing-sandbox-2",
                ],
                cwd=REPO_ROOT,
                env=env,
                check=True,
                capture_output=True,
                text=True,
            )

            pins = pins_file.read_text().splitlines()
            self.assertEqual(len(pins), 2)
            self.assertIn("sandbox\tsandbox\tbeijing-sandbox\t", pins[0])
            self.assertIn("example.com/beijing-sandbox:test-tag", pins[0])
            self.assertIn("sandbox\tsandbox\tbeijing-sandbox-2\t", pins[1])
            self.assertIn("example.com/beijing-sandbox-2:test-tag", pins[1])


if __name__ == "__main__":
    unittest.main()
