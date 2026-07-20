package gateway

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"
)

func (s *Service) storePrometheusMetrics(ctx context.Context) string {
	if s == nil || s.store == nil {
		return ""
	}
	_ = s.ensureDefaultWorkerJobs(ctx)

	var b strings.Builder
	var managedSets []Set
	sets, err := s.store.ListSets(ctx)
	if err == nil {
		managedSets = sets
		userCounts := projectedUserCountsBySet(sets)
		sort.Slice(sets, func(i, j int) bool { return sets[i].ID < sets[j].ID })
		b.WriteString("# HELP llmgateway_set_ready Whether a Set is active, bootstrapped, and ready for traffic.\n")
		b.WriteString("# TYPE llmgateway_set_ready gauge\n")
		b.WriteString("# HELP llmgateway_set_admin_health Current authenticated database health state for each Set.\n")
		b.WriteString("# TYPE llmgateway_set_admin_health gauge\n")
		for _, set := range sets {
			ready := 0
			if setReadyForServing(set) {
				ready = 1
			}
			fmt.Fprintf(&b, "llmgateway_set_ready{set_id=\"%s\",status=\"%s\",admission=\"%s\"} %d\n", prometheusLabelValue(set.ID), prometheusLabelValue(set.Status), prometheusLabelValue(firstNonEmpty(set.AdmissionStatus, SetAdmissionStatusPending)), ready)
			fmt.Fprintf(&b, "llmgateway_set_admin_health{set_id=\"%s\",status=\"%s\"} 1\n", prometheusLabelValue(set.ID), prometheusLabelValue(firstNonEmpty(set.AdminHealthStatus, "unknown")))
		}
		b.WriteString("# HELP llmgateway_set_runtime_ha_ready Whether the declared Set traffic HA policy is currently satisfied.\n")
		b.WriteString("# TYPE llmgateway_set_runtime_ha_ready gauge\n")
		b.WriteString("# HELP llmgateway_set_runtime_ha_desired_replicas Declared minimum traffic replicas for each Set.\n")
		b.WriteString("# TYPE llmgateway_set_runtime_ha_desired_replicas gauge\n")
		b.WriteString("# HELP llmgateway_set_runtime_ha_ready_replicas Ready traffic replicas observed through LLMFleet status.\n")
		b.WriteString("# TYPE llmgateway_set_runtime_ha_ready_replicas gauge\n")
		b.WriteString("# HELP llmgateway_set_runtime_ha_pdb_ready Whether the Set traffic PodDisruptionBudget currently permits one disruption.\n")
		b.WriteString("# TYPE llmgateway_set_runtime_ha_pdb_ready gauge\n")
		for _, set := range sets {
			if set.RuntimeHADesiredReplicas <= 0 {
				continue
			}
			haReady := 0
			if set.RuntimeHAStatus == SetRuntimeHAHealthy {
				haReady = 1
			}
			pdbReady := 0
			if set.RuntimeHAPDBHealthy {
				pdbReady = 1
			}
			setID := prometheusLabelValue(set.ID)
			fmt.Fprintf(&b, "llmgateway_set_runtime_ha_ready{set_id=\"%s\",status=\"%s\"} %d\n", setID, prometheusLabelValue(firstNonEmpty(set.RuntimeHAStatus, SetRuntimeHAPending)), haReady)
			fmt.Fprintf(&b, "llmgateway_set_runtime_ha_desired_replicas{set_id=\"%s\"} %d\n", setID, set.RuntimeHADesiredReplicas)
			fmt.Fprintf(&b, "llmgateway_set_runtime_ha_ready_replicas{set_id=\"%s\"} %d\n", setID, set.RuntimeHAReadyReplicas)
			fmt.Fprintf(&b, "llmgateway_set_runtime_ha_pdb_ready{set_id=\"%s\"} %d\n", setID, pdbReady)
		}
		b.WriteString("# HELP llmgateway_set_users Number of llmgateway users assigned to each Set.\n")
		b.WriteString("# TYPE llmgateway_set_users gauge\n")
		b.WriteString("# HELP llmgateway_set_max_users Configured user capacity for each Set; 0 means unlimited.\n")
		b.WriteString("# TYPE llmgateway_set_max_users gauge\n")
		b.WriteString("# HELP llmgateway_set_free_users Remaining assignable user slots after reserved capacity.\n")
		b.WriteString("# TYPE llmgateway_set_free_users gauge\n")
		b.WriteString("# HELP llmgateway_set_accepting_new_users Whether a Set currently accepts new user assignment.\n")
		b.WriteString("# TYPE llmgateway_set_accepting_new_users gauge\n")
		for _, set := range sets {
			count := userCounts[set.ID]
			capacity := setCapacitySnapshot(set, count, 0)
			accepting := 0
			if setReadyForCapacity(set) && capacity.AcceptingNewUsers {
				accepting = 1
			}
			fmt.Fprintf(&b, "llmgateway_set_users{set_id=\"%s\"} %d\n", prometheusLabelValue(set.ID), count)
			fmt.Fprintf(&b, "llmgateway_set_max_users{set_id=\"%s\"} %d\n", prometheusLabelValue(set.ID), capacity.MaxUsers)
			fmt.Fprintf(&b, "llmgateway_set_free_users{set_id=\"%s\"} %d\n", prometheusLabelValue(set.ID), capacity.FreeUsers)
			fmt.Fprintf(&b, "llmgateway_set_accepting_new_users{set_id=\"%s\",status=\"%s\"} %d\n", prometheusLabelValue(set.ID), prometheusLabelValue(capacity.Status), accepting)
		}
		b.WriteString("# HELP llmgateway_set_runtime_generation Active traffic runtime generation for each Set.\n")
		b.WriteString("# TYPE llmgateway_set_runtime_generation gauge\n")
		b.WriteString("# HELP llmgateway_set_route_revision Monotonic Redis route revision for each Set.\n")
		b.WriteString("# TYPE llmgateway_set_route_revision gauge\n")
		for _, set := range sets {
			fmt.Fprintf(&b, "llmgateway_set_runtime_generation{set_id=\"%s\"} %d\n", prometheusLabelValue(set.ID), set.ActiveRuntimeGeneration)
			fmt.Fprintf(&b, "llmgateway_set_route_revision{set_id=\"%s\"} %d\n", prometheusLabelValue(set.ID), set.RouteRevision)
		}
	}

	upgradeRuns, err := s.store.ListSetUpgradeRuns(ctx, "", nil, 0)
	if err == nil {
		now := s.nowUTC()
		b.WriteString("# HELP llmgateway_set_upgrade_state Upgrade state per Set; value is always 1 for the current run state.\n")
		b.WriteString("# TYPE llmgateway_set_upgrade_state gauge\n")
		b.WriteString("# HELP llmgateway_set_upgrade_stage_age_seconds Time elapsed since the run state was last updated.\n")
		b.WriteString("# TYPE llmgateway_set_upgrade_stage_age_seconds gauge\n")
		b.WriteString("# HELP llmgateway_set_upgrade_probe_failures Consecutive controlled probe failures.\n")
		b.WriteString("# TYPE llmgateway_set_upgrade_probe_failures gauge\n")
		b.WriteString("# HELP llmgateway_set_upgrade_auto_rollback_total Upgrade runs automatically rolled back after probe failures.\n")
		b.WriteString("# TYPE llmgateway_set_upgrade_auto_rollback_total counter\n")
		for _, run := range upgradeRuns {
			labels := fmt.Sprintf("set_id=\"%s\",run_id=\"%s\",status=\"%s\"", prometheusLabelValue(run.SetID), prometheusLabelValue(run.ID), prometheusLabelValue(run.Status))
			stageAge := now.Sub(run.UpdatedAt)
			if stageAge < 0 {
				stageAge = 0
			}
			fmt.Fprintf(&b, "llmgateway_set_upgrade_state{%s} 1\n", labels)
			fmt.Fprintf(&b, "llmgateway_set_upgrade_stage_age_seconds{%s} %.0f\n", labels, stageAge.Seconds())
			fmt.Fprintf(&b, "llmgateway_set_upgrade_probe_failures{set_id=\"%s\",run_id=\"%s\"} %d\n", prometheusLabelValue(run.SetID), prometheusLabelValue(run.ID), run.ConsecutiveProbeFailures)
			if run.Status == SetUpgradeRunStatusRolledBack && !run.RollbackRequested {
				fmt.Fprintf(&b, "llmgateway_set_upgrade_auto_rollback_total{set_id=\"%s\"} 1\n", prometheusLabelValue(run.SetID))
			}
		}
	}
	campaigns, err := s.store.ListReleaseCampaigns(ctx, 100)
	if err == nil {
		sort.Slice(campaigns, func(i, j int) bool { return campaigns[i].ID < campaigns[j].ID })
		b.WriteString("# HELP llmgateway_release_campaign_state Fleet release campaign state; value is always 1 for the current state.\n")
		b.WriteString("# TYPE llmgateway_release_campaign_state gauge\n")
		b.WriteString("# HELP llmgateway_release_campaign_ring_state Release ring step state inside a Fleet campaign.\n")
		b.WriteString("# TYPE llmgateway_release_campaign_ring_state gauge\n")
		for _, campaign := range campaigns {
			fmt.Fprintf(&b, "llmgateway_release_campaign_state{campaign_id=\"%s\",fleet=\"%s\",target_release_id=\"%s\",status=\"%s\"} 1\n",
				prometheusLabelValue(campaign.ID), prometheusLabelValue(campaign.Fleet), prometheusLabelValue(campaign.TargetReleaseID), prometheusLabelValue(campaign.Status))
			for _, ring := range campaign.Rings {
				fmt.Fprintf(&b, "llmgateway_release_campaign_ring_state{campaign_id=\"%s\",ring_id=\"%s\",status=\"%s\"} 1\n",
					prometheusLabelValue(campaign.ID), prometheusLabelValue(ring.RingID), prometheusLabelValue(ring.Status))
			}
		}
	}
	outbox, err := s.store.ListSetRuntimeRouteOutbox(ctx, SetRuntimeRouteOutboxStatusPending, 0)
	if err == nil {
		b.WriteString("# HELP llmgateway_set_runtime_route_outbox_pending Pending durable runtime route publications.\n")
		b.WriteString("# TYPE llmgateway_set_runtime_route_outbox_pending gauge\n")
		b.WriteString("# HELP llmgateway_set_runtime_route_publish_failures Route publication attempts that have failed.\n")
		b.WriteString("# TYPE llmgateway_set_runtime_route_publish_failures counter\n")
		fmt.Fprintf(&b, "llmgateway_set_runtime_route_outbox_pending %d\n", len(outbox))
		for _, item := range outbox {
			fmt.Fprintf(&b, "llmgateway_set_runtime_route_publish_failures{set_id=\"%s\"} %d\n", prometheusLabelValue(item.SetID), item.Attempts)
		}
	}
	shards, err := s.store.ListShards(ctx)
	if err == nil {
		allocated := map[string]int{}
		for _, set := range managedSets {
			allocated[set.ShardID]++
		}
		b.WriteString("# HELP llmgateway_shard_sets Managed Set count per Shard.\n")
		b.WriteString("# TYPE llmgateway_shard_sets gauge\n")
		b.WriteString("# HELP llmgateway_shard_max_sets Configured Set capacity per Shard; 0 means compatibility mode.\n")
		b.WriteString("# TYPE llmgateway_shard_max_sets gauge\n")
		for _, shard := range shards {
			fmt.Fprintf(&b, "llmgateway_shard_sets{shard_id=\"%s\"} %d\n", prometheusLabelValue(shard.ID), allocated[shard.ID])
			fmt.Fprintf(&b, "llmgateway_shard_max_sets{shard_id=\"%s\"} %d\n", prometheusLabelValue(shard.ID), shard.MaxSets)
		}
	}

	bundles, err := s.store.ListChannelBundles(ctx)
	if err == nil {
		sort.Slice(bundles, func(i, j int) bool { return bundles[i].ID < bundles[j].ID })
		b.WriteString("# HELP llmgateway_channel_bundle_sync_state Channel bundle sync state per Set; value is always 1 for the current state.\n")
		b.WriteString("# TYPE llmgateway_channel_bundle_sync_state gauge\n")
		for _, bundle := range bundles {
			states, err := s.store.ListChannelBundleSyncStates(ctx, bundle.ID)
			if err != nil {
				continue
			}
			sort.Slice(states, func(i, j int) bool {
				if states[i].SetID != states[j].SetID {
					return states[i].SetID < states[j].SetID
				}
				return states[i].Status < states[j].Status
			})
			for _, state := range states {
				fmt.Fprintf(&b, "llmgateway_channel_bundle_sync_state{bundle_id=\"%s\",set_id=\"%s\",status=\"%s\"} 1\n",
					prometheusLabelValue(bundle.ID), prometheusLabelValue(state.SetID), prometheusLabelValue(state.Status))
			}
		}
	}

	groupRatioStates, err := s.store.ListGroupRatioApplyStates(ctx, GroupRatioApplyStateListOptions{})
	if err == nil {
		activeSetIDs := make(map[string]bool, len(managedSets))
		for _, set := range managedSets {
			if set.Status == SetStatusActive && set.Setup && set.AdminUserID > 0 && set.AdminAccessToken != "" {
				activeSetIDs[set.ID] = true
			}
		}
		sort.Slice(groupRatioStates, func(i, j int) bool { return groupRatioStates[i].SetID < groupRatioStates[j].SetID })
		b.WriteString("# HELP llmgateway_group_ratio_apply_state GroupRatio reconciliation state per Set; value is always 1 for the current state.\n")
		b.WriteString("# TYPE llmgateway_group_ratio_apply_state gauge\n")
		b.WriteString("# HELP llmgateway_group_ratio_desired_version Latest local GroupRatio desired version per Set.\n")
		b.WriteString("# TYPE llmgateway_group_ratio_desired_version gauge\n")
		b.WriteString("# HELP llmgateway_group_ratio_applied_version Last GroupRatio version successfully written to new-api per Set.\n")
		b.WriteString("# TYPE llmgateway_group_ratio_applied_version gauge\n")
		b.WriteString("# HELP llmgateway_group_ratio_version_lag Difference between desired and applied GroupRatio versions per Set.\n")
		b.WriteString("# TYPE llmgateway_group_ratio_version_lag gauge\n")
		for _, state := range groupRatioStates {
			if !activeSetIDs[state.SetID] {
				continue
			}
			lag := state.DesiredVersion - state.AppliedVersion
			if lag < 0 {
				lag = 0
			}
			setID := prometheusLabelValue(state.SetID)
			fmt.Fprintf(&b, "llmgateway_group_ratio_apply_state{set_id=\"%s\",status=\"%s\"} 1\n", setID, prometheusLabelValue(state.Status))
			fmt.Fprintf(&b, "llmgateway_group_ratio_desired_version{set_id=\"%s\"} %d\n", setID, state.DesiredVersion)
			fmt.Fprintf(&b, "llmgateway_group_ratio_applied_version{set_id=\"%s\"} %d\n", setID, state.AppliedVersion)
			fmt.Fprintf(&b, "llmgateway_group_ratio_version_lag{set_id=\"%s\"} %d\n", setID, lag)
		}
	}

	statistics, statisticsReady, err := s.store.GetTenantStatistics(ctx)
	if err == nil {
		ready := 0
		generatedAt := float64(0)
		if statisticsReady && !statistics.GeneratedAt.IsZero() {
			ready = 1
			generatedAt = float64(statistics.GeneratedAt.Unix())
		}
		b.WriteString("# HELP llmgateway_tenant_statistics_ready Whether a successful tenant statistics snapshot exists.\n")
		b.WriteString("# TYPE llmgateway_tenant_statistics_ready gauge\n")
		fmt.Fprintf(&b, "llmgateway_tenant_statistics_ready %d\n", ready)
		b.WriteString("# HELP llmgateway_tenant_statistics_generated_timestamp_seconds Generation time of the latest successful tenant statistics snapshot.\n")
		b.WriteString("# TYPE llmgateway_tenant_statistics_generated_timestamp_seconds gauge\n")
		fmt.Fprintf(&b, "llmgateway_tenant_statistics_generated_timestamp_seconds %.0f\n", generatedAt)
	}

	jobs, err := s.store.ListWorkerJobs(ctx, WorkerJobListOptions{})
	if err == nil {
		jobs = visibleWorkerJobs(jobs)
		sort.Slice(jobs, func(i, j int) bool { return jobs[i].Name < jobs[j].Name })
		now := s.nowUTC()
		b.WriteString("# HELP llmgateway_worker_job_last_success_timestamp_seconds Last successful worker job finish time.\n")
		b.WriteString("# TYPE llmgateway_worker_job_last_success_timestamp_seconds gauge\n")
		b.WriteString("# HELP llmgateway_worker_job_failure_total Worker job failure count from local state.\n")
		b.WriteString("# TYPE llmgateway_worker_job_failure_total counter\n")
		b.WriteString("# HELP llmgateway_worker_job_lease_age_seconds Age of an active worker job lease.\n")
		b.WriteString("# TYPE llmgateway_worker_job_lease_age_seconds gauge\n")
		for _, job := range jobs {
			lastSuccess := float64(0)
			if !job.LastSuccessAt.IsZero() {
				lastSuccess = float64(job.LastSuccessAt.Unix())
			}
			leaseAge := float64(0)
			if !job.LeaseUntil.IsZero() && job.LeaseUntil.After(now) && !job.LastStartedAt.IsZero() {
				leaseAge = now.Sub(job.LastStartedAt).Seconds()
			}
			fmt.Fprintf(&b, "llmgateway_worker_job_last_success_timestamp_seconds{job=\"%s\"} %.0f\n", prometheusLabelValue(job.Name), lastSuccess)
			fmt.Fprintf(&b, "llmgateway_worker_job_failure_total{job=\"%s\"} %d\n", prometheusLabelValue(job.Name), job.FailureCount)
			fmt.Fprintf(&b, "llmgateway_worker_job_lease_age_seconds{job=\"%s\",owner=\"%s\"} %.0f\n", prometheusLabelValue(job.Name), prometheusLabelValue(job.LeaseOwner), leaseAge)
		}
	}

	byokStats, err := s.store.GetBYOKSyncTaskStats(ctx, s.nowUTC())
	if err == nil {
		b.WriteString("# HELP llmgateway_byok_sync_tasks BYOK sync tasks by status.\n")
		b.WriteString("# TYPE llmgateway_byok_sync_tasks gauge\n")
		fmt.Fprintf(&b, "llmgateway_byok_sync_tasks{status=\"pending\"} %d\n", byokStats.Pending)
		fmt.Fprintf(&b, "llmgateway_byok_sync_tasks{status=\"running\"} %d\n", byokStats.Running)
		fmt.Fprintf(&b, "llmgateway_byok_sync_tasks{status=\"error\"} %d\n", byokStats.Error)
		fmt.Fprintf(&b, "llmgateway_byok_sync_tasks{status=\"succeeded\"} %d\n", byokStats.Succeeded)
		b.WriteString("# HELP llmgateway_byok_sync_oldest_pending_age_seconds Age of the oldest pending BYOK sync task.\n")
		b.WriteString("# TYPE llmgateway_byok_sync_oldest_pending_age_seconds gauge\n")
		fmt.Fprintf(&b, "llmgateway_byok_sync_oldest_pending_age_seconds %d\n", byokStats.OldestPendingAgeSeconds)
		b.WriteString("# HELP llmgateway_byok_sync_expired_running_leases Expired running BYOK sync task leases.\n")
		b.WriteString("# TYPE llmgateway_byok_sync_expired_running_leases gauge\n")
		fmt.Fprintf(&b, "llmgateway_byok_sync_expired_running_leases %d\n", byokStats.ExpiredRunningLeases)
		b.WriteString("# HELP llmgateway_byok_sync_failure Users with failed BYOK sync tasks.\n")
		b.WriteString("# TYPE llmgateway_byok_sync_failure gauge\n")
		fmt.Fprintf(&b, "llmgateway_byok_sync_failure %d\n", byokStats.Error)
		b.WriteString("# HELP llmgateway_byok_sync_last_success_timestamp_seconds Last successful BYOK user task completion time.\n")
		b.WriteString("# TYPE llmgateway_byok_sync_last_success_timestamp_seconds gauge\n")
		fmt.Fprintf(&b, "llmgateway_byok_sync_last_success_timestamp_seconds %.0f\n", prometheusTimestamp(byokStats.LastSuccessAt))
		b.WriteString("# HELP llmgateway_byok_sync_last_failure_timestamp_seconds Last failed BYOK user task completion time.\n")
		b.WriteString("# TYPE llmgateway_byok_sync_last_failure_timestamp_seconds gauge\n")
		fmt.Fprintf(&b, "llmgateway_byok_sync_last_failure_timestamp_seconds %.0f\n", prometheusTimestamp(byokStats.LastFailureAt))
	}

	observationStats, err := s.store.GetTenantObservationTaskStats(ctx, s.nowUTC())
	if err == nil {
		b.WriteString("# HELP llmgateway_tenant_observation_tasks Tenant observation tasks by status.\n")
		b.WriteString("# TYPE llmgateway_tenant_observation_tasks gauge\n")
		fmt.Fprintf(&b, "llmgateway_tenant_observation_tasks{status=\"pending\"} %d\n", observationStats.Pending)
		fmt.Fprintf(&b, "llmgateway_tenant_observation_tasks{status=\"running\"} %d\n", observationStats.Running)
		fmt.Fprintf(&b, "llmgateway_tenant_observation_tasks{status=\"error\"} %d\n", observationStats.Error)
		fmt.Fprintf(&b, "llmgateway_tenant_observation_tasks{status=\"blocked\"} %d\n", observationStats.Blocked)
		b.WriteString("# HELP llmgateway_tenant_observation_due_tasks Observation tasks currently due for execution.\n")
		b.WriteString("# TYPE llmgateway_tenant_observation_due_tasks gauge\n")
		fmt.Fprintf(&b, "llmgateway_tenant_observation_due_tasks %d\n", observationStats.Due)
		b.WriteString("# HELP llmgateway_tenant_observation_oldest_due_age_seconds Age of the oldest due observation task.\n")
		b.WriteString("# TYPE llmgateway_tenant_observation_oldest_due_age_seconds gauge\n")
		fmt.Fprintf(&b, "llmgateway_tenant_observation_oldest_due_age_seconds %d\n", observationStats.OldestDueAgeSeconds)
		b.WriteString("# HELP llmgateway_tenant_observation_expired_running_leases Expired running observation task leases.\n")
		b.WriteString("# TYPE llmgateway_tenant_observation_expired_running_leases gauge\n")
		fmt.Fprintf(&b, "llmgateway_tenant_observation_expired_running_leases %d\n", observationStats.ExpiredRunningLeases)
		b.WriteString("# HELP llmgateway_tenant_observation_last_success_timestamp_seconds Last successful tenant observation task completion time.\n")
		b.WriteString("# TYPE llmgateway_tenant_observation_last_success_timestamp_seconds gauge\n")
		fmt.Fprintf(&b, "llmgateway_tenant_observation_last_success_timestamp_seconds %.0f\n", prometheusTimestamp(observationStats.LastSuccessAt))
		b.WriteString("# HELP llmgateway_tenant_observation_last_failure_timestamp_seconds Last failed tenant observation task completion time.\n")
		b.WriteString("# TYPE llmgateway_tenant_observation_last_failure_timestamp_seconds gauge\n")
		fmt.Fprintf(&b, "llmgateway_tenant_observation_last_failure_timestamp_seconds %.0f\n", prometheusTimestamp(observationStats.LastFailureAt))
	}

	return b.String()
}

func prometheusTimestamp(value time.Time) float64 {
	if value.IsZero() {
		return 0
	}
	return float64(value.Unix())
}
