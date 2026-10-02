import json
import os
import pathlib
import subprocess
import tempfile
import textwrap
import unittest


SCRIPT = pathlib.Path(__file__).with_name("preflight-image-pull.sh")


class ImagePreflightTests(unittest.TestCase):
    def test_transient_image_pull_backoff_is_retried(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            capture = root / "applied.json"
            polls = root / "polls"
            kubectl = root / "kubectl"
            kubectl.write_text(textwrap.dedent("""\
                #!/usr/bin/env python3
                import json,os,pathlib,sys
                args=sys.argv[1:]
                if "apply" in args:
                    pathlib.Path(os.environ["PREFLIGHT_CAPTURE"]).write_text(sys.stdin.read())
                    raise SystemExit(0)
                if "delete" in args:
                    raise SystemExit(0)
                if "get" not in args:
                    raise SystemExit("unexpected kubectl operation")
                resource=args[args.index("get")+1]
                if resource == "secret":
                    print('{}'); raise SystemExit(0)
                if resource == "nodes":
                    print(json.dumps({"items":[{"metadata":{"name":"node-a"}}]})); raise SystemExit(0)
                if resource == "pods":
                    counter=pathlib.Path(os.environ["PREFLIGHT_POLLS"])
                    count=int(counter.read_text()) if counter.exists() else 0
                    counter.write_text(str(count+1))
                    source=json.loads(pathlib.Path(os.environ["PREFLIGHT_CAPTURE"]).read_text())
                    if count == 0:
                        state={"waiting":{"reason":"ImagePullBackOff"}}
                    else:
                        state={"terminated":{"exitCode":0}}
                    source["items"][0]["status"]={"containerStatuses":[{"state":state}]}
                    print(json.dumps(source)); raise SystemExit(0)
                raise SystemExit("unexpected kubectl resource: "+resource)
                """))
            kubectl.chmod(0o755)
            env = os.environ.copy()
            env.update({
                "PATH": str(root) + os.pathsep + env["PATH"],
                "PREFLIGHT_CAPTURE": str(capture),
                "PREFLIGHT_POLLS": str(polls),
                "ACTOR_IMAGE_PREFLIGHT_NAMESPACE": "test",
                "ACTOR_IMAGE_PREFLIGHT_NAME": "pull-retry",
                "ACTOR_IMAGE_PREFLIGHT_IMAGE": "registry.invalid/runtime@sha256:" + "a" * 64,
                "ACTOR_IMAGE_PREFLIGHT_PULL_SECRET": "pull-secret",
                "ACTOR_IMAGE_PREFLIGHT_NODE_SELECTOR": "runtime=true",
                "ACTOR_IMAGE_PREFLIGHT_TIMEOUT_SECONDS": "5",
            })
            result = subprocess.run(
                [str(SCRIPT), "/bin/true"], env=env, universal_newlines=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertGreaterEqual(int(polls.read_text()), 2)

    def test_large_node_and_pod_lists_never_cross_argv(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            capture = root / "applied.json"
            kubectl = root / "kubectl"
            kubectl.write_text(textwrap.dedent("""\
                #!/usr/bin/env python3
                import json,os,pathlib,sys
                args=sys.argv[1:]
                if "apply" in args:
                    pathlib.Path(os.environ["PREFLIGHT_CAPTURE"]).write_text(sys.stdin.read())
                    raise SystemExit(0)
                if "delete" in args:
                    raise SystemExit(0)
                if "get" not in args:
                    raise SystemExit("unexpected kubectl operation")
                resource=args[args.index("get")+1]
                if resource == "secret":
                    print('{}'); raise SystemExit(0)
                if resource == "nodes":
                    # Larger than a typical 128 KiB exec argument budget.
                    items=[{"metadata":{"name":f"node-{i:04d}","annotations":{"padding":"x"*1024}}}
                           for i in range(320)]
                    print(json.dumps({"items":items})); raise SystemExit(0)
                if resource == "pods":
                    source=json.loads(pathlib.Path(os.environ["PREFLIGHT_CAPTURE"]).read_text())
                    items=[]
                    for pod in source["items"]:
                        items.append({"metadata":pod["metadata"],"status":{"containerStatuses":[
                            {"state":{"terminated":{"exitCode":0}}}]}})
                    print(json.dumps({"items":items})); raise SystemExit(0)
                raise SystemExit("unexpected kubectl resource: "+resource)
                """))
            kubectl.chmod(0o755)
            env = os.environ.copy()
            env.update({
                "PATH": str(root) + os.pathsep + env["PATH"],
                "PREFLIGHT_CAPTURE": str(capture),
                "ACTOR_IMAGE_PREFLIGHT_NAMESPACE": "test",
                "ACTOR_IMAGE_PREFLIGHT_NAME": "large-list",
                "ACTOR_IMAGE_PREFLIGHT_IMAGE": "registry.invalid/runtime@sha256:" + "a" * 64,
                "ACTOR_IMAGE_PREFLIGHT_PULL_SECRET": "pull-secret",
                "ACTOR_IMAGE_PREFLIGHT_NODE_SELECTOR": "runtime=true",
                "ACTOR_IMAGE_PREFLIGHT_TIMEOUT_SECONDS": "10",
            })
            result = subprocess.run(
                [str(SCRIPT), "/bin/true"], env=env, universal_newlines=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            applied = json.loads(capture.read_text())
            self.assertEqual(len(applied["items"]), 320)
            self.assertIn("nodes=320", result.stdout)

    def test_required_output_rejects_an_older_cli_contract(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            capture = root / "applied.json"
            kubectl = root / "kubectl"
            kubectl.write_text(textwrap.dedent("""\
                #!/usr/bin/env python3
                import json,os,pathlib,sys
                args=sys.argv[1:]
                if "apply" in args:
                    pathlib.Path(os.environ["PREFLIGHT_CAPTURE"]).write_text(sys.stdin.read())
                    raise SystemExit(0)
                if "delete" in args:
                    raise SystemExit(0)
                if "logs" in args:
                    print(os.environ["PREFLIGHT_LOGS"])
                    raise SystemExit(0)
                if "get" not in args:
                    raise SystemExit("unexpected kubectl operation")
                resource=args[args.index("get")+1]
                if resource == "secret":
                    print('{}'); raise SystemExit(0)
                if resource == "nodes":
                    print(json.dumps({"items":[{"metadata":{"name":"node-a"}}]})); raise SystemExit(0)
                if resource == "pods" and any(value.startswith("jsonpath=") for value in args):
                    print("contract-test-a"); raise SystemExit(0)
                if resource == "pods":
                    source=json.loads(pathlib.Path(os.environ["PREFLIGHT_CAPTURE"]).read_text())
                    source["items"][0]["status"]={"containerStatuses":[{"state":{"terminated":{"exitCode":0}}}]}
                    print(json.dumps(source)); raise SystemExit(0)
                raise SystemExit("unexpected kubectl resource: "+resource)
                """))
            kubectl.chmod(0o755)
            env = os.environ.copy()
            env.update({
                "PATH": str(root) + os.pathsep + env["PATH"],
                "PREFLIGHT_CAPTURE": str(capture),
                "PREFLIGHT_LOGS": "-engine-cell value\n-qualification-cell string",
                "ACTOR_IMAGE_PREFLIGHT_NAMESPACE": "test",
                "ACTOR_IMAGE_PREFLIGHT_NAME": "contract-test",
                "ACTOR_IMAGE_PREFLIGHT_IMAGE": "registry.invalid/runtime@sha256:" + "a" * 64,
                "ACTOR_IMAGE_PREFLIGHT_PULL_SECRET": "pull-secret",
                "ACTOR_IMAGE_PREFLIGHT_NODE_SELECTOR": "runtime=true",
                "ACTOR_IMAGE_PREFLIGHT_TIMEOUT_SECONDS": "1",
                "ACTOR_IMAGE_PREFLIGHT_REQUIRED_OUTPUT": "-engine-cell\n-qualification-cell-uid",
            })
            result = subprocess.run(
                [str(SCRIPT), "/bin/runtime", "--help"], env=env,
                universal_newlines=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("lacks required output: -qualification-cell-uid", result.stderr)

            env["PREFLIGHT_LOGS"] += "\n-qualification-cell-uid string"
            result = subprocess.run(
                [str(SCRIPT), "/bin/runtime", "--help"], env=env,
                universal_newlines=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
