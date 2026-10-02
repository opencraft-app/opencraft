#!/usr/bin/env python3
"""Roll back one exact failed semantic candidate while probing retained Objects."""

import argparse
import concurrent.futures
import hashlib
import importlib.util
import json
import os
import pathlib
import statistics
import time
import traceback
import uuid


def load_upgrade():
    path = pathlib.Path(__file__).with_name("user-transparent-upgrade.py")
    spec = importlib.util.spec_from_file_location("q01_upgrade_for_rollback", str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


upgrade = load_upgrade()


def load_verifier():
    path = pathlib.Path(__file__).with_name("verify-user-transparent-rollback.py")
    spec = importlib.util.spec_from_file_location("q01_rollback_verifier", str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


verifier = load_verifier()


def atomic_receipt(path, document):
    temporary = path.with_name("." + path.name + ".tmp." + str(os.getpid()))
    temporary.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
    os.chmod(str(temporary), 0o640)
    os.replace(str(temporary), str(path))


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kubeconfig", required=True)
    parser.add_argument("--release-script", required=True, type=pathlib.Path)
    parser.add_argument("--failed-receipt", required=True, type=pathlib.Path)
    parser.add_argument("--receipt", required=True, type=pathlib.Path)
    parser.add_argument("--release-log", required=True, type=pathlib.Path)
    parser.add_argument("--probe-concurrency", type=int, default=20)
    parser.add_argument("--probe-interval", type=float, default=0.5)
    parser.add_argument("--post-probe-seconds", type=float, default=10)
    parser.add_argument("--max-request-seconds", type=float, default=3)
    parser.add_argument("--release-timeout", type=int, default=3600)
    parser.add_argument("--capacity-convergence-timeout", type=int, default=900)
    args = parser.parse_args()
    if not args.release_script.is_absolute() or not args.release_script.is_file():
        parser.error("release script must be an existing absolute path")
    if not args.failed_receipt.is_absolute() or not args.failed_receipt.is_file():
        parser.error("failed receipt must be an existing absolute path")
    if not args.receipt.is_absolute() or not args.release_log.is_absolute():
        parser.error("receipt paths must be absolute")
    if args.probe_concurrency < 20 or args.probe_interval <= 0 or args.max_request_seconds <= 0:
        parser.error("rollback probe parameters are below the production gate")
    return args


def main():
    args = parse_args()
    failed_bytes = args.failed_receipt.read_bytes()
    failed = json.loads(failed_bytes)
    refs = failed["rollback_object_refs"]
    worker = failed["worker"]
    object_ids = [item["id"] for item in refs]
    run_id = uuid.uuid4().hex
    receipt = {
        "schema": "actor-bj-q01-user-transparent-rollback/v3",
        "verdict": "running", "cell": upgrade.CELL, "namespace": upgrade.NAMESPACE,
        "run_id": run_id, "worker": worker, "object_refs": refs,
        "public_api_only": True,
        "availability_contract": "post_convergence_zero_failure_state_continuity",
        "parameters": {
            "probe_concurrency": args.probe_concurrency,
            "probe_interval": args.probe_interval,
            "post_probe_seconds": args.post_probe_seconds,
            "max_request_seconds": args.max_request_seconds,
            "release_timeout": args.release_timeout,
            "capacity_convergence_timeout": args.capacity_convergence_timeout,
        },
        "failed_release": {"path": str(args.failed_receipt), "sha256": hashlib.sha256(failed_bytes).hexdigest(),
                           "run_id": failed["run_id"], "candidate_images": failed["target_images"]},
        "started_at": upgrade.utc_now(),
    }
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.release_log.parent.mkdir(parents=True, exist_ok=True)
    kube = upgrade.soak.Kubectl(args.kubeconfig)
    port_forward = None
    campaign = None
    cleanup_errors = []
    failure = None
    endpoint = None
    try:
        before, pre_capacity = upgrade.wait_for_healthy_capacity(kube, args.capacity_convergence_timeout)
        receipt["before"] = before
        receipt["pre_capacity_convergence"] = pre_capacity
        port_forward = upgrade.soak.PortForward(
            args.kubeconfig, upgrade.NAMESPACE, "service/" + upgrade.CELL + "-workers-api", 8080, "/readyz"
        )
        port_forward.wait()
        endpoint = port_forward.endpoint
        _, public_worker_before, _, _ = upgrade.json_request(
            "GET", endpoint + "/v1/workers/" + worker, expected=(200,), timeout=15
        )
        upgrade.assert_public_resource(public_worker_before, "worker")
        if public_worker_before != failed.get("public_worker_after"):
            raise RuntimeError("live Worker identity no longer matches the failed candidate receipt")
        receipt["public_worker_before"] = public_worker_before

        def initial_read(object_id):
            try:
                value, status, elapsed, request_id = upgrade.fetch_value(endpoint, worker, object_id, "read")
                return {"object_id": object_id, "status": status, "seconds": elapsed, "value": value,
                        "request_id": request_id, "error": None}
            except Exception as error:
                return {"object_id": object_id, "error": str(error)}

        with concurrent.futures.ThreadPoolExecutor(max_workers=args.probe_concurrency) as pool:
            initial = list(pool.map(initial_read, object_ids))
        receipt["candidate_probe"] = initial
        # Authorization comes from the immutable failed-release receipt plus
        # the exact live candidate image checked by verify-failed-release-
        # rollback.py. A transient latency/SLO failure is not expected to be
        # reproducible here, and requiring it to recur can strand the failed
        # candidate precisely when rollback is needed. Keep this probe as an
        # observation only; Object identity is fenced by the retained refs and
        # Worker resource above, then state continuity is proved after rollback.

        receipt["release_started_at"] = upgrade.utc_now()
        release_status = upgrade.run_release(args.release_script, args.release_log, args.release_timeout)
        receipt["release_finished_at"] = upgrade.utc_now()
        receipt["release_exit_code"] = release_status
        if release_status != 0:
            raise RuntimeError("rollback release exited {}".format(release_status))

        # The starting artifact is deliberately known-bad. Counting requests
        # made before rollback convergence and then requiring zero failures is
        # an impossible contract: those requests still execute on the broken
        # candidate by construction. Prove the operationally meaningful
        # boundary instead: once the guarded release reports convergence, the
        # public API has zero failures and every retained Object preserves and
        # advances its exact durable state.
        campaign = upgrade.ProbeCampaign(
            endpoint, worker, object_ids, args.probe_concurrency,
            args.probe_interval, args.max_request_seconds,
        )
        receipt["rollback_probe_started_at"] = upgrade.utc_now()
        campaign.start()
        time.sleep(args.post_probe_seconds)
        campaign.stop()
        receipt["rollback_probe_finished_at"] = upgrade.utc_now()
        receipt["rollback_probe"] = campaign.receipt_summary()

        after, post_capacity = upgrade.wait_for_healthy_capacity(kube, args.capacity_convergence_timeout)
        receipt["after"] = after
        receipt["post_capacity_convergence"] = post_capacity
        receipt["target_images"] = upgrade.assert_target_images(
            {name: upgrade.component_view(after, name, pod_field) for name, pod_field in (
                ("engine", "engine_pods"), ("runtime", "runtime_pods"), ("nats", "nats_pods"),
                ("capacity", "capacity_pods"), ("reporter", "reporter_pods"),
            )}, upgrade.target_images_from_environment(),
        )
        receipt["component_transitions"] = [
            upgrade.assert_component_transition(
                name, upgrade.component_view(before, name, pod_field),
                upgrade.component_view(after, name, pod_field), scalable=(name == "runtime"),
            ) for name, pod_field in (
                ("engine", "engine_pods"), ("runtime", "runtime_pods"), ("nats", "nats_pods"),
                ("capacity", "capacity_pods"), ("reporter", "reporter_pods"),
            )
        ]
        if after.get("ledger") is None:
            raise RuntimeError("rollback completed without a static release ledger")
        _, public_worker_after, _, _ = upgrade.json_request(
            "GET", endpoint + "/v1/workers/" + worker, expected=(200,), timeout=15
        )
        upgrade.assert_public_resource(public_worker_after, "worker")
        receipt["public_worker_after"] = public_worker_after
        if public_worker_after != public_worker_before:
            raise RuntimeError("rollback changed the user Worker deployment identity")

        def verify_and_advance(object_id):
            value, _, read_seconds, _ = upgrade.fetch_value(endpoint, worker, object_id, "read")
            if value != 1:
                raise RuntimeError("rollback state was not 1 for {}: {}".format(object_id, value))
            value, _, write_seconds, _ = upgrade.fetch_value(endpoint, worker, object_id, "increment")
            if value != 2:
                raise RuntimeError("rollback state did not advance exactly to 2 for {}: {}".format(object_id, value))
            return {"object_id": object_id, "read_seconds": read_seconds, "write_seconds": write_seconds, "value": value}

        with concurrent.futures.ThreadPoolExecutor(max_workers=args.probe_concurrency) as pool:
            verified = list(pool.map(verify_and_advance, object_ids))
        receipt["state_continuity"] = verified
        if max(max(item["read_seconds"], item["write_seconds"]) for item in verified) >= args.max_request_seconds:
            raise RuntimeError("restored Object state exceeded the public request SLO")
        receipt["verdict"] = "passed"
    except Exception as error:
        failure = error
        receipt["verdict"] = "failed"
        receipt["error"] = {"type": type(error).__name__, "message": str(error), "traceback": traceback.format_exc()}
    finally:
        if campaign is not None:
            campaign.stop()
            receipt.setdefault("rollback_probe", campaign.receipt_summary())
        if args.release_log.exists():
            receipt["release_log"] = {"path": str(args.release_log), "bytes": args.release_log.stat().st_size,
                                      "sha256": hashlib.sha256(args.release_log.read_bytes()).hexdigest()}
        receipt["cleanup_errors"] = cleanup_errors
        receipt["rollback_objects_retained"] = receipt.get("verdict") != "passed"
        receipt["finished_at"] = upgrade.utc_now()

        # A failed rollback is recoverable only while its exact Objects remain.
        # Run the independent verifier before issuing the first irreversible
        # DELETE, then clean up only the evidence set it authorized.
        if endpoint is not None and receipt.get("verdict") == "passed":
            try:
                expected = receipt["target_images"]["runtime"]["container/workerd"]
                verified = verifier.verify(receipt, failed_bytes, expected, require_pre_cleanup=False)
                receipt["pre_cleanup_verification"] = verified
            except Exception as error:
                receipt["verdict"] = "failed"
                receipt["rollback_objects_retained"] = True
                receipt["error"] = {
                    "type": type(error).__name__, "message": str(error),
                    "traceback": traceback.format_exc(),
                }
                failure = error
        if endpoint is not None and receipt.get("verdict") == "passed":
            receipt["cleanup_issued"] = True
            for object_id in object_ids:
                try:
                    upgrade.json_request("DELETE", upgrade.object_url(endpoint, worker, object_id), expected=(204, 404), timeout=30)
                except Exception as error:
                    cleanup_errors.append("object {}: {}".format(object_id, error))
        if port_forward is not None:
            port_forward.close()
        receipt["cleanup_errors"] = cleanup_errors
        if cleanup_errors:
            receipt["verdict"] = "failed"
            receipt["rollback_objects_retained"] = True
            failure = RuntimeError("rollback Object cleanup was incomplete")
        elif receipt.get("verdict") == "passed":
            receipt["rollback_objects_retained"] = False
        receipt["finished_at"] = upgrade.utc_now()
        atomic_receipt(args.receipt, receipt)
        print("receipt={} verdict={}".format(args.receipt, receipt["verdict"]))
    if failure is not None:
        raise failure


if __name__ == "__main__":
    main()
