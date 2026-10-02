#!/usr/bin/env python3

import importlib.util
import pathlib
import unittest
from unittest import mock


MODULE_PATH = pathlib.Path(__file__).resolve().with_name("agent-arrival-rate.py")
SPEC = importlib.util.spec_from_file_location("q01_agent_arrival_rate", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def result(value):
    return [{"metric": {}, "value": [0, str(value)]}]


ENGINE_PODS = [f"actor-engine-{suffix}" for suffix in "abcdef"]


class PlacementMetricTest(unittest.TestCase):
    def test_canary_metrics_must_quiesce_before_the_user_load_baseline(self):
        first = {key: 1.0 for key in (
            "transactions", "attempts", "at_most_five_attempts", "at_most_eight_attempts",
            "retry_fallbacks", "allocation_gate_count", "allocation_gate_wait_seconds",
            "allocation_gate_at_most_one_second", "successful_allocations",
            "unavailable_allocations", "no_envoy_allocations", "capacity_rejections",
        )}
        first["active_actors_by_host"] = {}
        visible = dict(first, transactions=3.0, successful_allocations=3.0,
                       allocation_gate_count=3.0)
        with mock.patch.object(
            MODULE, "placement_metrics", side_effect=[first, visible, visible]
        ) as metrics, mock.patch.object(MODULE.time, "sleep") as sleep:
            baseline = MODULE.settle_placement_metric_baseline(
                "http://prometheus", ENGINE_PODS, 35, attempts=3
            )
        self.assertEqual(3.0, baseline["successful_allocations"])
        self.assertEqual(3, metrics.call_count)
        self.assertEqual([mock.call(35), mock.call(35)], sleep.call_args_list)

    def test_busy_cell_cannot_produce_a_contaminated_metric_baseline(self):
        values = []
        for count in range(1, 5):
            item = {key: float(count) for key in (
                "transactions", "attempts", "at_most_five_attempts", "at_most_eight_attempts",
                "retry_fallbacks", "allocation_gate_count", "allocation_gate_wait_seconds",
                "allocation_gate_at_most_one_second", "successful_allocations",
                "unavailable_allocations", "no_envoy_allocations", "capacity_rejections",
            )}
            item["active_actors_by_host"] = {}
            values.append(item)
        with mock.patch.object(MODULE, "placement_metrics", side_effect=values), \
                mock.patch.object(MODULE.time, "sleep"):
            with self.assertRaisesRegex(RuntimeError, "did not quiesce"):
                MODULE.settle_placement_metric_baseline(
                    "http://prometheus", ENGINE_PODS, 1, attempts=3
                )

    def test_uses_exported_float_bucket_labels(self):
        queries = []

        def fake_vector(_endpoint, query):
            queries.append(query)
            if "active_actors" in query:
                return []
            if "actor_allocate_duration" in query and 'result="allocated"' in query:
                return result(180)
            if "actor_allocate_duration" in query and 'result="not_allocated"' in query:
                return result(5)
            if "no_envoy_available" in query or "capacity_rejected" in query:
                return result(5)
            if "allocation_gate_wait" in query and "_count" in query:
                return result(180)
            if "allocation_gate_wait" in query and "_sum" in query:
                return result(12)
            if "allocation_gate_wait" in query and 'le="1.0"' in query:
                return result(180)
            if "_count" in query:
                return result(180)
            if "_sum" in query:
                return result(311)
            if 'le="5.0"' in query:
                return result(180)
            if 'le="8.0"' in query:
                return result(180)
            if "retry_fallback" in query:
                return result(131)
            raise AssertionError(query)

        with mock.patch.object(MODULE, "prometheus_vector", side_effect=fake_vector):
            metrics = MODULE.placement_metrics("http://prometheus", ENGINE_PODS)

        self.assertEqual(180, metrics["at_most_five_attempts"])
        self.assertEqual(180, metrics["at_most_eight_attempts"])
        self.assertEqual(180, metrics["allocation_gate_count"])
        self.assertEqual(180, metrics["allocation_gate_at_most_one_second"])
        self.assertEqual(180, metrics["successful_allocations"])
        self.assertEqual(5, metrics["unavailable_allocations"])
        self.assertEqual(5, metrics["no_envoy_allocations"])
        self.assertEqual(5, metrics["capacity_rejections"])
        self.assertTrue(any('le="5.0"' in query for query in queries))
        self.assertTrue(any('le="8.0"' in query for query in queries))
        self.assertTrue(any('le="1.0"' in query for query in queries))
        expected_pod_matcher = 'pod=~"' + "|".join(ENGINE_PODS) + '"'
        self.assertTrue(all(
            expected_pod_matcher in query
            for query in queries if "active_actors" not in query
        ))
        self.assertFalse(any(r"\-" in query for query in queries))

    def test_missing_bucket_fails_when_histogram_has_observations(self):
        def fake_vector(_endpoint, query):
            if "active_actors" in query:
                return []
            if "_count" in query:
                return result(1)
            if "_sum" in query:
                return result(1)
            if "_bucket" in query:
                return []
            if "retry_fallback" in query:
                return []
            raise AssertionError(query)

        with mock.patch.object(MODULE, "prometheus_vector", side_effect=fake_vector):
            with self.assertRaisesRegex(RuntimeError, "required Prometheus series"):
                MODULE.placement_metrics("http://prometheus", ENGINE_PODS)

    def test_empty_fresh_histogram_is_a_valid_zero_baseline(self):
        def fake_vector(_endpoint, query):
            if "active_actors" in query:
                return []
            return []

        with mock.patch.object(MODULE, "prometheus_vector", side_effect=fake_vector):
            metrics = MODULE.placement_metrics("http://prometheus", ENGINE_PODS)

        self.assertEqual(0, metrics["transactions"])
        self.assertEqual(0, metrics["attempts"])
        self.assertEqual(0, metrics["at_most_five_attempts"])
        self.assertEqual(0, metrics["allocation_gate_count"])

    def test_accepts_bounded_unavailable_retries(self):
        delta = {
            "successful_allocations": 180,
            "unavailable_allocations": 5,
            "no_envoy_allocations": 5,
            "capacity_rejections": 5,
            "transactions": 185,
            "allocation_gate_count": 185,
            "allocation_gate_over_one_second": 0,
            "allocation_gate_over_one_second_budget": 19,
            "average_allocation_gate_wait_seconds": 0.1,
            "allocation_amplification": 185 / 180,
            "over_five_attempts": 0,
            "over_five_attempt_budget": 1,
            "over_eight_attempts": 0,
            "average_attempts": 1.26,
        }
        MODULE.verify_placement_metric_delta(delta, 180)

    def test_rejects_success_contamination_and_excess_unavailable_retries(self):
        base = {
            "successful_allocations": 181,
            "unavailable_allocations": 5,
            "no_envoy_allocations": 5,
            "capacity_rejections": 5,
            "transactions": 186,
            "allocation_gate_count": 186,
            "allocation_gate_over_one_second": 0,
            "allocation_gate_over_one_second_budget": 19,
            "average_allocation_gate_wait_seconds": 0.1,
            "allocation_amplification": 186 / 181,
            "over_five_attempts": 0,
            "over_five_attempt_budget": 1,
            "over_eight_attempts": 0,
            "average_attempts": 1.26,
        }
        with self.assertRaisesRegex(RuntimeError, "incomplete or contaminated"):
            MODULE.verify_placement_metric_delta(base, 180)
        base.update(
            successful_allocations=180,
            unavailable_allocations=46,
            no_envoy_allocations=46,
            capacity_rejections=46,
            transactions=226,
            allocation_gate_count=226,
            allocation_amplification=226 / 180,
        )
        with self.assertRaisesRegex(RuntimeError, "work amplification"):
            MODULE.verify_placement_metric_delta(base, 180)

    def test_rejects_unexplained_unavailability(self):
        delta = {
            "successful_allocations": 180,
            "unavailable_allocations": 34,
            "no_envoy_allocations": 34,
            "capacity_rejections": 33,
            "transactions": 214,
            "allocation_gate_count": 214,
            "allocation_gate_over_one_second": 0,
            "allocation_gate_over_one_second_budget": 22,
            "average_allocation_gate_wait_seconds": 0.1,
            "allocation_amplification": 214 / 180,
            "over_five_attempts": 0,
            "over_five_attempt_budget": 2,
            "over_eight_attempts": 0,
            "average_attempts": 1.26,
        }
        with self.assertRaisesRegex(RuntimeError, "unexplained temporary unavailability"):
            MODULE.verify_placement_metric_delta(delta, 180)

    def test_accepts_cloud_observed_bounded_capacity_backpressure(self):
        delta = {
            "successful_allocations": 180,
            "unavailable_allocations": 34,
            "no_envoy_allocations": 34,
            "capacity_rejections": 34,
            "transactions": 214,
            "allocation_gate_count": 214,
            "allocation_gate_over_one_second": 18,
            "allocation_gate_over_one_second_budget": 22,
            "average_allocation_gate_wait_seconds": 0.1891,
            "allocation_amplification": 214 / 180,
            "over_five_attempts": 1,
            "over_five_attempt_budget": 2,
            "over_eight_attempts": 0,
            "average_attempts": 1.2711,
        }
        MODULE.verify_placement_metric_delta(delta, 180)

    def test_rejects_slow_contention_gate_even_when_backpressure_is_explained(self):
        delta = {
            "successful_allocations": 180,
            "unavailable_allocations": 34,
            "no_envoy_allocations": 34,
            "capacity_rejections": 34,
            "transactions": 214,
            "allocation_gate_count": 214,
            "allocation_gate_over_one_second": 23,
            "allocation_gate_over_one_second_budget": 22,
            "average_allocation_gate_wait_seconds": 0.251,
            "allocation_amplification": 214 / 180,
            "over_five_attempts": 1,
            "over_five_attempt_budget": 2,
            "over_eight_attempts": 0,
            "average_attempts": 1.2711,
        }
        with self.assertRaisesRegex(RuntimeError, "average exceeded 250ms"):
            MODULE.verify_placement_metric_delta(delta, 180)

    def test_accepts_one_percent_retry_tail_but_rejects_any_tail_above_eight(self):
        delta = {
            "successful_allocations": 180,
            "unavailable_allocations": 10,
            "no_envoy_allocations": 10,
            "capacity_rejections": 10,
            "transactions": 190,
            "allocation_gate_count": 190,
            "allocation_gate_over_one_second": 0,
            "allocation_gate_over_one_second_budget": 19,
            "average_allocation_gate_wait_seconds": 0.1,
            "allocation_amplification": 190 / 180,
            "over_five_attempts": 1,
            "over_five_attempt_budget": 1,
            "over_eight_attempts": 0,
            "average_attempts": 1.28,
        }
        MODULE.verify_placement_metric_delta(delta, 180)
        delta["over_eight_attempts"] = 1
        with self.assertRaisesRegex(RuntimeError, "above eight attempts"):
            MODULE.verify_placement_metric_delta(delta, 180)

    def test_rejects_more_than_one_percent_above_five_attempts(self):
        delta = {
            "successful_allocations": 180,
            "unavailable_allocations": 10,
            "no_envoy_allocations": 10,
            "capacity_rejections": 10,
            "transactions": 190,
            "allocation_gate_count": 190,
            "allocation_gate_over_one_second": 0,
            "allocation_gate_over_one_second_budget": 19,
            "average_allocation_gate_wait_seconds": 0.1,
            "allocation_amplification": 190 / 180,
            "over_five_attempts": 2,
            "over_five_attempt_budget": 1,
            "over_eight_attempts": 0,
            "average_attempts": 1.28,
        }
        with self.assertRaisesRegex(RuntimeError, "p99 five-attempt"):
            MODULE.verify_placement_metric_delta(delta, 180)

    def test_models_hpa_tolerance_without_weakening_hard_capacity(self):
        self.assertEqual(5, MODULE.minimum_hpa_replicas(80, 16, 0.10))
        self.assertEqual(6, MODULE.minimum_hpa_replicas(100, 16, 0.10))
        self.assertEqual(7, MODULE.minimum_hpa_replicas(106, 16, 0.10))
        self.assertEqual(3, MODULE.minimum_hpa_replicas(1, 16, 0.10))
        with self.assertRaises(ValueError):
            MODULE.minimum_hpa_replicas(100, 16, 1.0)

    def test_rejects_any_host_above_hard_admission_capacity(self):
        MODULE.verify_host_distribution_within_capacity(
            {"runtime-a": 32, "runtime-b": 17}, 32, 49
        )
        with self.assertRaisesRegex(RuntimeError, "exceeded hard Actor admission"):
            MODULE.verify_host_distribution_within_capacity(
                {"runtime-a": 33}, 32, 33
            )
        with self.assertRaisesRegex(RuntimeError, "distribution is incomplete"):
            MODULE.verify_host_distribution_within_capacity(
                {"runtime-a": 20, "runtime-b": 20}, 32, 100
            )

    def test_binds_hard_capacity_to_live_runtime_statefulset(self):
        class Kube:
            def json(self, *_args):
                return {
                    "spec": {"template": {"spec": {"containers": [
                        {"name": "workerd-host", "env": [
                            {"name": "RIVET_WORKERD_MAX_ACTIVE_ACTORS", "value": "32"}
                        ]}
                    ]}}}
                }

        self.assertEqual(32, MODULE.verify_runtime_host_capacity(Kube(), 32))
        with self.assertRaisesRegex(RuntimeError, "does not equal 16"):
            MODULE.verify_runtime_host_capacity(Kube(), 16)


class ExactScaleDownReceiptTest(unittest.TestCase):
    @staticmethod
    def receipt(source, target, request_id):
        return {
            "version": 2,
            "completed_at": f"2026-09-05T01:{source:02d}:00Z",
            "outcome": "provider_acknowledged",
            "intent": {
                "version": 2,
                "desired_hosts": target,
                "from_replicas": source,
                "to_replicas": target,
                "attempts": 1,
                "request_id": request_id,
            },
        }

    def test_deduplicates_poll_samples_and_excludes_baseline(self):
        baseline = self.receipt(4, 3, "old")
        first = self.receipt(6, 5, "one")
        second = self.receipt(5, 4, "two")
        timeline = [
            {"machine_set_last_downscale_receipt": baseline},
            {"machine_set_last_downscale_receipt": first},
            {"machine_set_last_downscale_receipt": first},
            {"machine_set_last_downscale_receipt": second},
        ]
        self.assertEqual(
            ["one", "two"],
            [item["intent"]["request_id"] for item in MODULE.exact_scale_down_receipts(timeline, baseline)],
        )

    def test_rejects_missing_provider_request_id_without_ambiguous_outcome(self):
        invalid = self.receipt(6, 5, "")
        with self.assertRaisesRegex(RuntimeError, "invalid exact scale-down receipt"):
            MODULE.exact_scale_down_receipts(
                [{"machine_set_last_downscale_receipt": invalid}]
            )

    def test_accepts_explicit_ambiguous_success_with_exact_convergence(self):
        receipt = self.receipt(6, 5, "")
        receipt["outcome"] = "observed_exact_convergence_after_ambiguous_response"
        self.assertEqual(
            [receipt],
            MODULE.exact_scale_down_receipts(
                [{"machine_set_last_downscale_receipt": receipt}]
            ),
        )

    def test_rejects_request_id_on_ambiguous_outcome(self):
        invalid = self.receipt(6, 5, "request")
        invalid["outcome"] = "observed_exact_convergence_after_ambiguous_response"
        with self.assertRaisesRegex(RuntimeError, "invalid exact scale-down receipt"):
            MODULE.exact_scale_down_receipts(
                [{"machine_set_last_downscale_receipt": invalid}]
            )

    def test_accepts_provider_catchup_behind_serial_host_drain(self):
        invalid = self.receipt(7, 6, "request")
        invalid["intent"]["desired_hosts"] = 5
        self.assertEqual(
            [invalid],
            MODULE.exact_scale_down_receipts(
                [{"machine_set_last_downscale_receipt": invalid}]
            ),
        )

    def test_rejects_provider_target_below_the_desired_hosts(self):
        invalid = self.receipt(7, 6, "request")
        invalid["intent"]["desired_hosts"] = 7
        with self.assertRaisesRegex(RuntimeError, "invalid exact scale-down receipt"):
            MODULE.exact_scale_down_receipts(
                [{"machine_set_last_downscale_receipt": invalid}]
            )


class FailureRecoveryBaselineTest(unittest.TestCase):
    def test_requires_both_controller_layers_and_no_intent(self):
        baseline = {
            "statefulset_spec_replicas": 3,
            "statefulset_ready_replicas": 3,
            "machine_set_spec_replicas": 3,
            "machine_set_status_replicas": 3,
            "runtime_nodes": 3,
            "machine_set_downscale_intent": None,
        }
        self.assertTrue(MODULE.runtime_baseline_converged(baseline))
        for field in (
            "statefulset_spec_replicas",
            "statefulset_ready_replicas",
            "machine_set_spec_replicas",
            "machine_set_status_replicas",
            "runtime_nodes",
        ):
            invalid = dict(baseline)
            invalid[field] = 4
            self.assertFalse(MODULE.runtime_baseline_converged(invalid), field)
        invalid = dict(baseline)
        invalid["machine_set_downscale_intent"] = "pending"
        self.assertFalse(MODULE.runtime_baseline_converged(invalid))


if __name__ == "__main__":
    unittest.main()
