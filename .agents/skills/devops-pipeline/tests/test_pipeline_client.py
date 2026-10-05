import argparse
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "pipeline_client.py"
SPEC = importlib.util.spec_from_file_location("pipeline_client", SCRIPT)
client = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(client)


def status(state="RUNNING", channel="GIT", **extra):
    data = {"id": "b-target", "pipelineId": "p-target", "status": state,
            "webhookInfo": {"channelCode": channel},
            "variables": {"BK_CI_START_CHANNEL": channel}}
    data.update(extra)
    return {"status": 0, "data": data}


class BuildStopTests(unittest.TestCase):
    def setUp(self):
        self.args = argparse.Namespace(access_token=None, project_id="project",
                                       pipeline_id="p-target", build_id="b-target",
                                       channel=None, wait_seconds=0)
        self.token = patch.object(client, "get_access_token", return_value="synthetic-token").start()
        self.output = patch.object(client, "print_data").start()
        self.addCleanup(patch.stopall)

    def test_stream_stop_keeps_auth_and_routes_observed_channel(self):
        with patch.object(client, "make_request", side_effect=[status(), {"status": 0, "data": True},
                                                               status("CANCELED")]) as request:
            client.cmd_stop(self.args)
        stop = request.call_args_list[1]
        self.assertEqual(stop.kwargs["headers"], {"X-DEVOPS-CHANNEL": "GIT"})
        self.assertEqual(stop.kwargs["access_token"], "synthetic-token")
        self.assertEqual(stop.kwargs["method"], "POST")
        self.assertEqual(stop.kwargs["data"], {})
        self.assertIn("buildId=b-target", stop.args[0])
        self.assertTrue(self.output.call_args.args[0]["cancellationVerified"])

    def test_other_actual_channels_are_not_hardcoded_to_git(self):
        for channel in ["BS", "CREATIVE_STREAM"]:
            with self.subTest(channel=channel), patch.object(client, "make_request", side_effect=[
                status(channel=channel), {"status": 0, "data": True}, status("CANCELED", channel)
            ]) as request:
                client.cmd_stop(self.args)
                self.assertEqual(request.call_args_list[1].kwargs["headers"]["X-DEVOPS-CHANNEL"], channel)

    def test_missing_conflicting_and_unknown_metadata_cannot_send_stop(self):
        cases = [status(channel=None), status(channel="UNRECOGNIZED"),
                 status(variables={"BK_CI_START_CHANNEL": "BS"}), status(webhookInfo=[]),
                 status(variables=[])]
        for response in cases:
            with self.subTest(response=response), patch.object(client, "make_request", return_value=response) as request:
                with self.assertRaises(SystemExit):
                    client.cmd_stop(self.args)
                self.assertEqual(request.call_count, 1)

    def test_explicit_channel_cannot_override_observed_owner(self):
        self.args.channel = "BS"
        with patch.object(client, "make_request", return_value=status()) as request:
            with self.assertRaises(SystemExit):
                client.cmd_stop(self.args)
            self.assertEqual(request.call_count, 1)

    def test_missing_channel_requires_independent_explicit_evidence(self):
        self.assertEqual(client.resolve_build_channel({}, "BS"), "BS")
        with self.assertRaises(SystemExit):
            client.resolve_build_channel({})

    def test_wrong_build_or_pipeline_identity_cannot_send_stop(self):
        for identity in [{"id": "b-other"}, {"pipelineId": "p-other"}]:
            with self.subTest(identity=identity), patch.object(client, "make_request", return_value=status(**identity)) as request:
                with self.assertRaises(SystemExit):
                    client.cmd_stop(self.args)
                self.assertEqual(request.call_count, 1)

    def test_status_error_cannot_send_stop(self):
        for response in [{"status": 1, "data": {}}, {"status": 0, "data": []},
                         {"status": 0, "result": False, "data": status()["data"]}]:
            with self.subTest(response=response), patch.object(client, "make_request", return_value=response) as request:
                with self.assertRaises(SystemExit):
                    client.cmd_stop(self.args)
                self.assertEqual(request.call_count, 1)

    def test_boolean_success_with_still_running_is_not_cancellation(self):
        with patch.object(client, "make_request", side_effect=[status(), {"status": 0, "data": True}, status()]) as request:
            with self.assertRaises(SystemExit) as error:
                client.cmd_stop(self.args)
        self.assertEqual(error.exception.code, 2)
        self.assertFalse(self.output.call_args.args[0]["cancellationVerified"])
        self.assertEqual(request.call_count, 3)

    def test_status_is_polled_without_repeating_write(self):
        self.args.wait_seconds = 30
        with patch.object(client, "make_request", side_effect=[status(), {"status": 0, "data": True},
                                                               status(), status("CANCELED")]) as request, \
                patch.object(client.time, "sleep"):
            client.cmd_stop(self.args)
        writes = [call for call in request.call_args_list if call.kwargs.get("method") == "POST"]
        self.assertEqual(len(writes), 1)
        self.assertTrue(self.output.call_args.args[0]["cancellationVerified"])

    def test_failed_stop_response_cannot_poll_or_repeat_stop(self):
        for response in [{"status": 1, "data": True}, {"status": 0, "data": False},
                         {"status": 0, "result": False, "data": True}]:
            with self.subTest(response=response), patch.object(client, "make_request", side_effect=[status(), response]) as request:
                with self.assertRaises(SystemExit):
                    client.cmd_stop(self.args)
                self.assertEqual(request.call_count, 2)

    def test_already_canceled_does_not_send_stop(self):
        with patch.object(client, "make_request", return_value=status("CANCELED")) as request:
            client.cmd_stop(self.args)
        self.assertEqual(request.call_count, 1)
        self.assertFalse(self.output.call_args.args[0]["stopRequested"])

    def test_finished_or_unknown_state_does_not_send_stop(self):
        for state in ["SUCCEED", "FAILED", "TERMINATE", "UNKNOWN"]:
            with self.subTest(state=state), patch.object(client, "make_request", return_value=status(state)) as request:
                with self.assertRaises(SystemExit):
                    client.cmd_stop(self.args)
                self.assertEqual(request.call_count, 1)

    def test_completion_race_is_not_reported_as_cancellation(self):
        with patch.object(client, "make_request", side_effect=[status(), {"status": 0, "data": True},
                                                               status("SUCCEED")]):
            with self.assertRaises(SystemExit) as error:
                client.cmd_stop(self.args)
        self.assertEqual(error.exception.code, 2)
        self.assertFalse(self.output.call_args.args[0]["cancellationVerified"])


if __name__ == "__main__":
    unittest.main()
