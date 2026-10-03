#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
local_deploy_dir="$script_dir/../../local"
"$script_dir/../../local/argocd/verify-static.sh"
"$script_dir/gitops/cell-registration/verify-static.sh"

for executable in \
	"$script_dir/tat/tat-invoke.sh" \
	"$script_dir/loadgen/run.sh" \
	"$script_dir/loadgen/build-image.sh" \
	"$script_dir/load/stateless-durable-routing/run.py" \
	"$script_dir/load/command-ack-disconnect/qualify.py" \
	"$script_dir/load/command-ack-disconnect/run-on-builder.sh" \
	"$script_dir/load/workers-api-business-drain/qualify.py" \
	"$script_dir/load/workers-api-business-drain/run-on-builder.sh" \
	"$script_dir/load/workers-api-business-drain/test_qualify.py" \
	"$script_dir/load/deployment-cursor/qualify.py" \
	"$script_dir/load/fdb-network-outage/qualify.py" \
	"$script_dir/load/fdb-network-outage/test_qualify.py" \
	"$script_dir/load/router-performance/capture.py" \
	"$script_dir/load/router-performance/run-on-builder.sh" \
	"$script_dir/load/shared-agent-scale/cleanup.py" \
	"$script_dir/load/ten-thousand-active/run-on-builder.sh" \
	"$script_dir/workers-api/build-image.sh" \
	"$script_dir/workers-api/gitops/verify-registry-contract.py" \
	"$script_dir/workers-api/install-private-endpoint.sh" \
	"$script_dir/workers-api/install-private-object-router-endpoint.sh" \
	"$script_dir/workers-api/qualify-private-endpoint.sh" \
	"$script_dir/workers-api/qualify-private-endpoint-ha.py" \
	"$script_dir/workers-api/test_private_endpoint_contract.py" \
	"$script_dir/workers-api/test_private_endpoint_qualification_contract.py" \
	"$script_dir/workers-api/test_private_endpoint_ha_contract.py" \
	"$script_dir/workers-api/test_object_router_endpoint_contract.py" \
	"$script_dir/worker-registry/build-image.sh" \
	"$script_dir/worker-registry/build-image-via-tat.sh" \
	"$script_dir/worker-registry/install-private-endpoint.sh" \
	"$script_dir/code-plane/render-desired-state.py" \
	"$script_dir/code-plane/install.sh" \
	"$script_dir/code-plane/gitops/render-desired-state.py" \
	"$script_dir/code-plane/gitops/render-image-update.py" \
	"$script_dir/code-plane/gitops/publish-desired-state.py" \
	"$script_dir/code-plane/gitops/publish.sh" \
	"$script_dir/code-plane/gitops/render-application.py" \
	"$script_dir/code-plane/gitops/install-application.sh" \
	"$script_dir/gitops/build-image.sh" \
	"$script_dir/gitops/mirror-images.sh" \
	"$script_dir/gitops/image-seed/seed-tcr.sh" \
	"$script_dir/gitops/image-seed/image-lock.py" \
	"$script_dir/gitops/image-seed/product-lock.py" \
	"$script_dir/gitops/image-seed/record-product-image.py" \
	"$script_dir/gitops/image-seed/foundation-plan.py" \
	"$script_dir/gitops/image-seed/build-foundations.sh" \
	"$script_dir/gitops/image-seed/assemble-generation.sh" \
	"$script_dir/gitops/image-seed/verify.sh" \
	"$script_dir/gitops/install-qualification-git.sh" \
	"$script_dir/gitops/publish-desired-state.sh" \
	"$script_dir/gitops/publish-control-desired-state.sh" \
	"$script_dir/gitops/render_control_plane.py" \
	"$script_dir/gitops/test_render_control_plane.py" \
	"$script_dir/gitops/render_argocd_ha_install.py" \
	"$script_dir/gitops/test_render_argocd_ha_install.py" \
	"$script_dir/gitops/assemble-admission-receipt.py" \
	"$script_dir/gitops/qualify-first-placement.py" \
	"$script_dir/gitops/test_complete_cell_admission.py" \
	"$script_dir/gitops/complete-cell-qualification.sh" \
	"$script_dir/gitops/complete-cell-admission.sh" \
	"$script_dir/gitops/cell-registration/publish-desired-state.py" \
	"$script_dir/gitops/cell-registration/verify-publication.py" \
	"$script_dir/operations/preflight-image-pull.sh" \
	"$script_dir/operations/cache-qualification-receipt.sh" \
	"$script_dir/operations/hydrate-qualification-receipts.sh" \
	"$script_dir/operations/test-qualification-receipt-cache.sh" \
	"$script_dir/operations/test-autonomy-operation-lock.sh" \
	"$script_dir/operations/plan-qualification-activation.py" \
	"$script_dir/operations/publish-qualified-release.sh" \
	"$script_dir/operations/verify-physical-restore-receipt.py" \
	"$script_dir/qualification/build-runtime-release-qualification.py" \
	"$script_dir/qualification/test_build_runtime_release_qualification.py" \
	"$script_dir/qualification/actor-bj-q01/build-controller-dependency-base-via-tat.sh" \
	"$script_dir/observability/federation/install-hub.sh" \
	"$script_dir/observability/federation/install-spoke-endpoint.sh" \
	"$script_dir/observability/federation/test_hub_install_contract.py" \
	"$script_dir/observability/federation/gitops/render-desired-state.py" \
	"$script_dir/observability/federation/gitops/render-application.py" \
	"$script_dir/observability/federation/gitops/publish-desired-state.py" \
	"$script_dir/observability/federation/gitops/publish.sh" \
	"$script_dir/observability/federation/gitops/install-application.sh" \
	"$script_dir/observability/federation/gitops/test_gitops.py" \
	"$script_dir/observability/federation/verify-hub.sh" \
	"$script_dir/terraform/create-first/rebuild/run-management-observability.sh" \
	"$script_dir/terraform/create-first/rebuild/assemble-fleet-qualification.py" \
	"$script_dir/terraform/create-first/rebuild/test_assemble_fleet_qualification.py" \
	"$script_dir/runtime/bundle-full-reviewed-source.sh" \
	"$script_dir/runtime/verify-full-source-bundle.py" \
	"$script_dir/runtime/preserve-noop-template-identity.py" \
	"$script_dir/runtime/coordinate-noop-release-identity.py" \
	"$script_dir/runtime/bind-worker-registry.sh" \
	"$script_dir/runtime/qualify-registry-binding.py" \
	"$script_dir/runtime/prepare-stage.sh" \
	"$script_dir/runtime/install-toolchains.sh" \
	"$script_dir/runtime/install-stateless-admission-controller.sh" \
	"$script_dir/runtime/ensure-stateless-auth.sh" \
	"$script_dir/runtime/install-stateless-executor.sh" \
	"$script_dir/runtime/install-private-stateless-endpoint.sh" \
	"$script_dir/workers-api/sync-credentials.sh" \
	"$script_dir/workers-api/gitops/recertify-live-convergence.sh" \
	"$script_dir/runtime/gitops/render-desired-state.py" \
	"$script_dir/runtime/gitops/publish-desired-state.py" \
	"$script_dir/runtime/gitops/render-application.py" \
	"$script_dir/runtime/gitops/install-application.sh" \
	"$script_dir/runtime/test_stateless_executor_contract.py" \
	"$script_dir/runtime/test_storage_identity.py" \
	"$script_dir/fdb-operator/bootstrap-cell-tls.sh" \
	"$script_dir/fdb-operator/bootstrap-cell-continuous-backup.sh" \
	"$script_dir/fdb-operator/render-cell-continuous-backup.py" \
	"$script_dir/fdb-operator/test_render_cell_continuous_backup.py" \
	"$script_dir/fdb-operator/test_bootstrap_cell_tls.py" \
	"$script_dir/fdb-operator/render-install.py" \
	"$script_dir/fdb-operator/test_render_install.py" \
	"$script_dir/terraform/create-first/bootstrap/install-pull-credential.sh" \
	"$script_dir/terraform/create-first/bootstrap/install-storage-credentials.sh" \
	"$script_dir/terraform/create-first/bootstrap/install-cell-platform.sh" \
	"$script_dir/terraform/create-first/bootstrap/validate-inputs.py" \
	"$script_dir/terraform/create-first/bootstrap/validate-runtime-builder-storage.py" \
	"$script_dir/terraform/create-first/bootstrap/collect-runtime-builder-storage.py" \
	"$script_dir/terraform/create-first/bootstrap/initialize-runtime-builder-storage.py" \
	"$script_dir/terraform/create-first/bootstrap/collect-runtime-builder-guest.py" \
	"$script_dir/terraform/create-first/bootstrap/validate-storage-inputs.py" \
	"$script_dir/terraform/create-first/bootstrap/validate-cell-platform-inputs.py" \
	"$script_dir/terraform/create-first/bootstrap/render-regional-profile.py" \
	"$script_dir/terraform/create-first/bootstrap/render-cell-controller.py" \
	"$script_dir/qualification/run-initial-cell-qualification.sh" \
	"$script_dir/qualification/test-run-initial-cell-qualification.sh" \
	"$script_dir/qualification/build-cell-class-qualification.py" \
	"$script_dir/qualification/actor-bj-q01/promote-reviewed-source.sh" \
	"$script_dir/qualification/actor-bj-q01/materialize-reviewed-source.sh" \
	"$script_dir/qualification/actor-bj-q01/materialize-full-reviewed-source.sh" \
	"$script_dir/runtime/materialize-runtime-baseline-source.sh" \
	"$script_dir/runtime/prepare-cargo-cache.sh" \
	"$script_dir/runtime/reuse-stage-from-runtime.sh" \
	"$script_dir/qualification/actor-bj-q01/promote-fdb-automatic.sh" \
	"$script_dir/qualification/actor-bj-q01/promote-fdb-automatic-via-tat.sh" \
	"$script_dir/qualification/actor-bj-q01/build-controller-via-tat.sh" \
	"$script_dir/qualification/actor-bj-q01/build-release-hook-via-tat.sh" \
	"$script_dir/qualification/actor-bj-q01/build-semantic-failure-candidate-via-tat.sh" \
	"$script_dir/qualification/actor-bj-q01/relay-download-from-builder.sh" \
	"$script_dir/qualification/actor-bj-q01/install-coscli-via-relay.sh" \
	"$script_dir/qualification/actor-bj-q01/persist-receipt-from-builder.sh" \
	"$script_dir/qualification/actor-bj-q01/user-transparent-upgrade.py" \
	"$script_dir/qualification/actor-bj-q01/user-transparent-rollback.py" \
	"$script_dir/qualification/actor-bj-q01/run-user-transparent-upgrade-via-tat.sh" \
	"$script_dir/qualification/actor-bj-q01/run-user-transparent-upgrade-on-builder.sh" \
	"$script_dir/qualification/actor-bj-q01/bootstrap-release-observer-on-builder.sh" \
	"$script_dir/qualification/actor-bj-q01/reset-qualification-application-state-on-builder.sh" \
	"$script_dir/qualification/actor-bj-q01/publish-release-commands.sh" \
	"$script_dir/qualification/actor-bj-q01/test-publish-release-commands.sh" \
	"$script_dir/qualification/actor-bj-q01/run-fdb-autoscaling-qualification.sh" \
	"$script_dir/qualification/actor-bj-q01/run-fdb-autoscaling-via-tat.sh" \
	"$script_dir/qualification/actor-bj-q01/run-engine-ha.sh" \
	"$script_dir/qualification/actor-bj-q01/qualify-runtime-machine-repair.sh" \
	"$script_dir/qualification/actor-bj-q01/qualify-runtime-automatic-replacement.sh" \
	"$script_dir/qualification/actor-bj-q01/repair-runtime-topology.sh" \
	"$script_dir/qualification/actor-bj-q01/runtime_topology_repair.py" \
	"$script_dir/qualification/actor-bj-q01/configure-runtime-machine-repair.sh" \
	"$script_dir/qualification/actor-bj-q01/verify-runtime-machine-repair-receipt.py" \
	"$script_dir/qualification/actor-bj-q01/verify-runtime-automatic-repair-receipt.py" \
	"$script_dir/qualification/actor-bj-q01/verify-runtime-topology-repair-receipt.py"; do
	[[ -x $executable ]] || { echo "required operation entry point is not executable: $executable" >&2; exit 1; }
done

for executable in \
	"$local_deploy_dir/mesh/workers-api-autoscaling-e2e/run.py" \
	"$local_deploy_dir/mesh/workers-api-ha-e2e/run.py"; do
	[[ -x $executable ]] || { echo "required local qualification entry point is not executable: $executable" >&2; exit 1; }
done

PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/gitops/test_render_argocd_ha_install.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/gitops/test_qualification_git.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/gitops/test_render_control_plane.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/gitops/test_assemble_admission_receipt.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/gitops/test_qualify_first_placement.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/gitops/test_complete_cell_admission.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$local_deploy_dir/mesh/workers-api-autoscaling-e2e/test_run.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$local_deploy_dir/mesh/workers-api-ha-e2e/test_run.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/load/fdb-network-outage/test_qualify.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/load/command-ack-disconnect/test_qualify.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/load/workers-api-business-drain/test_qualify.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/load/agent-upload-soak/test_observe.py"
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s "$script_dir/load/router-performance" -p 'test_*.py'
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/load/shared-agent-scale/test_cleanup.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/load/ten-thousand-active/test_verify.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/load/ten-thousand-active/test_release_admission.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/load/ten-thousand-active/test_analyze_pressure.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/runtime/test_capacity_controller_recovery.py"
node --test "$script_dir/load/shared-agent-scale/runner.test.mjs" "$script_dir/load/shared-agent-scale/heartbeat-demand.test.mjs"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/workers-api/test_private_endpoint_contract.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/workers-api/test_private_endpoint_qualification_contract.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/workers-api/test_private_endpoint_ha_contract.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/workers-api/test_object_router_endpoint_contract.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/workers-api/test_verify_runner.py"
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s "$script_dir/code-plane" -p 'test_*.py'
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s "$script_dir/code-plane/gitops" -p 'test_*.py'
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/observability/federation/test_federation.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/observability/federation/test_hub_install_contract.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/observability/test_verify_scrape_convergence.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/runtime/test_prepare_stage.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/runtime/test_stage_reuse_inputs.py" StageReuseContractTest
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/runtime/test_warm_stage_cache.py" WarmStageContractTest
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/runtime/test_install_toolchains.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/runtime/test_stateless_executor_contract.py"
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s "$script_dir/runtime/gitops" -p 'test_*.py'
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/runtime/test_full_source_bundle.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/runtime/test_storage_identity.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/runtime/test_qualify_registry_binding.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/fdb-operator/test_bootstrap_cell_tls.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/fdb-operator/test_render_cell_continuous_backup.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/fdb-operator/test_render_install.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/terraform/create-first/bootstrap/test_validate_inputs.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/terraform/create-first/bootstrap/test_validate_runtime_builder_storage.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/terraform/create-first/bootstrap/test_collect_runtime_builder_storage.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/terraform/create-first/bootstrap/test_initialize_runtime_builder_storage.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/terraform/create-first/test-terraform-storage-contract.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/terraform/create-first/bootstrap/test_install_pull_credential.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/terraform/create-first/bootstrap/test_install_pull_credential_e2e.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/terraform/create-first/bootstrap/test_render_regional_profile.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/terraform/create-first/bootstrap/test_validate_storage_inputs.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/terraform/create-first/bootstrap/test_install_storage_credentials.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/terraform/create-first/bootstrap/test_validate_cell_platform_inputs.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/terraform/create-first/bootstrap/test_render_cell_controller.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/terraform/create-first/bootstrap/test_install_cell_platform.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/terraform/create-first/rebuild/test_assemble_fleet_qualification.py"
"$script_dir/gitops/image-seed/verify.sh"

bash -n "$script_dir/bootstrap-fdb-node.sh" "$script_dir/test-bootstrap-fdb-node.sh" \
	"$script_dir/tat/tat-invoke.sh" \
	"$script_dir/../install-beijing-workerd-cell.sh" "$script_dir/../init-workerd-pool.sh" \
	"$script_dir/runtime/install.sh" "$script_dir/runtime/install-admission-controller.sh" \
	"$script_dir/runtime/qualify-runtime.sh" \
	"$script_dir/runtime/build-image.sh" "$script_dir/runtime/bundle-source-delta.sh" \
	"$script_dir/runtime/prepare-stage.sh" \
	"$script_dir/runtime/install-toolchains.sh" \
	"$script_dir/runtime/install-stateless-admission-controller.sh" \
	"$script_dir/runtime/ensure-stateless-auth.sh" \
	"$script_dir/runtime/install-stateless-executor.sh" \
	"$script_dir/runtime/install-private-stateless-endpoint.sh" \
	"$script_dir/load/stateless-autoscaling/run-on-builder.sh" \
	"$script_dir/load/command-ack-disconnect/run-on-builder.sh" \
	"$script_dir/load/workers-api-business-drain/run-on-builder.sh" \
	"$script_dir/load/router-performance/run-on-builder.sh" \
	"$script_dir/load/workers-api-autoscaling/run-on-builder.sh" \
	"$script_dir/runtime/gitops/install-application.sh" \
	"$script_dir/runtime/apply-source-delta.sh" "$script_dir/runtime/test-source-delta.sh" \
	"$script_dir/runtime/bundle-full-reviewed-source.sh" \
	"$script_dir/qualification/actor-bj-q01/materialize-full-reviewed-source-via-relay.sh" \
	"$script_dir/qualification/actor-bj-q01/test-materialize-full-reviewed-source-via-relay.sh" \
	"$script_dir/runtime/validate-runtime-image.sh" \
	"$script_dir/runtime/release-runtime.sh" \
	"$script_dir/runtime/monitor-bottomless-qualification.sh" \
	"$script_dir/runtime/test-engine-ha-public-api.sh" \
	"$script_dir/runtime/bind-worker-registry.sh" \
	"$script_dir/controller/release-controller.sh" \
	"$script_dir/controller/build-image.sh" \
	"$script_dir/loadgen/build-image.sh" "$script_dir/loadgen/run.sh" \
	"$script_dir/workers-api/build-image.sh" \
	"$script_dir/workers-api/sync-credentials.sh" \
	"$script_dir/workers-api/gitops/recertify-live-convergence.sh" \
	"$script_dir/workers-api/install-private-endpoint.sh" \
	"$script_dir/workers-api/install-private-object-router-endpoint.sh" \
	"$script_dir/worker-registry/build-image.sh" \
	"$script_dir/gitops/build-image.sh" \
	"$script_dir/gitops/mirror-images.sh" \
	"$script_dir/gitops/install-qualification-git.sh" \
	"$script_dir/gitops/publish-desired-state.sh" \
	"$script_dir/gitops/publish-control-desired-state.sh" \
	"$script_dir/gitops/image-seed/bind-inventory.sh" \
	"$script_dir/gitops/complete-cell-qualification.sh" \
	"$script_dir/gitops/complete-cell-admission.sh" \
	"$script_dir/observability/federation/install-hub.sh" \
	"$script_dir/observability/federation/install-spoke-endpoint.sh" \
	"$script_dir/observability/federation/gitops/publish.sh" \
	"$script_dir/observability/federation/gitops/install-application.sh" \
	"$script_dir/observability/federation/verify-hub.sh" \
	"$script_dir/terraform/create-first/rebuild/run-management-observability.sh" \
	"$script_dir/runtime/engine-ha-probe.sh" "$script_dir/runtime/qualify-engine-ha.sh" \
	"$script_dir/qualification/run-initial-cell-qualification.sh" \
	"$script_dir/qualification/test-run-initial-cell-qualification.sh" \
	"$script_dir/runtime/generate-source-manifest.sh" \
	"$script_dir/fdb-operator/bootstrap-cell-tls.sh" \
	"$script_dir/fdb-operator/bootstrap-cell-continuous-backup.sh" \
	"$script_dir/fdb-operator/install.sh" \
	"$script_dir/terraform/create-first/bootstrap/install-pull-credential.sh" \
	"$script_dir/dr/set-fdb-drill-capacity.sh" "$script_dir/dr/qualify-primary-az-loss.sh" \
	"$script_dir/tke-native-control-nodepool/install.sh" \
	"$script_dir/tke-native-runtime-nodepool/install.sh" \
	"$script_dir/qualification/actor-bj-q01/create-bootstrap-node.sh" \
	"$script_dir/qualification/actor-bj-q01/test-create-bootstrap-node.sh" \
	"$script_dir/qualification/actor-bj-q01/bootstrap-operator-node-via-tat.sh" \
	"$script_dir/qualification/actor-bj-q01/build-semantic-failure-candidate-via-tat.sh" \
	"$script_dir/qualification/actor-bj-q01/run-user-transparent-upgrade-on-builder.sh" \
	"$script_dir/qualification/actor-bj-q01/publish-release-commands.sh" \
	"$script_dir/qualification/actor-bj-q01/test-publish-release-commands.sh" \
	"$script_dir/qualification/actor-bj-q01/create-private-endpoint.sh" \
	"$script_dir/qualification/actor-bj-q01/install-fdb-pool.sh" \
	"$script_dir/qualification/actor-bj-q01/install-fdb-tls.sh" \
	"$script_dir/qualification/actor-bj-q01/install-backup-credentials.sh" \
	"$script_dir/qualification/actor-bj-q01/install-code-plane.sh" \
	"$script_dir/qualification/actor-bj-q01/install-private-registry.sh" \
	"$script_dir/qualification/actor-bj-q01/install-coscli.sh" \
	"$script_dir/qualification/actor-bj-q01/relay-upload-to-builder.sh" \
	"$script_dir/qualification/actor-bj-q01/relay-download-from-builder.sh" \
	"$script_dir/qualification/actor-bj-q01/persist-receipt-from-builder.sh" \
	"$script_dir/qualification/actor-bj-q01/run-fdb-autoscaling-qualification.sh" \
	"$script_dir/qualification/actor-bj-q01/run-fdb-autoscaling-via-tat.sh" \
	"$script_dir/qualification/actor-bj-q01/run-engine-ha.sh" \
	"$script_dir/qualification/actor-bj-q01/qualify-runtime-machine-repair.sh" \
	"$script_dir/qualification/actor-bj-q01/qualify-runtime-automatic-replacement.sh" \
	"$script_dir/qualification/actor-bj-q01/repair-runtime-topology.sh" \
	"$script_dir/qualification/actor-bj-q01/configure-runtime-machine-repair.sh" \
	"$script_dir/qualification/actor-bj-q01/promote-reviewed-source.sh" \
	"$script_dir/qualification/actor-bj-q01/materialize-reviewed-source.sh" \
	"$script_dir/qualification/actor-bj-q01/materialize-full-reviewed-source.sh" \
	"$script_dir/qualification/actor-bj-q01/promote-fdb-automatic.sh" \
	"$script_dir/qualification/actor-bj-q01/promote-fdb-automatic-via-tat.sh" \
	"$script_dir/operations/preflight-image-pull.sh" \
	"$script_dir/operations/cache-qualification-receipt.sh" \
	"$script_dir/operations/hydrate-qualification-receipts.sh" \
	"$script_dir/operations/test-qualification-receipt-cache.sh" \
	"$script_dir/operations/test-autonomy-operation-lock.sh" \
	"$script_dir/operations/publish-qualified-release.sh" \
	"$script_dir/qualification/actor-bj-q01/install-workerd-autoscaling.sh" \
	"$script_dir/operations/test-assert-autonomy-control.sh" \
	"$script_dir/qualification/actor-bj-q01/terraform/import-existing.sh" \
	"$script_dir/observability/install.sh" \
	"$script_dir/observability/install-prometheus-adapter.sh" \
	"$script_dir/observability/verify.sh" \
	"$script_dir/worker-registry/verify.sh"
"$script_dir/qualification/actor-bj-q01/test-create-bootstrap-node.sh"
"$script_dir/operations/test-qualification-receipt-cache.sh"
"$script_dir/operations/test-autonomy-operation-lock.sh"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/operations/test_plan_qualification_activation.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/qualification/test_build_runtime_release_qualification.py"
if grep -n 'actor-bj-k01' \
	"$script_dir/operations/install-autonomy-systemd.sh" \
	"$script_dir/operations/autonomy-reviewed-source-entrypoint.sh" \
	"$script_dir/operations/test-autonomy-reviewed-source-entrypoint.sh" \
	"$script_dir/operations/systemd/autonomy-audit-control.service"; then
	echo "autonomy systemd installation must not retain a default Cell identity" >&2
	exit 1
fi
if grep -En '\$\{(CELL|RIVET_CELL_NAME|ACTOR_CELL_NAME)(:-|:=)actor-bj-[a-z][0-9]{2}|default="actor-bj-[a-z][0-9]{2}"' \
	"$script_dir/operations/run-autonomy-governance.sh" \
	"$script_dir/operations/run-autonomy-audit.sh" \
	"$script_dir/operations/autonomy_audit.py" \
	"$script_dir/operations/verify-physical-restore-receipt.py" \
	"$script_dir/runtime/render-runtime-config.py" \
	"$script_dir/runtime/install.sh" \
	"$script_dir/runtime/install-admission-controller.sh" \
	"$script_dir/runtime/release-runtime.sh" \
	"$script_dir/runtime/qualify-runtime.sh" \
	"$script_dir/runtime/qualify-engine-ha.sh" \
	"$script_dir/runtime/validate-runtime-image.sh" \
	"$script_dir/autoscaling/qualify.sh" \
	"$script_dir/controller/release-controller.sh" \
	"$script_dir/loadgen/run.sh" \
	"$script_dir/dr/seed-and-freeze-actors.sh" \
	"$script_dir/dr/qualify-primary-az-loss.sh" \
	"$script_dir/dr/freeze-retained-actors.sh" \
	"$script_dir/dr/set-fdb-drill-capacity.sh" \
	"$script_dir/tke-native-nodepool/release-envelope.sh"; then
	echo "generic production entrypoints must not retain a default Cell identity" >&2
	exit 1
fi
for guard in \
	'CELL must name the exact Cell' \
	'KUBECONFIG_PATH must name the exact Cell kubeconfig' \
	'AUTONOMY_QUALIFICATION_MODE' \
	'AUTONOMY_AUTO_PUBLISH_QUALIFICATION' \
	'AUTONOMY_REVIEWED_SOURCE_LINK' \
	'with-autonomy-operation-lock.sh' \
	'AUTONOMY_OPERATION_LOCK_HELD=1' \
	'initial_control_status == 2' \
	'systemctl is-active --quiet autonomy-audit-control.timer' \
	'/usr/local/libexec/actor-autonomy-reviewed-source-entrypoint' \
	'fresh autonomy receipt is not bound to the installed reviewed source' \
	'autonomy_systemd_install=passed'; do
	grep -Fq "$guard" "$script_dir/operations/install-autonomy-systemd.sh" || {
		echo "autonomy systemd installer lost fail-closed guard: $guard" >&2
		exit 1
	}
done
for guard in \
	'readlink -e "$source_link"' \
	'expected_manifest_sha' \
	'AUTONOMY_SOURCE_REVISION' \
	'AUTONOMY_SOURCE_MANIFEST_SHA256' \
	'AUTONOMY_SOURCE_TARGET' \
	'AUTONOMY_OPERATION_LOCK_HELD' \
	'autonomy audit skipped: another Cell operation owns the lock' \
	'publish-qualified-release.sh' \
	'automatic qualification refused unexpected Cell phase' \
	'actor-autonomy-reviewed-source-entrypoint'; do
	grep -Fq "$guard" \
		"$script_dir/operations/autonomy-reviewed-source-entrypoint.sh" \
		"$script_dir/operations/systemd/autonomy-audit-control.service" || {
		echo "autonomy reviewed-source entrypoint lost invariant: $guard" >&2
		exit 1
	}
done
"$script_dir/operations/test-autonomy-reviewed-source-entrypoint.sh"
for hook_contract in \
	'RIVET_UPGRADE_RUN_ID' \
	'RIVET_UPGRADE_LOCAL_RECEIPT' \
	'RIVET_RELEASE_ORCHESTRATOR' \
	'approved-command-result.py' \
	'if [[ -n ${TAT_COMMAND_ID:-} ]]' \
	'user_transparent_%s_run_id=%s remote_receipt=%s'; do
	grep -Fq "$hook_contract" "$script_dir/qualification/actor-bj-q01/run-user-transparent-upgrade-via-tat.sh" || {
		echo "Argo release Hook receipt contract is missing: $hook_contract" >&2
		exit 1
	}
done
sh -n "$script_dir/fdb-operator/install.sh"
"$script_dir/runtime/test-source-delta.sh"
"$script_dir/runtime/test-engine-ha-public-api.sh"
"$script_dir/qualification/actor-bj-q01/test-run-bottomless-production.sh"
"$script_dir/qualification/actor-bj-q01/test-run-fdb-autoscaling-via-tat.sh"
"$script_dir/qualification/actor-bj-q01/test-reset-qualification-application-state.sh"
"$script_dir/qualification/test-run-initial-cell-qualification.sh"
"$script_dir/test-bootstrap-fdb-node.sh"
python3 "$script_dir/runtime/test_verify_bottomless_receipt.py"
python3 "$script_dir/autoscaling/test_validate_loadgen_result.py"
python3 "$script_dir/gitops/test_render_release_hooks.py"
python3 "$script_dir/gitops/test_verify_approved_release_commands.py"
python3 "$script_dir/gitops/test_verify_argocd_release_provenance.py"
python3 "$script_dir/qualification/actor-bj-q01/test-approved-command-result.py"
python3 "$script_dir/qualification/actor-bj-q01/test_release_receipt_persistence.py"
python3 "$script_dir/runtime/test_bottomless_receipt_identity.py"
python3 "$script_dir/runtime/test_runtime_base_contract.py"
python3 "$script_dir/qualification/actor-bj-q01/test_runtime_build_log.py"
python3 "$script_dir/qualification/actor-bj-q01/test_runtime_python.py"
python3 "$script_dir/runtime/test_builder_storage.py"
python3 "$script_dir/qualification/actor-bj-q01/test_prepared_runtime_stage.py" PreparedStageContractTest
python3 "$script_dir/runtime/test_monitor_bottomless.py"
command -v kubectl >/dev/null || {
	echo "kubectl is required for the qualification Pod UID protocol gate" >&2
	exit 1
}
python3 -m unittest discover -s "$script_dir/load/stateless-durable-routing" -p 'test_*.py' -v
"$script_dir/qualification/actor-bj-q01/test-run-user-transparent-upgrade-via-tat.sh"
python3 "$script_dir/runtime/test_capture_release_binding.py"
python3 "$script_dir/runtime/test_render_runtime_config.py"
python3 "$script_dir/runtime/test_manifest_identity.py"
python3 "$script_dir/runtime/test_strip_update_owned_fields.py"
python3 "$script_dir/runtime/test_runtime_workerd_shards.py"
python3 "$script_dir/runtime/test_runtime_nats.py"
python3 "$script_dir/runtime/test_partition_runtime_manifest.py"
python3 "$script_dir/runtime/test_preserve_noop_template_identity.py"
python3 "$script_dir/runtime/test_coordinate_noop_release_identity.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/runtime/test_validate_control_node_topology.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/tke-native-control-nodepool/test_install_topology.py"
python3 "$script_dir/../test_qualify_failure_receipt.py"
python3 "$script_dir/../test_qualify_dormant_actors.py"
python3 "$script_dir/autoscaling/test_verify_receipt.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/load/stateless-autoscaling/test_verify.py"
node --test "$script_dir/load/stateless-autoscaling/runner.test.mjs"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/load/workers-api-autoscaling/test_verify.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/load/workers-api-autoscaling/test_observe.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/load/deployment-cursor/test_qualify.py"
python3 "$script_dir/qualification/actor-bj-q01/test_agent_arrival_rate.py"
python3 "$script_dir/qualification/test_build_cell_class_qualification.py"
python3 "$script_dir/qualification/actor-bj-q01/test_recover_expanded_fdb.py"
python3 "$script_dir/qualification/actor-bj-q01/test_verify_expanded_fdb_recovery.py"
python3 "$script_dir/qualification/actor-bj-q01/test_verify_runtime_machine_repair_receipt.py"
python3 "$script_dir/qualification/actor-bj-q01/test_verify_runtime_automatic_repair_receipt.py"
python3 "$script_dir/qualification/actor-bj-q01/test_verify_runtime_topology_repair_receipt.py"
python3 "$script_dir/qualification/actor-bj-q01/test_verify_existing_runtime_capacity.py"
python3 "$script_dir/qualification/actor-bj-q01/physical-restore/test_physical_restore.py"
python3 "$script_dir/operations/test_autonomy_audit.py"
python3 "$script_dir/operations/test_audit_json.py"
arrival_schema=actor-cell-agent-arrival-rate/v1
grep -Fq '"schema": "'"$arrival_schema"'"' \
	"$script_dir/qualification/actor-bj-q01/agent-arrival-rate.py"
grep -Fq 'payload.get("schema") == "'"$arrival_schema"'"' \
	"$script_dir/operations/autonomy_audit.py"
python3 "$script_dir/operations/test_preflight_image_pull.py"
python3 "$script_dir/operations/test_release_ledger.py"
python3 "$script_dir/qualification/actor-bj-q01/test_user_transparent_upgrade.py"
python3 "$script_dir/qualification/actor-bj-q01/test_verify_user_transparent_upgrade.py"
python3 "$script_dir/qualification/actor-bj-q01/test_verify_failed_release_rollback.py"
python3 "$script_dir/qualification/actor-bj-q01/test_verify_user_transparent_rollback.py"
"$script_dir/operations/test-assert-autonomy-control.sh"

# Kustomize expansion and the strict YAML/invariant checks below must remain
# runnable on a clean builder with no current Kubernetes context. `kubectl
# apply --dry-run=client` still performs API discovery for custom resources,
# so schema-aware server dry-runs stay in the separate cloud qualification.
kubectl kustomize "$script_dir/fdb-operator" >/dev/null
kubectl kustomize "$script_dir/controller-fdb-operator" >/dev/null
kubectl kustomize "$script_dir/worker-registry" >/dev/null

# Custom resources require the CRDs to exist for a server-side dry-run. The
# static checks below protect the scale and retirement invariants before that
# cloud gate is run.
python3 - "$script_dir" <<'PY'
import hashlib
import json
import re
import runpy
import subprocess
import sys
from pathlib import Path

import yaml

root = Path(sys.argv[1])
legacy_backup_field = "backupDetails." + "restorable"
legacy_python_backup_field = 'backup.get(' + '"restorable")'
for shell_script in root.rglob("*.sh"):
    shell_source = shell_script.read_text()
    if legacy_backup_field in shell_source or legacy_python_backup_field in shell_source:
        raise SystemExit(
            f"{shell_script.relative_to(root)} still trusts the nonexistent FDB Operator backup restorable field"
        )
governed_workflows = {
    "autoscaling/qualify.sh": ("$cell", "$namespace"),
    "controller/release-controller.sh": ("$cell", "$cell_namespace"),
    "runtime/qualify-engine-ha.sh": ("$cell_name", "$namespace"),
    "runtime/qualify-runtime.sh": ("$cell_name", "$namespace"),
    "runtime/release-runtime.sh": ("$cell_name", "$namespace"),
    "qualification/actor-bj-q01/qualify-runtime-machine-repair.sh": ("$cell_name", "$namespace"),
    "qualification/actor-bj-q01/qualify-runtime-automatic-replacement.sh": ("$cell_name", "$namespace"),
    "qualification/actor-bj-q01/repair-runtime-topology.sh": ("$cell_name", "$namespace"),
    "qualification/actor-bj-q01/configure-runtime-machine-repair.sh": ("$cell_name", "$namespace"),
    "dr/set-fdb-drill-capacity.sh": ("$cell", "$namespace"),
    "dr/qualify-zone-recovery.sh": ("$cluster", "$namespace"),
    "dr/qualify-primary-az-loss.sh": ("$cluster", "$namespace"),
}
for relative, (cell_variable, namespace_variable) in governed_workflows.items():
    workflow = (root / relative).read_text()
    if f'AUTONOMY_CONTROL_CELL="{cell_variable}"' not in workflow:
        raise SystemExit(f"{relative} does not bind its exact Cell to autonomy control")
    if f'AUTONOMY_CONTROL_NAMESPACE="{namespace_variable}"' not in workflow:
        raise SystemExit(f"{relative} does not bind its exact namespace to autonomy control")
crds = (root / "crds.yaml").read_text()
fleet = (root / "beijing-fleet.yaml").read_text()
storage = (root / "storageclasses.yaml").read_text()
terraform = (root / "terraform" / "main.tf").read_text()
host_unit = (root.parent / "systemd" / "actor-rivet-workerd-host.service").read_text()
pool_unit = (root.parent / "systemd" / "actor-rivet-workerd-pool-init.service").read_text()
installer = (root.parent / "install-beijing-workerd-cell.sh").read_text()
operator_profile_documents = [
    document
    for document in yaml.safe_load_all((root / "beijing-kubernetes-profile.yaml").read_text())
    if document
]
operator_profile = next(
    document for document in operator_profile_documents
    if document.get("kind") == "RivetCellProfile"
)
operator_class = next(
    document for document in operator_profile_documents
    if document.get("kind") == "ShardClass"
)
operator_manifest = (root / "fdb-operator" / "operator.yaml").read_text()
operator_kustomization = (root / "fdb-operator" / "kustomization.yaml").read_text()
operator_installer = (root / "fdb-operator" / "install.sh").read_text()
operator_crd_lock = (root / "fdb-operator" / "vendor" / "crds" / "SOURCE.lock").read_text()
operator_crd_dir = root / "fdb-operator" / "vendor" / "crds"
operator_priority = (root / "fdb-operator" / "priority-class.yaml").read_text()
q01_backup = yaml.safe_load(
    (root / "qualification" / "actor-bj-q01" / "continuous-backup.yaml").read_text()
)
q01_cell_documents = [
    document
    for document in yaml.safe_load_all(
        (root / "qualification" / "actor-bj-q01" / "fleet-cell.yaml").read_text()
    )
    if document
]
q01_profile = next(x for x in q01_cell_documents if x.get("kind") == "RivetCellProfile")
q01_class = next(x for x in q01_cell_documents if x.get("kind") == "ShardClass")
q01_cell = next(x for x in q01_cell_documents if x.get("kind") == "RivetCell")
q01_autoscaling_documents = [
    document
    for document in yaml.safe_load_all(
        (root / "qualification" / "actor-bj-q01" / "workerd-autoscaling.yaml").read_text()
    )
    if document
]
q01_workerd_hpa = next(
    document for document in q01_autoscaling_documents
    if document.get("kind") == "HorizontalPodAutoscaler"
)
q01_host_drain = next(
    document for document in q01_autoscaling_documents
    if document.get("kind") == "Deployment"
)
q01_host_drain_role = next(
    document for document in q01_autoscaling_documents
    if document.get("kind") == "Role"
    and document.get("metadata", {}).get("name") == "actor-bj-q01-host-drain"
)
q01_adapter_values = yaml.safe_load(
    (root / "qualification" / "actor-bj-q01" / "prometheus-adapter-values.yaml").read_text()
)
q01_autoscaling_installer = (
    root / "qualification" / "actor-bj-q01" / "install-workerd-autoscaling.sh"
).read_text()
q01_runtime_capacity_prerequisite = (
    root / "qualification" / "actor-bj-q01" / "verify-existing-runtime-capacity.py"
).read_text()
q01_machine_repair_qualification = (
    root / "qualification" / "actor-bj-q01" / "qualify-runtime-machine-repair.sh"
).read_text()
q01_coscli_installer = (
    root / "qualification" / "actor-bj-q01" / "install-coscli.sh"
).read_text()
q01_relay = (
    root / "qualification" / "actor-bj-q01" / "relay-upload-to-builder.sh"
).read_text()
q01_relay_download = (
    root / "qualification" / "actor-bj-q01" / "relay-download-from-builder.sh"
).read_text()
if 'local_file=$(readlink -e "$1")' not in q01_relay:
    raise SystemExit(
        "q01 relay upload must resolve a relative local source before changing directory"
    )
q01_controller_builder = (
    root / "qualification" / "actor-bj-q01" / "build-controller-via-tat.sh"
).read_text()
for regional_base_guard in (
    "ACTOR_FLEET_BUILD_BASE", "ACTOR_FLEET_RUNTIME_BASE",
    "ACTOR_PRODUCT_BUILD_RECEIPT", "ACTOR_BUILD_PYTHON", "actor-fleet/base-golang@sha256:",
    "actor-fleet/base-distroless@sha256:",
):
    if regional_base_guard not in q01_controller_builder:
        raise SystemExit(f"q01 controller relay build lost regional base provenance: {regional_base_guard}")
q01_release_hook_builder = (
    root / "qualification" / "actor-bj-q01" / "build-release-hook-via-tat.sh"
).read_text()
for hook_build_guard in (
    "ACTOR_RELEASE_HOOK_BASE",
    "ACTOR_PRODUCT_BUILD_RECEIPT",
    "ACTOR_BUILD_PYTHON",
    "export ACTOR_BUILD_PYTHON=$quoted_python",
    "actor-fleet/base-tencentcloud-cli@sha256:",
):
    if hook_build_guard not in q01_release_hook_builder:
        raise SystemExit(
            f"q01 release-hook relay build lost regional provenance: {hook_build_guard}"
        )
q01_registry_installer = (
    root / "qualification" / "actor-bj-q01" / "install-private-registry.sh"
).read_text()
q01_code_plane_installer = (
    root / "qualification" / "actor-bj-q01" / "install-code-plane.sh"
).read_text()
image_preflight = (root / "operations" / "preflight-image-pull.sh").read_text()
q01_terraform_dir = root / "qualification" / "actor-bj-q01" / "terraform"
q01_terraform_main = (q01_terraform_dir / "main.tf").read_text()
q01_terraform_variables = (q01_terraform_dir / "variables.tf").read_text()
q01_terraform_versions = (q01_terraform_dir / "versions.tf").read_text()
q01_terraform_importer = (q01_terraform_dir / "import-existing.sh").read_text()
gitops_bootstrap = [
    document for document in yaml.safe_load_all((root / "gitops" / "bootstrap.example.yaml").read_text())
    if document
]
gitops_project = yaml.safe_load((root / "gitops" / "argocd-project.example.yaml").read_text())
gitops_release_rbac = [
    document for document in yaml.safe_load_all(
        (root / "gitops" / "argocd-release-rbac.yaml").read_text()
    ) if document
]
for q01_file in (root / "qualification" / "actor-bj-q01").rglob("*"):
    if q01_file.is_file() and "cls-iziy9h2t" in q01_file.read_text(errors="ignore"):
        raise SystemExit(f"q01 source retained deleted cluster identity: {q01_file.relative_to(root)}")
q01_load_driven_soak = (
    root / "qualification" / "actor-bj-q01" / "load-driven-soak.py"
).read_text()
autonomy_governance = (root / "operations" / "run-autonomy-governance.sh").read_text()
runtime_manifest = (root / "runtime" / "runtime.yaml").read_text()
runtime_documents = [
    document for document in yaml.safe_load_all(runtime_manifest) if document
]
runtime_admission_manifest = (root / "runtime" / "admission-controller.yaml").read_text()
runtime_admission_documents = [
    document for document in yaml.safe_load_all(runtime_admission_manifest) if document
]
nats_manifest = (root / "runtime" / "nats.yaml").read_text()
nats_documents = [
    document for document in yaml.safe_load_all(nats_manifest) if document
]
runtime_installer = (root / "runtime" / "install.sh").read_text()
engine_nats_verifier = (root / "runtime" / "verify-engine-nats-clients.py").read_text()
runtime_releaser = (root / "runtime" / "release-runtime.sh").read_text()
runtime_update_stripper = (root / "runtime" / "strip-update-owned-fields.py").read_text()
runtime_admission_installer = (root / "runtime" / "install-admission-controller.sh").read_text()
runtime_host_autoscaling_installer = (
    root / "runtime" / "install-host-autoscaling.sh"
).read_text()
qualification_workers_api_installer = (
    root / "runtime" / "install-qualification-workers-api.sh"
).read_text()
for qualification_api_guard in (
    "ACTOR_IMAGE_PREFLIGHT_REQUIRED_OUTPUT",
    "-engine-cell",
    "-qualification-cell",
    "-qualification-cell-uid",
    "-qualification-datacenter",
    "preflight-image-pull.sh",
):
    if qualification_api_guard not in qualification_workers_api_installer:
        raise SystemExit(
            "qualification Workers API lost immutable CLI-contract preflight: "
            + qualification_api_guard
        )
runtime_oidc_renderer = (root / "runtime" / "render-controller-oidc.py").read_text()
runtime_capacity_main = (root.parents[2] / "cmd" / "workerd-runtime-capacity-controller" / "main.go").read_text()
runtime_capacity_controller = (root.parents[2] / "internal" / "runtimecapacity" / "controller.go").read_text()
runtime_tencent_oidc = (root.parents[2] / "internal" / "runtimecapacity" / "tencent_oidc_credentials.go").read_text()
runtime_tencent_scale_down = (root.parents[2] / "internal" / "runtimecapacity" / "tencent_exact_scale_down.go").read_text()
runtime_builder = (root / "runtime" / "build-image.sh").read_text()
workers_api_builder = (root / "workers-api" / "build-image.sh").read_text()
worker_registry_builder = (root / "worker-registry" / "build-image.sh").read_text()
release_hook_builder = (root / "gitops" / "build-image.sh").read_text()
for release_hook_product_guard in (
    'product_python=${ACTOR_BUILD_PYTHON:-python3}',
    '"$product_python" -c',
    'buildah inspect "$image_tag" | "$product_python" -c',
    '"$product_python" "$script_dir/image-seed/record-product-image.py"',
):
    if release_hook_product_guard not in release_hook_builder:
        raise SystemExit(
            "release Hook build lost its qualified Python contract: "
            + release_hook_product_guard
        )
runtime_tat_builder = (
    root / "qualification" / "actor-bj-q01" / "build-runtime-via-tat.sh"
).read_text()
runtime_stage_reuser = (root / "runtime" / "reuse-stage-from-runtime.sh").read_text()
runtime_stage_reuse_inputs = (root / "runtime" / "verify-stage-reuse-inputs.py").read_text()
runtime_cargo_cache = (root / "runtime" / "prepare-cargo-cache.sh").read_text()
runtime_baseline_materializer = (
    root / "runtime" / "materialize-runtime-baseline-source.sh"
).read_text()
controller_builder = (root / "controller" / "build-image.sh").read_text()
controller_base_builder = (root / "controller" / "build-dependency-base.sh").read_text()
controller_base_dockerfile = (root.parents[2] / "Dockerfile.actor-fleet-controller-build-base").read_text()
loadgen_builder = (root / "loadgen" / "build-image.sh").read_text()
controller_dockerfile = (root.parents[2] / "Dockerfile.actor-fleet-controller").read_text()
worker_registry_builder = (root / "worker-registry" / "build-image.sh").read_text()
worker_registry_dockerfile = (root.parents[2] / "Dockerfile.worker-registry").read_text()
if 'WORKERD_BIN="$stage_dir/workerd"' not in runtime_builder or \
        'cargo test --locked --release -p rivet-workerd-host --test workerd_process' not in runtime_builder:
    raise SystemExit("production runtime build lost the exact-workerd Host process gate")
if 'WORKERD_BIN="${workerd}"' not in (root.parents[1] / "local" / "mesh" / "build-real-runtime-image.sh").read_text():
    raise SystemExit("local runtime build lost the exact-workerd Host process gate")
worker_registry_fdb_lock = json.loads(
    (root / "worker-registry" / "foundationdb-client.lock.json").read_text()
)
if worker_registry_fdb_lock != {
    "packageSha256": "52cc22565c42e7eb60c08f395a0626483735c311be0d80b7c035ac8e328e2fff",
    "schemaVersion": 1,
    "url": "https://github.com/apple/foundationdb/releases/download/7.3.79/foundationdb-clients_7.3.79-1_amd64.deb",
    "version": "7.3.79",
}:
    raise SystemExit("Worker Registry FDB client lock drifted")
for guard in (
    "WORKER_REGISTRY_FDB_CLIENT_DEB",
    'sha256sum "$fdb_client"',
    'ACTOR_BUILD_PYTHON:-python3',
):
    if guard not in worker_registry_builder:
        raise SystemExit("Worker Registry offline build guard is missing: " + guard)
if "ADD --checksum" in worker_registry_dockerfile or "https://" in worker_registry_dockerfile:
    raise SystemExit("Worker Registry Dockerfile must not fetch its FDB client from the network")
worker_loader_abi_test = (
    root.parents[4] / "runtimes" / "workerd" / "host" / "workerd"
    / "worker-loader-abi-test.js"
).read_text()
worker_loader_abi_config = (
    root.parents[4] / "runtimes" / "workerd" / "host" / "workerd"
    / "worker-loader-abi-test.wd-test"
).read_text()
object_router_abi_test = (
    root.parents[4] / "runtimes" / "workerd" / "host" / "workerd"
    / "object-router-abi-test.js"
).read_text()
runtime_release = (root / "runtime" / "release-runtime.sh").read_text()
runtime_image_validator = (root / "runtime" / "validate-runtime-image.sh").read_text()
runtime_source_bundler = (root / "runtime" / "bundle-source-delta.sh").read_text()
runtime_source_applier = (root / "runtime" / "apply-source-delta.sh").read_text()
runtime_qualifier = (root / "runtime" / "qualify-runtime.sh").read_text()
bottomless_monitor = (root / "runtime" / "monitor-bottomless-qualification.sh").read_text()
qualification_harness = (root.parent / "qualify_workerd_density.py").read_text()
workerd_sqlite_bridge = (
    root.parents[4] / "runtimes" / "workerd" / "host" / "src" / "sqlite_bridge.rs"
).read_text()
bottomless_receipt_verifier = (root / "runtime" / "verify_bottomless_receipt.py").read_text()
engine_ha_probe = (root / "runtime" / "engine-ha-probe.sh").read_text()
engine_ha_qualifier = (root / "runtime" / "qualify-engine-ha.sh").read_text()
engine_ha_job_template = (root / "runtime" / "engine-ha-probe-job.yaml").read_text()
engine_ha_job = yaml.safe_load(
    engine_ha_job_template
    .replace("__ENGINE_HA_PROBE_JOB__", "actor-bj-k01-engine-ha-test")
    .replace("__RIVET_CELL_NAMESPACE__", "actor-fdb-cell-system")
    .replace("__RIVET_CELL_NAME__", "actor-bj-k01")
    .replace("__RIVET_RUNTIME_IMAGE__", "example.invalid/runtime@sha256:" + "a" * 64)
)
observability_values = yaml.safe_load((root / "observability" / "values.yaml").read_text())
observability_installer = (root / "observability" / "install.sh").read_text()
observability_mirror = (root / "observability" / "mirror-images.sh").read_text()
gitops_mirror = (root / "gitops" / "mirror-images.sh").read_text()
image_seed = (root / "gitops" / "image-seed" / "seed-tcr.sh").read_text()
image_seed_lock = json.loads(
    (root / "gitops" / "image-seed" / "upstream-images.lock.json").read_text()
)
q01_observability_installer = (
    root / "qualification" / "actor-bj-q01" / "install-observability.sh"
).read_text()
observability_documents = [
    document
    for path in (
        "namespace-storage.yaml",
        "engine-metrics.yaml",
        "actor-rules.yaml",
        "actor-dashboard.yaml",
    )
    for document in yaml.safe_load_all((root / "observability" / path).read_text())
    if document
]
observability_adapter_values = yaml.safe_load(
    (root / "observability" / "prometheus-adapter-values.yaml").read_text()
)

if "runtime_cloud_credential_secret" in runtime_installer:
    raise SystemExit("runtime installer retained the removed static cloud credential identity")
runtime_identity_block = runtime_installer[
    runtime_installer.index("runtime_manifest_sha="):
    runtime_installer.index("temporary_root=")
]
for runtime_identity_guard in (
    '"$runtime_exact_scale_down_enabled"',
    '"$runtime_tke_cluster_id"',
    '"$runtime_tke_oidc_role_arn"',
):
    if runtime_identity_guard not in runtime_identity_block:
        raise SystemExit(
            f"runtime manifest identity lost provider control input: {runtime_identity_guard}"
        )

if "chart_version=87.21.0" not in observability_installer or "chart_sha256=05eae98df0ff6c21877a26a4400780e4bbff248bc3b88694ef8d08b273ed6815" not in observability_installer:
    raise SystemExit("observability installer must pin and verify the qualified chart archive")
if "ACTOR_PROMETHEUS_MEMORY_REQUEST=1Gi" not in q01_observability_installer:
    raise SystemExit("q01 observability must fit the fixed control-node memory envelope")
if "ACTOR_OBSERVABILITY_IMAGE_REGISTRY=lightclaw-bj82.tencentcloudcr.com" not in q01_observability_installer:
    raise SystemExit("q01 observability must pull every chart image through Beijing TCR")
observability_repositories = (
    "observability-busybox",
    "observability-grafana",
    "observability-k8s-sidecar",
    "observability-kube-state-metrics",
    "observability-kubectl",
    "observability-prometheus",
    "observability-prometheus-adapter",
    "observability-prometheus-config-reloader",
    "observability-prometheus-operator",
    "observability-webhook-certgen",
)
for repository in observability_repositories:
    if f'"{repository}"' not in q01_terraform_main:
        raise SystemExit(f"q01 Terraform lost observability repository: {repository}")
    if f"actor-fleet/{repository}" not in q01_registry_installer:
        raise SystemExit(f"q01 TCR token preflight lost observability repository: {repository}")
if 'exec "$script_dir/../gitops/image-seed/seed-tcr.sh"' not in observability_mirror:
    raise SystemExit("observability mirror must delegate to the complete image seed")
if 'exec "$script_dir/image-seed/seed-tcr.sh"' not in gitops_mirror:
    raise SystemExit("GitOps mirror must delegate to the complete image seed")
for image_seed_guard in (
    'buildah=${BUILDAH:-buildah}',
    'storage=("$buildah" --root "$temporary/storage" --runroot "$temporary/runroot" --storage-driver vfs)',
    '"${storage[@]}" push --quiet --authfile "$auth_file" --digestfile "$digest_file"',
    'verification_directory=$temporary/verify-$repository',
    'verification_storage=("$buildah" --root "$verification_directory/storage"',
    'verified_image_id=$("${verification_storage[@]}" pull --quiet --authfile "$auth_file"',
    'rm -rf -- "$verification_directory"',
):
    if image_seed_guard not in image_seed:
        raise SystemExit(
            f"complete image seed lost authenticated isolated Buildah guard: {image_seed_guard}"
        )
locked_repositories = {image["repository"] for image in image_seed_lock["images"]}
if "observability-prometheus-adapter" not in locked_repositories:
    raise SystemExit("complete image lock lost Prometheus Adapter")
if 'resource "tencentcloud_tcr_repository" "observability"' not in q01_terraform_main or "prevent_destroy = true" not in q01_terraform_main:
    raise SystemExit("q01 observability repositories must remain declarative and protected")

for guard in (
    "version=v1.0.9",
    "a07de5ba2800147a700ed29036b0c76a4229088cee68e1682d0eae19b638a915",
    "cosbrowser.cloud.tencent.com/software/coscli/coscli-linux-amd64",
):
    if guard not in q01_coscli_installer:
        raise SystemExit(f"q01 COSCLI installer lost pinned supply-chain guard: {guard}")
for guard in (
    "coscli version v1.0.9",
    "--forbid-overwrite",
    "--server-side-encryption AES256",
    "--simple-output",
    "sha256sum",
):
    if guard not in q01_relay:
        raise SystemExit(f"q01 COS relay lost guard: {guard}")
if "AWS_CLI" in q01_relay or re.search(r"(^|[ /])aws([ \"']|$)", q01_relay, re.M):
    raise SystemExit("q01 COS relay must use Tencent COSCLI, not AWS CLI")
if "--disable-log" in q01_relay.replace(
    "# authentication failures under --disable-log.", ""
):
    raise SystemExit("q01 COS relay must not suppress COSCLI authentication failures")
for guard in (
    "/data/actor-build/product-receipts/*",
    "q01-relay-source-metadata",
    "signurl",
    "--method PUT",
    "--time 900",
    "x-cos-forbid-overwrite: true",
    "x-cos-meta-sha256",
    "relay/download/$run_id/$base",
    'sha256sum "$partial"',
    'rm "$cos_uri"',
):
    if guard not in q01_relay_download:
        raise SystemExit(f"q01 reverse COS relay lost guard: {guard}")
if "tat-download.sh" in q01_relay_download:
    raise SystemExit("q01 reverse COS relay must not transfer large evidence through TAT chunks")
for guard in (
    "--TokenType temp",
    "q01-tcr-build-${request_id}.json",
    "test ! -e $quoted_remote",
    "ACTOR_FLEET_CONTROLLER_IMAGE_TAG",
    "RELEASE_SHA256SUMS",
    "getent ahostsv4",
):
    if guard not in q01_controller_builder:
        raise SystemExit(f"q01 controller build lost ephemeral push-auth guard: {guard}")
if "actor-bj-q01-tcr-config.json" in q01_controller_builder:
    raise SystemExit("q01 controller build must not reuse the long-lived pull credential")
for guard in (
    "--TokenType temp",
    "q01-release-hook-build-${request_id}.json",
    "ACTOR_RELEASE_HOOK_IMAGE_TAG",
    "RELEASE_SHA256SUMS",
    "getent ahostsv4",
    "q01-remove-release-hook-build-auth",
):
    if guard not in q01_release_hook_builder:
        raise SystemExit(f"q01 release Hook build lost ephemeral push-auth guard: {guard}")
if "actor-bj-q01-tcr-config.json" in q01_release_hook_builder:
    raise SystemExit("q01 release Hook build must not reuse the long-lived pull credential")
for guard in (
    "--TokenType longterm",
    "DescribeInstanceToken",
    'q01-tcr-${registry_identity}-longterm-credential-v1.json',
    "required_repositories",
    "actor-fleet/git-service",
    "actor-git-system",
    "DescribeInternalEndpoints",
    'select(.VpcId == $vpc and .Status == "Running")',
    "getent ahostsv4",
    "private_access_ip",
    "existing",
    "jq -s '{auths:((.[0].auths // {}) + (.[1].auths // {}))}'",
):
    if guard not in q01_registry_installer:
        raise SystemExit(f"q01 TCR credential installer lost autonomy guard: {guard}")
missing_credential_fence = re.search(
    r"else\s*\n\s*if jq -e --arg description \"\$token_description\".*?"
    r"\.Tokens\[\].*?echo \"q01 long-term TCR token exists but its protected "
    r"local credential is missing\".*?exit 1\s*\n\s*fi",
    q01_registry_installer,
    re.S,
)
if missing_credential_fence is None:
    raise SystemExit("q01 TCR installer lost the cloud-token/local-secret fail-closed fence")
if "31536000) * 1000" not in q01_registry_installer:
    raise SystemExit("q01 long-term TCR credential expiry must be validated in milliseconds")
for required_registry_namespace in (
    "fdb-operator-actor-fleet-controller-system",
    "actor-fdb-cell-system",
    "actor-stateless-system",
    "actor-runtime-admission-system",
    "observability",
    "actor-release-system",
    "argocd",
):
    if required_registry_namespace not in q01_registry_installer:
        raise SystemExit(
            "q01 TCR credential rotation lost namespace: "
            + required_registry_namespace
        )
if "--TokenType temp" in q01_registry_installer:
    raise SystemExit("q01 autonomous image pulls must not use a one-hour TCR token")
for repository in (
    "actor-fleet/base-tencentcloud-cli",
    "actor-fleet/release-hook",
    "actor-fleet/argocd",
    "actor-fleet/argocd-dex",
    "actor-fleet/argocd-haproxy",
    "actor-fleet/argocd-redis",
    "actor-fleet/fdb-kubernetes-monitor",
    "actor-fleet/fdb-kubernetes-operator",
    "actor-fleet/nats",
    "actor-fleet/runtime-base",
):
    if repository not in q01_registry_installer:
        raise SystemExit("q01 TCR inventory lost release Hook repository: " + repository)

for guard in (
    "RIVET_REPORTER_IMAGE must be an immutable image digest",
    "apply --server-side --dry-run=server",
    "--field-manager=\"$field_manager\"",
    "get machineset.node.tke.cloud.tencent.com np-runtime0",
):
    if guard not in q01_autoscaling_installer:
        raise SystemExit(f"q01 autoscaling installer lost gate: {guard}")
if "--force-conflicts" in q01_autoscaling_installer.replace(
    "# Deliberately omit --force-conflicts.", ""
):
    raise SystemExit("q01 autoscaling installer must fail closed on SSA conflicts")
for ownership_guard in (
    "runtime-capacity owns provider scale-down",
    "runtime-capacity controller image must converge before autoscaling install",
    "runtime-capacity admission image must converge before autoscaling install",
    "RUNTIME_EXACT_SCALE_DOWN_ENABLED",
    "RUNTIME_CAPACITY_TARGETED_REPAIR_ENABLED",
):
    if ownership_guard not in q01_autoscaling_installer + q01_runtime_capacity_prerequisite:
        raise SystemExit(
            f"q01 autoscaling installer lost runtime-capacity ownership boundary: {ownership_guard}"
        )
if q01_autoscaling_installer.count("install-admission-controller.sh") != 1:
    raise SystemExit("q01 autoscaling installer must have one absent-only admission bootstrap path")
q01_host_drain_deployment = next(
    document for document in q01_autoscaling_documents
    if document.get("kind") == "Deployment"
    and document.get("metadata", {}).get("name") == "actor-bj-q01-host-drain"
)
if q01_host_drain_deployment["spec"]["template"].get("metadata", {}).get("annotations", {}).get(
    "fleet.actor.dev/runtime-release-hold-protocol"
) != "statefulset-uid-cas-v1":
    raise SystemExit("q01 Host drain controller lost the runtime release hold protocol")

for guard in (
    'resource "tencentcloud_kubernetes_cluster" "qualification"',
    'deletion_protection          = true',
    'prevent_destroy = true',
    'ignore_changes = [cluster_os_type, runtime_version]',
    'cluster_cidr                 = "10.200.0.0/16"',
    'service_cidr                 = "10.201.0.0/22"',
):
    if guard not in q01_terraform_main:
        raise SystemExit(f"q01 Terraform lost cluster ownership gate: {guard}")
if re.search(r"^\s*(?:versioning_enable|multi_az)\s*=", q01_terraform_main, re.M):
    raise SystemExit("q01 Terraform must not own lossy COS versioning or multi_az fields")
if any(name in q01_terraform_main for name in ("np-control0", "np-runtime0", "np-fdb0")):
    raise SystemExit("q01 Terraform must not compete with TKE MachineSet capacity ownership")
if 'version = "1.83.11"' not in q01_terraform_versions:
    raise SystemExit("q01 Terraform must pin the reviewed Tencent provider")
for guard in (
    'resource "tencentcloud_cam_policy" "release_hook_exact_tat"',
    '"name/tat:InvokeCommand"',
    '"name/tat:DescribeInvocationTasks"',
    '"qcs:resource_tag" = ["actor-release-approved&true"]',
    'instance/${var.release_builder_instance_id}',
    'resource "tencentcloud_cam_role" "release_hook_exact_tat"',
    '"oidc:aud" = ["sts.cloud.tencent.com"]',
    '"oidc:sub" = ["system:serviceaccount:actor-release-system:actor-release-hook"]',
):
    if guard not in q01_terraform_main:
        raise SystemExit(f"q01 Terraform lost release Hook least-privilege identity: {guard}")
if re.search(r'variable "release_builder_instance_id"\s*\{[^}]*\bdefault\s*=', q01_terraform_variables, re.S):
    raise SystemExit("q01 Terraform must require the exact current release builder on every plan")
for guard in (
    'evidence = "actor-qualification-evidence-prod-bj-q01-nv1-1388575217"',
    'each.key == "evidence" ? "qualification-evidence"',
):
    if guard not in (q01_terraform_variables + q01_terraform_main):
        raise SystemExit(f"q01 Terraform lost durable qualification evidence ownership: {guard}")
release_hook_policy = q01_terraform_main.split(
    'resource "tencentcloud_cam_policy" "release_hook_exact_tat"', 1
)[1].split('resource "tencentcloud_cam_role" "release_hook_exact_tat"', 1)[0]
if any(action in release_hook_policy for action in (
    "tat:RunCommand", "tat:CreateCommand", "tat:ModifyCommand"
)):
    raise SystemExit("release Hook CAM policy regained arbitrary command publication authority")
release_service_account = next(
    document for document in gitops_bootstrap
    if document.get("kind") == "ServiceAccount"
)
if release_service_account.get("metadata", {}).get("name") != "actor-release-hook":
    raise SystemExit("release bootstrap lost its exact ServiceAccount identity")
if release_service_account.get("automountServiceAccountToken") is not False:
    raise SystemExit("release ServiceAccount must not receive the default Kubernetes token mount")
release_project_kinds = {
    (entry.get("group", ""), entry.get("kind", ""))
    for entry in gitops_project.get("spec", {}).get("namespaceResourceWhitelist", [])
}
if ("", "ServiceAccount") in release_project_kinds or ("", "Secret") in release_project_kinds:
    raise SystemExit("release Application must not own identity or credentials")
release_role = next(document for document in gitops_release_rbac if document.get("kind") == "Role")
release_binding = next(document for document in gitops_release_rbac if document.get("kind") == "RoleBinding")
allowed_release_resources = {
    (tuple(rule.get("apiGroups", [])), tuple(rule.get("resources", [])))
    for rule in release_role.get("rules", [])
}
if any(
    resource in {"secrets", "serviceaccounts", "pods", "deployments", "statefulsets", "nodes", "machines"}
    for rule in release_role.get("rules", [])
    for resource in rule.get("resources", [])
):
    raise SystemExit("Argo release Role exceeded ConfigMap/PVC/Job ownership")
if not any("jobs" in resources for _, resources in allowed_release_resources):
    raise SystemExit("Argo release Role cannot execute release Hooks")
subjects = release_binding.get("subjects", [])
if subjects != [{"kind": "ServiceAccount", "name": "argocd-application-controller", "namespace": "argocd"}]:
    raise SystemExit("Argo release RoleBinding lost its exact controller identity")
for guard in (
    "QUALIFICATION_CLUSTER_ID must name the reviewed existing q01 cluster",
    "tf import",
    "/data/agents/cloud/tencent-beijing-qualification/state",
):
    if guard not in q01_terraform_importer:
        raise SystemExit(f"q01 Terraform importer lost gate: {guard}")
if re.search(r"\btf\s+apply\b|\bterraform\s+apply\b", q01_terraform_importer):
    raise SystemExit("q01 import-first workflow must never apply automatically")
for guard in (
    "autonomy-audit-${cell}-${ts}.json",
    "autonomy-control-${cell}-${ts}.json",
    "CELL is not a safe receipt path component",
):
    if guard not in autonomy_governance:
        raise SystemExit(f"multi-Cell autonomy receipt isolation lost guard: {guard}")
q01_fdb = q01_profile["spec"]["foundationDB"]
if (
    q01_fdb["processCount"] != 9
    or q01_fdb["coordinatorCount"] != 9
    or q01_fdb["redundancyMode"] != "three_data_hall"
    or q01_fdb["autoscaling"]["minProcessCount"] != 9
    or q01_fdb["autoscaling"]["maxProcessCount"] != 30
    or q01_cell["spec"]["managementCluster"] != "cls-ike1rebd"
):
    raise SystemExit("q01 Cell lost its nine-process three-data-hall qualification contract")
q01_digest = "sha256:" + hashlib.sha256(
    json.dumps(q01_profile["spec"], sort_keys=True, separators=(",", ":")).encode()
).hexdigest()
if q01_class["spec"]["profileRef"]["digest"] != q01_digest:
    raise SystemExit("q01 ShardClass profile digest is stale")
for guard in (
    '"DELETE", object_path(endpoint, object_id)',
    'cleanup_results = delete_many(api_forward.endpoint, object_ids, args.concurrency)',
    'receipt["failure_cleanup"]',
    'if cleanup_status != 204:',
):
    if guard not in q01_load_driven_soak:
        raise SystemExit(f"q01 load-driven soak lost exact object cleanup: {guard}")

q01_backup_spec = q01_backup["spec"]
q01_blob = q01_backup_spec["blobStoreConfiguration"]
if (
    q01_backup["metadata"]["name"] != "actor-bj-q01-continuous"
    or q01_backup_spec["clusterName"] != "actor-bj-q01"
    or q01_backup_spec["tag"] != "actor-bj-q01-continuous"
    or q01_blob["accountName"]
    != "@actor-fdb-backup-prod-bj-q01-nv1-1388575217.cos.ap-beijing.myqcloud.com"
    or q01_blob["bucket"]
    != "actor-fdb-backup-prod-bj-q01-nv1-1388575217"
    or q01_blob["backupName"]
    != "actor/qualification/ap-beijing/bj-q01/foundationdb/continuous"
):
    raise SystemExit("q01 continuous backup must bind every database and COS identity to q01")
if "k01" in json.dumps(q01_backup):
    raise SystemExit("q01 continuous backup contains a production k01 identity")

q01_host_drain_spec = q01_host_drain["spec"]
q01_host_drain_container = q01_host_drain_spec["template"]["spec"]["containers"][0]
q01_host_drain_env = {
    item["name"]: item.get("value") for item in q01_host_drain_container["env"]
}
if (
    q01_host_drain["metadata"]["name"] != "actor-bj-q01-host-drain"
    or q01_host_drain_spec["replicas"] != 1
    or q01_host_drain_spec["strategy"] != {"type": "Recreate"}
    or q01_host_drain_container["image"] != "__RIVET_REPORTER_IMAGE__"
    or q01_host_drain_container["command"]
    != ["/usr/local/bin/workerd-host-drain-controller"]
    or q01_host_drain_env.get("HOST_DRAIN_MIN_REPLICAS") != "3"
):
    raise SystemExit("q01 standalone Host drain lost its singleton, baseline, or image contract")
if not any(
    rule.get("apiGroups") == ["autoscaling"]
    and rule.get("resources") == ["horizontalpodautoscalers"]
    and rule.get("resourceNames") == ["actor-bj-q01-runtime-hosts-actor-capacity"]
    and rule.get("verbs") == ["get"]
    for rule in q01_host_drain_role["rules"]
):
    raise SystemExit("q01 Host drain must read only its exact HPA capacity floor")
for admission_install_guard in (
    '"$script_dir/../../runtime/install-admission-controller.sh"',
    "RUNTIME_CAPACITY_MAX_REPAIR_SURGE=1",
    "RIVET_CELL_NAME=actor-bj-q01",
):
    if admission_install_guard not in q01_autoscaling_installer:
        raise SystemExit(f"q01 autoscaling lost admission-first sequencing: {admission_install_guard}")
if any(
    document.get("metadata", {}).get("name") == "actor-bj-q01-runtime-capacity"
    for document in q01_autoscaling_documents
):
    raise SystemExit("q01 autoscaling must reuse the production admission controller manifest")

for controller_build_guard in (
    "cmd/workerd-runtime-capacity-controller",
    "internal/runtimecapacity",
    "/out/workerd-runtime-capacity-controller",
):
    if controller_build_guard not in controller_dockerfile:
        raise SystemExit(f"controller image lost runtime capacity binary: {controller_build_guard}")
for controller_base_arg in ("ARG ACTOR_FLEET_BUILD_IMAGE", "ARG ACTOR_FLEET_RUNTIME_IMAGE"):
    if controller_base_arg not in controller_dockerfile:
        raise SystemExit(f"controller Dockerfile lost inventory-provided base: {controller_base_arg}")
if "tencentcloudcr.com/actor-fleet/" in controller_dockerfile:
    raise SystemExit("controller Dockerfile must not retain a historical base digest")
for registry_base_arg in ("ARG WORKER_REGISTRY_BUILD_IMAGE", "ARG WORKER_REGISTRY_RUNTIME_IMAGE"):
    if registry_base_arg not in worker_registry_dockerfile:
        raise SystemExit(f"Worker Registry Dockerfile lost inventory-provided base: {registry_base_arg}")
if "golang:1.25.4" in worker_registry_dockerfile or "gcr.io/distroless" in worker_registry_dockerfile:
    raise SystemExit("Worker Registry Dockerfile retained a public mutable base default")
if "go test -tags=fdb ./internal/workerregistry" not in worker_registry_dockerfile:
    raise SystemExit("Worker Registry production build lost its FDB-backed tests")
if "ENV LD_LIBRARY_PATH=/opt/foundationdb/usr/lib" not in worker_registry_dockerfile:
    raise SystemExit("Worker Registry build must load its pinned FDB client while running tests")
for dependency_base_guard in (
    "ACTOR_FLEET_BUILD_BASE_IMAGE_TAG",
    "ACTOR_FLEET_BOOTSTRAP_BASE",
    "ACTOR_FLEET_BOOTSTRAP_IMAGE",
    "GO_MOD_SHA256",
    "GO_SUM_SHA256",
    "sha256sum --check .actor-source/RELEASE_SHA256SUMS",
    "buildah push",
):
    if dependency_base_guard not in controller_base_builder:
        raise SystemExit(f"controller dependency-base build lost provenance guard: {dependency_base_guard}")
if "FROM ${ACTOR_FLEET_BOOTSTRAP_IMAGE}" not in controller_base_dockerfile:
    raise SystemExit("controller dependency-base build must use its inventory-provided bootstrap image")
if "tencentcloudcr.com/actor-fleet/base-golang@" in controller_base_dockerfile or "FROM golang" in controller_base_dockerfile:
    raise SystemExit("controller dependency-base Dockerfile retained a historical or public base")
if "GOPROXY=https://mirrors.tencent.com/go/" not in controller_base_dockerfile:
    raise SystemExit("controller dependency-base build must use the Tencent-local Go module mirror")
if "--enable-ocm-provider=false" not in (root / "controller" / "deployment.yaml").read_text():
    raise SystemExit("Hub controller must explicitly disable its unavailable OCM provider")
if "--enable-external-provider=true" not in (root / "controller" / "deployment.yaml").read_text():
    raise SystemExit("Hub controller must explicitly enable Terraform/Argo Cell adoption")
if "--enable-ocm-provider=false" not in (root / "controller-fdb-operator" / "kustomization.yaml").read_text():
    raise SystemExit("Cell-local FDB controller must explicitly disable the unavailable OCM provider")
if "--enable-external-provider=false" not in (root / "controller-fdb-operator" / "kustomization.yaml").read_text():
    raise SystemExit("Cell-local FDB controller must explicitly disable central Cell adoption")
for controller_release_identity_guard in (
    "ACTOR_SOURCE_MANIFEST_FILE",
    'sha256sum --check "$source_manifest"',
    'SOURCE_REVISION=$source_revision',
    'SOURCE_MANIFEST_SHA256=$manifest_sha',
    "org.opencontainers.image.revision",
    "fleet.actor.dev/source-manifest-sha256",
    'buildah inspect "$image_tag"',
    'buildah push --authfile "$auth_file" --digestfile "$digest_file"',
    'buildah pull --quiet --authfile "$auth_file" "$build_base"',
    '"fleet.actor.dev/go-mod-sha256": sys.argv[1]',
    '"fleet.actor.dev/go-sum-sha256": sys.argv[2]',
):
    if controller_release_identity_guard not in controller_builder:
        raise SystemExit(
            "controller build lost immutable source identity gate: "
            f"{controller_release_identity_guard}"
        )
for builder_name, builder in (
    ("controller", controller_builder),
    ("runtime", runtime_builder),
    ("loadgen", loadgen_builder),
):
    for bundled_identity_guard in (".actor-source/SOURCE_REVISION", ".actor-source/RELEASE_SHA256SUMS"):
        if bundled_identity_guard not in builder:
            raise SystemExit(f"{builder_name} build lost bundled source identity: {bundled_identity_guard}")
for builder_name, builder in (
    ("controller", controller_builder),
    ("runtime", runtime_builder),
    ("loadgen", loadgen_builder),
    ("workers-api", workers_api_builder),
    ("worker-registry", worker_registry_builder),
    ("release-hook", release_hook_builder),
):
    for receipt_guard in ("ACTOR_PRODUCT_BUILD_RECEIPT", "record-product-image.py"):
        if receipt_guard not in builder:
            raise SystemExit(f"{builder_name} build lost cold-pull product receipt gate: {receipt_guard}")

q01_hpa_spec = q01_workerd_hpa["spec"]
q01_hpa_metric = q01_hpa_spec["metrics"][0]
if (
    q01_workerd_hpa["metadata"]["name"]
    != "actor-bj-q01-runtime-hosts-actor-capacity"
    or q01_hpa_spec["minReplicas"] != 3
    or q01_hpa_spec["maxReplicas"] != 30
    or q01_hpa_spec["scaleTargetRef"]
    != {
        "apiVersion": "apps/v1",
        "kind": "StatefulSet",
        "name": "actor-bj-q01-runtime-hosts",
    }
    or q01_hpa_spec["behavior"]["scaleDown"].get("selectPolicy") != "Disabled"
    or q01_hpa_metric
    != {
        "type": "External",
        "external": {
            "metric": {
                "name": "rivet_workerd_active_actors_total",
                "selector": {"matchLabels": {"cell": "actor-bj-q01"}},
            },
            "target": {"type": "AverageValue", "averageValue": "16"},
        },
    }
):
    raise SystemExit("q01 workerd HPA lost its bounded, warm-headroom, scale-up-only contract")
scale_up = q01_hpa_spec["behavior"]["scaleUp"]
if scale_up.get("stabilizationWindowSeconds") != 0 or scale_up.get("selectPolicy") != "Min" or {
    (policy["type"], policy["value"], policy["periodSeconds"])
    for policy in scale_up["policies"]
} != {("Pods", 6, 60), ("Percent", 100, 60)}:
    raise SystemExit("q01 workerd HPA scale-up must cap Envoy admission at six Hosts per minute")
if q01_adapter_values.get("replicas") != 2:
    raise SystemExit("q01 custom-metrics adapter must tolerate one Pod loss")
adapter_rules = q01_adapter_values["rules"]
if adapter_rules.get("default") is not False or adapter_rules.get("custom") != []:
    raise SystemExit("q01 Adapter must disable default and custom metric discovery")
if len(adapter_rules.get("external", [])) != 1:
    raise SystemExit("q01 Adapter must publish exactly one external Actor metric")
adapter_rule = adapter_rules["external"][0]
if (
    adapter_rule["name"].get("as") != "rivet_workerd_active_actors_total"
    or "rivet_workerd_active_actors" not in adapter_rule["seriesQuery"]
    or adapter_rule.get("metricsQuery") != "sum(<<.Series>>{<<.LabelMatchers>>})"
):
    raise SystemExit("q01 external-metrics adapter must expose only total Actor occupancy")
if observability_values["alertmanager"]["enabled"] is not False or observability_values["nodeExporter"]["enabled"] is not False:
    raise SystemExit("the initial cluster stack must not deploy Alertmanager or node exporter")
prometheus_spec = observability_values["prometheus"]["prometheusSpec"]
if prometheus_spec["replicas"] != 1 or prometheus_spec["shards"] != 1:
    raise SystemExit("the initial cluster stack must use one Prometheus replica and shard")
if prometheus_spec["retention"] != "15d" or prometheus_spec["retentionSize"] != "85GB":
    raise SystemExit("Prometheus retention must remain bounded below its retained CBS volume")
if prometheus_spec["storageSpec"]["volumeClaimTemplate"]["spec"]["resources"]["requests"]["storage"] != "100Gi":
    raise SystemExit("Prometheus must retain a 100Gi CBS claim")
grafana = observability_values["grafana"]
if grafana["persistence"]["size"] != "10Gi" or grafana["persistence"]["type"] != "sts":
    raise SystemExit("Grafana must retain its state on a 10Gi StatefulSet claim")
if grafana["ingress"]["enabled"] is not False or grafana["service"]["type"] != "ClusterIP":
    raise SystemExit("Grafana must remain internal-only by default")
if not grafana["admin"].get("existingSecret"):
    raise SystemExit("Grafana admin credentials must come from a preserved Secret")
for component, affinity in (
    ("Grafana", grafana["affinity"]),
    ("Prometheus", prometheus_spec["affinity"]),
    ("Prometheus Operator", observability_values["prometheusOperator"]["affinity"]),
    ("kube-state-metrics", observability_values["kube-state-metrics"]["affinity"]),
):
    expressions = affinity["nodeAffinity"]["requiredDuringSchedulingIgnoredDuringExecution"]["nodeSelectorTerms"][0]["matchExpressions"]
    if {"key": "fleet.actor.dev/fdb-dedicated", "operator": "DoesNotExist"} not in expressions:
        raise SystemExit(f"{component} may schedule on FDB-dedicated nodes")

storage_class = next(document for document in observability_documents if document.get("kind") == "StorageClass")
if storage_class["reclaimPolicy"] != "Retain" or storage_class["volumeBindingMode"] != "WaitForFirstConsumer":
    raise SystemExit("observability CBS must use retained, topology-aware provisioning")
metrics_service = next(document for document in observability_documents if document.get("kind") == "Service")
if metrics_service["spec"]["selector"] != {"fleet.actor.dev/component": "engine"}:
    raise SystemExit("Engine metrics discovery must stay bounded to Engine Pods")
if metrics_service["spec"]["ports"][0]["targetPort"] != 6430:
    raise SystemExit("Engine Prometheus endpoint must stay on TCP 6430")
service_monitor = next(
    document for document in observability_documents
    if document.get("kind") == "ServiceMonitor"
    and document.get("metadata", {}).get("name") == "actor-fleet-engine"
)
endpoint = service_monitor["spec"]["endpoints"][0]
monitor_spec = service_monitor["spec"]
if (
    endpoint["interval"] != "30s"
    or monitor_spec["sampleLimit"] > 50000
    or monitor_spec["targetLimit"] > 100
    or monitor_spec["labelLimit"] > 50
    or monitor_spec["bodySizeLimit"] != "5MB"
):
    raise SystemExit("Engine scraping lost its low-overhead bounds")
for relabel in endpoint.get("relabelings", []):
    target_label = relabel.get("targetLabel", "")
    if re.search(r"actor|database|branch|bucket|request|object", target_label, re.IGNORECASE):
        raise SystemExit("Engine target discovery introduced a high-cardinality identity label")
stateless_monitor = next(
    document for document in observability_documents
    if document.get("kind") == "ServiceMonitor"
    and document.get("metadata", {}).get("name") == "actor-stateless-executor"
)
stateless_endpoint = stateless_monitor["spec"]["endpoints"][0]
if (
    stateless_monitor["spec"].get("namespaceSelector", {}).get("matchNames")
    != ["actor-stateless-system"]
    or
    stateless_monitor["spec"].get("selector", {}).get("matchLabels")
    != {
        "fleet.actor.dev/component": "stateless-executor",
        "app.kubernetes.io/name": "actor-stateless-executor",
    }
    or stateless_endpoint.get("path") != "/metrics"
    or stateless_endpoint.get("interval") != "15s"
    or stateless_endpoint.get("scrapeTimeout") != "5s"
    or stateless_monitor["spec"].get("sampleLimit") != 1000
    or stateless_monitor["spec"].get("targetLimit") != 1000
    or stateless_monitor["spec"].get("labelLimit") != 30
    or stateless_monitor["spec"].get("bodySizeLimit") != "256KB"
):
    raise SystemExit("stateless executor scrape contract drifted")
stateless_target_labels = {
    relabel.get("targetLabel")
    for relabel in stateless_endpoint.get("relabelings", [])
}
if stateless_target_labels != {"cell", "pod", "node"}:
    raise SystemExit("stateless executor scrape must expose only bounded target identity labels")
adapter_external_rules = observability_adapter_values.get("rules", {}).get("external", [])
stateless_external_metrics = {
    rule.get("name", {}).get("as")
    for rule in adapter_external_rules
    if str(rule.get("name", {}).get("as", "")).startswith("rivet_stateless_")
}
if stateless_external_metrics != {
    "rivet_stateless_in_flight_total",
    "rivet_stateless_peak_in_flight",
    "rivet_stateless_queued_total",
}:
    raise SystemExit("Prometheus Adapter lost the bounded stateless HPA metrics")
stateless_peak_rule = next(
    rule for rule in adapter_external_rules
    if rule.get("name", {}).get("as") == "rivet_stateless_peak_in_flight"
)
if stateless_peak_rule.get("metricsQuery") != (
    "max(<<.Series>>{<<.LabelMatchers>>}) * "
    "count(<<.Series>>{<<.LabelMatchers>>})"
):
    raise SystemExit("stateless peak pressure must preserve the hottest executor")
dashboard = next(document for document in observability_documents if document.get("kind") == "ConfigMap")
dashboard_json = dashboard["data"]["actor-fleet-overview.json"]
dashboard_document = json.loads(dashboard_json)
dashboard_titles = {panel.get("title") for panel in dashboard_document["panels"]}
for title in (
    "无状态 Worker 并发与排队",
    "无状态 Worker 吞吐与过载",
    "无状态代码缓存",
):
    if title not in dashboard_titles:
        raise SystemExit(f"Actor Fleet dashboard lost stateless panel: {title}")
observability_rules = next(document for document in observability_documents if document.get("kind") == "PrometheusRule")
serialized_rules = json.dumps(observability_rules)
stateless_alerts = {
    rule.get("alert")
    for group in observability_rules["spec"]["groups"]
    if group.get("name") == "actor-fleet-stateless-workers"
    for rule in group.get("rules", [])
}
if stateless_alerts != {
    "ActorStatelessExecutorMetricsTargetDown",
    "ActorStatelessQueueSustained",
    "ActorStatelessRequestRejected",
    "ActorStatelessQueueTimedOut",
    "ActorStatelessTransportFailure",
    "ActorStatelessDrainTimedOut",
}:
    raise SystemExit("Actor Fleet alerts lost the stateless execution failure contract")
for metric_name in (
    "sqlite_cold_tier_requests_queued",
    "sqlite_compaction_backlog_bytes",
    "sqlite_compaction_backlog_objects",
    "sqlite_compaction_bytes_total",
    "sqlite_compaction_phase_duration_seconds_bucket",
    "sqlite_compaction_jobs_total",
):
    if metric_name not in dashboard_json + serialized_rules:
        raise SystemExit(f"Actor Fleet observability lost bottleneck metric: {metric_name}")
promql_expressions = [
    target["expr"]
    for panel in dashboard_document["panels"]
    for target in panel.get("targets", [])
]
promql_expressions.extend(
    rule["expr"]
    for group in observability_rules["spec"]["groups"]
    for rule in group["rules"]
    if "expr" in rule
)
for expression in promql_expressions:
    selector_labels = re.findall(r"(?:[,{]\s*)([a-zA-Z_:][a-zA-Z0-9_:]*)\s*(?:=~|!~|!=|=)", expression)
    grouping_labels = [
        label.strip()
        for grouping in re.findall(r"\b(?:by|without)\s*\(([^)]*)\)", expression)
        for label in grouping.split(",")
    ]
    for forbidden_label in ("actor_id", "database_id", "branch_id", "bucket", "object_key"):
        if forbidden_label in selector_labels + grouping_labels:
            raise SystemExit(f"Actor Fleet observability introduced a high-cardinality label: {forbidden_label}")

logical_installer = re.sub(r"\\\n[ \t]*", " ", runtime_installer)
force_commands = [
    line.strip()
    for line in logical_installer.splitlines()
    if line.strip().startswith("kubectl ")
    and "--force-conflicts" in line
    and "--dry-run=server" not in line
]
expected_force_commands = (
    ('runtime-config.yaml"', "--field-manager=rivet-runtime-installer"),
    ('phase-engine.yaml"', "--field-manager=rivet-runtime-installer"),
    ('runtime-release-fields-nats.json"', "--field-manager=rivet-runtime-release-fields"),
    ('runtime-rollout-on-delete.json"', "--field-manager=rivet-runtime-rollout-fence"),
    ('runtime-release-fields-runtime.json"', "--field-manager=rivet-runtime-release-fields"),
    ('phase-runtime.yaml"', "--field-manager=rivet-runtime-installer"),
    ('runtime-release-fields-reporter.json"', "--field-manager=rivet-runtime-release-fields"),
)
if len(force_commands) != len(expected_force_commands) or not all(
    sum(target in command and manager in command for command in force_commands) == 1
    for target, manager in expected_force_commands
):
    raise SystemExit("SSA ownership transfers escaped their exact resource and field-manager scope")
noop_probe_commands = [
    line.strip()
    for line in logical_installer.splitlines()
    if line.strip().startswith("kubectl ")
    and "--field-manager=rivet-runtime-noop-probe" in line
]
if len(noop_probe_commands) != 1 or "--dry-run=server" not in noop_probe_commands[0]:
    raise SystemExit("runtime no-op probe must be one non-mutating server-side dry run")
if 'runtime manifest must begin with the runtime ConfigMap' not in runtime_installer:
    raise SystemExit("runtime ConfigMap extraction must fail closed when manifest ordering changes")
for replica_ownership_guard in (
    '--field-manager=rivet-runtime-replica-handoff',
    'strip-update-owned-fields.py',
):
    if replica_ownership_guard not in runtime_installer:
        raise SystemExit(f"runtime installer lost dynamic replica ownership handoff: {replica_ownership_guard}")
for replica_strip_guard in (
    'existing runtime replica count is invalid',
    'runtime StatefulSet must contain one bootstrap replicas field',
    'expected exactly one runtime StatefulSet while removing update-time replicas',
):
    if replica_strip_guard not in runtime_installer + runtime_update_stripper:
        raise SystemExit(f"runtime update manifest lost replica exclusion: {replica_strip_guard}")
if 'item["spec"].pop("replicas", None)' not in runtime_release:
    raise SystemExit("runtime rollback ownership restore must not reclaim dynamic replicas")
if runtime_release.count('--field-manager="$runtime_rollback_field_manager"') != 6:
    raise SystemExit("runtime rollback updates must use only the isolated rollback field manager")
if runtime_release.count("--field-manager=rivet-runtime-installer") != 1:
    raise SystemExit("runtime rollback ownership restore must use one canonical installer apply")
if 'default_runtime_admission_field_manager=rivet-runtime-admission-installer' not in runtime_release:
    raise SystemExit("runtime release rollback must preserve the dedicated admission field manager")
if runtime_release.count('--field-manager="$runtime_admission_rollback_field_manager"') != 1:
    raise SystemExit("runtime admission update rollback must use its isolated field manager")
if runtime_release.count('--field-manager="$runtime_admission_field_manager"') != 1:
    raise SystemExit("runtime admission ownership restore must use the canonical apply field manager")
if runtime_release.count('--field-manager="$runtime_capacity_recovery_field_manager"') != 2:
    raise SystemExit("capacity recovery must isolate its forward and rollback CAS updates")
if "--field-manager=rivet-runtime-release-fields" in runtime_release:
    raise SystemExit("rollback must not update through the scoped release field manager")
if runtime_release.count("--field-manager=rivet-runtime-release-ledger") != 2:
    raise SystemExit("runtime release must use one ledger publish and one rollback ownership path")
for ledger_guard in (
    'release_ledger_name=${cell_name}-release-ledger',
    'ledger_write_started=true',
    '--source-revision "$source_revision"',
    '--source-manifest-sha256 "$source_manifest_sha"',
    '--reporter-source-revision "$reporter_source_revision"',
    '--reporter-source-manifest-sha256 "$reporter_source_manifest_sha"',
    'fleet.actor.dev/release-receipt-sha256',
):
    if ledger_guard not in runtime_release:
        raise SystemExit(f"runtime release lost static ledger invariant: {ledger_guard}")
for dynamic_runtime_release_guard in (
    'runtime_spec_replicas runtime_ready_replicas runtime_updated_replicas',
    '((runtime_spec_replicas >= 3))',
    '[[ $runtime_ready_replicas == "$runtime_spec_replicas" ]]',
    '[[ $runtime_updated_replicas == "$runtime_spec_replicas" ]]',
    '[[ -n $runtime_current_revision && $runtime_current_revision == "$runtime_update_revision" ]]',
):
    if dynamic_runtime_release_guard not in runtime_release:
        raise SystemExit(
            f"runtime release lost load-safe dynamic replica gate: {dynamic_runtime_release_guard}"
        )
if "runtime-hosts\" -o jsonpath='{.status.readyReplicas}') == 3" in runtime_release:
    raise SystemExit("runtime release must not require the HPA-owned host count to equal three")
if runtime_installer.count("--field-manager=rivet-runtime-release-fields") != 3:
    raise SystemExit("NATS, runtime Host, and reporter ownership migrations need the scoped release manager")
if 'status.get("observedGeneration") != metadata.get("generation")' not in runtime_installer:
    raise SystemExit("runtime serial rollout can select a stale intermediate updateRevision")
if 'if item["name"] == "RELEASE_DIGEST"' not in runtime_installer or '"env": [reporter_release_digest]' not in runtime_installer:
    raise SystemExit("Cell reporter release digest must be included in scoped ownership migration")
for restriction in (
    "runAsNonRoot: true",
    "allowPrivilegeEscalation: false",
    'drop: ["ALL"]',
    "type: RuntimeDefault",
):
    if restriction not in runtime_image_validator:
        raise SystemExit(f"runtime compatibility Job lost PodSecurity restriction: {restriction}")
native_machine_sets = [
    document
    for document in yaml.safe_load_all(subprocess.check_output([
        "kubectl", "kustomize", str(root / "tke-native-nodepool" / "overlays" / "actor-bj-k01")
    ], universal_newlines=True))
    if document
]
runtime_machine_sets = [
    document
    for document in yaml.safe_load_all(subprocess.check_output([
        "kubectl", "kustomize", str(root / "tke-native-runtime-nodepool" / "overlays" / "actor-bj-k01")
    ], universal_newlines=True))
    if document
]
control_machine_sets = [
    document
    for document in yaml.safe_load_all(subprocess.check_output([
        "kubectl", "kustomize", str(root / "tke-native-control-nodepool" / "overlays" / "actor-bj-k01")
    ], universal_newlines=True))
    if document
]

required = {
    "no per-Actor Kubernetes object": "perActorKubernetesObjects: false",
    "CAS capacity reservation": "mode: CAS",
    "new-Actor-only scale out": "onScaleOut: NewActorsOnly",
    "six FDB processes": "processCount: 6",
    "two processes per AZ": "processesPerZone: 2",
    "AZ-aware redundancy": "redundancyMode: three_data_hall",
    "exclusive physical cluster": "exclusiveCluster: true",
    "native runtime": "deploymentMode: native-systemd",
    "three cross-AZ workerd hosts": "minWorkerdHosts: 3",
    "COS outside commit path": "inCommitPath: false",
    "exact-key recovery": "exactKeyRecovery: true",
    "COS versioning never enabled": "versioning: NeverEnabled",
    "ordinary non-multi-AZ COS bucket": "multiAZ: false",
}
for label, needle in required.items():
    if needle not in fleet:
        raise SystemExit(f"missing invariant: {label}: {needle}")

def resource_body(name):
    marker = f"  name: {name}\n"
    if marker not in fleet:
        raise SystemExit(f"missing resource: {name}")
    return fleet.split(marker, 1)[1].split("\n---", 1)[0]

a_body = resource_body("actor-bj-a01")
b_body = resource_body("actor-bj-b01")
a_zones = re.findall(r"zone: (ap-beijing-[678])", a_body)
a_counts = {zone: a_zones.count(zone) for zone in set(a_zones)}
if a_counts != {"ap-beijing-6": 2, "ap-beijing-7": 2, "ap-beijing-8": 1}:
    raise SystemExit(f"unexpected recorded Cell A topology: {a_counts}")
b_zones = re.findall(r"zone: (ap-beijing-[678])", b_body)
b_counts = {zone: b_zones.count(zone) for zone in set(b_zones)}
if b_counts != {"ap-beijing-6": 2, "ap-beijing-7": 2, "ap-beijing-8": 2}:
    raise SystemExit(f"unexpected recorded Cell B topology: {b_counts}")

if "minCells: 2" not in fleet:
    raise SystemExit("a retirement demonstration requires at least two Cells")
for zone in ("ap-beijing-6", "ap-beijing-7", "ap-beijing-8"):
    if terraform.count(f'zone = "{zone}"') < 2:
        raise SystemExit(f"Terraform must place both FDB and runtime capacity in {zone}")
if 'to   = tencentcloud_instance.runtime["b6-1"]' not in terraform:
    raise SystemExit("singleton runtime migration must preserve the existing Beijing-6 CVM")
if "EnvironmentFile=/etc/actor/rivet-workerd/envoy.env" not in host_unit:
    raise SystemExit("workerd host must load its remote Engine/pool identity from envoy.env")
if "Requires=actor-rivet-engine.service" in pool_unit:
    raise SystemExit("workerd-only hosts must not require a local Engine service")
for role in ("engine-and-workerd", "workerd-only"):
    if role not in installer:
        raise SystemExit(f"runtime installer is missing role {role}")
if "reclaimPolicy: Retain" not in storage or "WaitForFirstConsumer" not in storage:
    raise SystemExit("FDB StorageClass must retain data and bind after scheduling")
if "proofRequired: true" not in fleet or "retirementPolicy: ProofRequired" not in fleet:
    raise SystemExit("retirement proof gate is not enabled")
if "desiredState: Qualifying" not in b_body or "clusterIdentityHash: sha256:" not in b_body:
    raise SystemExit("provisioned Cell B must carry its immutable identity and remain Qualifying")
if "x-kubernetes-validations" not in crds:
    raise SystemExit("CRDs lost CEL validation rules")
if "enum: [native-systemd, kubernetes]" not in crds:
    raise SystemExit("RivetCellProfile must accept the Kubernetes runtime mode")
if crds.count("x-kubernetes-list-type: set") != 5 or "uniqueItems: true" in crds:
    raise SystemExit("bounded unique lists must use Kubernetes set semantics, not quadratic uniqueItems")

operator_fdb = operator_profile["spec"]["foundationDB"]
operator_kubernetes = operator_fdb["kubernetes"]
operator_topology = operator_profile["spec"].get("topology")
if operator_fdb["processCount"] != 9 or operator_fdb["coordinatorCount"] != 9:
    raise SystemExit("production Operator profile must use nine hostname fault domains in a 3/3/3 shape")
if "zones" in operator_profile["spec"] or operator_topology != {
    "zoneLabelKey": "topology.kubernetes.io/zone",
    "zoneCount": 3,
    "maxSkew": 1,
    "whenUnsatisfiable": "DoNotSchedule",
}:
    raise SystemExit("Kubernetes Operator topology must be region-portable and use standard hard zone spreading")
if operator_kubernetes["placementMode"] != "DedicatedNodes":
    raise SystemExit("the first production Operator Cell must use dedicated FDB nodes")
if operator_kubernetes["resources"]["cpuRequest"] != operator_kubernetes["resources"]["cpuLimit"] or operator_kubernetes["resources"]["memoryRequest"] != operator_kubernetes["resources"]["memoryLimit"]:
    raise SystemExit("FDB Pods must have Guaranteed QoS through equal requests and limits")
if operator_kubernetes["tls"]["mode"] != "Required":
    raise SystemExit("production Operator profile must require mutual TLS")
if operator_kubernetes["imageTagDigest"] != "7.3.79@sha256:45f5b7632984a4835326f45a7bcfd662886db64d82333796ee14cbb3a7537c8c":
    raise SystemExit("generated FDB data Pods must pin the qualified unified image digest")
if operator_profile["spec"]["runtime"]["deploymentMode"] != "kubernetes":
    raise SystemExit("the Operator-backed production profile must declare its Kubernetes runtime")
canonical_operator_profile = json.dumps(
    operator_profile["spec"], sort_keys=True, separators=(",", ":")
).encode()
expected_operator_digest = "sha256:" + hashlib.sha256(canonical_operator_profile).hexdigest()
if operator_class["spec"]["profileRef"]["digest"] != expected_operator_digest:
    raise SystemExit("Operator ShardClass profile digest is stale")
if "@sha256:" not in operator_manifest or ":latest" in operator_manifest or ":dev" in operator_manifest:
    raise SystemExit("upstream Operator and FDB monitor images must be immutable digests")
if "replicas: 2" not in operator_manifest or "WATCH_NAMESPACE" not in operator_manifest:
    raise SystemExit("operator deployment must be HA and namespace-scoped")
for restriction in (
    "--allowed-service-account-names=fdb-kubernetes",
    "--allowed-additional-volume-sources=secret",
    "--allow-host-network=false",
    "--allow-host-pid=false",
    "--allow-host-ipc=false",
):
    if restriction not in operator_manifest:
        raise SystemExit(f"operator Pod customization is not restricted: {restriction}")
if "priority-class.yaml" not in operator_kustomization or "preemptionPolicy: Never" not in operator_priority:
    raise SystemExit("FDB PriorityClass must be installed and non-preempting")
if "get --raw /version" not in operator_installer:
    raise SystemExit("operator installer must inspect the target Kubernetes server version")
if "raw.githubusercontent.com" in operator_installer or "curl " in operator_installer:
    raise SystemExit("operator installation must not download CRDs at deployment time")
if 'commit = "b543152be5614170a1fa976421238989e9820cde"' not in operator_crd_lock:
    raise SystemExit("vendored operator CRDs lost their exact upstream commit")
for crd_name, crd_sha in {
    "apps.foundationdb.org_foundationdbclusters.yaml": "57511675909ad02345909343efa295e4c28fcfb67c811cb021663a7c03dcd3f1",
    "apps.foundationdb.org_foundationdbbackups.yaml": "2fb8313e25fa58be8a09f8a0cfc04172d80605b92850a523d73031ba8195a266",
    "apps.foundationdb.org_foundationdbrestores.yaml": "499d7feb7d3e553f75b23c77a7e7d9467355703f771284b683ec4f4515ee9c6b",
}.items():
    crd = operator_crd_dir / crd_name
    if not crd.is_file() or hashlib.sha256(crd.read_bytes()).hexdigest() != crd_sha:
        raise SystemExit(f"vendored operator CRD is missing or changed: {crd_name}")
    if f'{crd_name} = "sha256:{crd_sha}"' not in operator_crd_lock:
        raise SystemExit(f"vendored operator CRD lock is stale: {crd_name}")
if "production-cell.example.yaml" in operator_kustomization:
    raise SystemExit("installing the operator must never create a production FDB database")

for required_runtime_fragment in (
    "kind: StatefulSet",
    "replicas: 3",
    "topologyKey: topology.kubernetes.io/zone",
    "whenUnsatisfiable: DoNotSchedule",
    "fleet.actor.dev/control-pool",
    "rivet.dev/compute",
):
    if required_runtime_fragment not in runtime_manifest:
        raise SystemExit(f"runtime deployment lost invariant: {required_runtime_fragment}")
if '"memory"' in runtime_manifest or '"nats"' not in runtime_manifest:
    raise SystemExit("multi-replica Engine must use the shared NATS pubsub, never process-local memory")
runtime_config = next(
    document for document in runtime_documents
    if document.get("kind") == "ConfigMap"
    and document.get("metadata", {}).get("name") == "actor-bj-k01-runtime-config"
)
if runtime_config["metadata"].get("annotations", {}).get(
    "fleet.actor.dev/runtime-profile"
) != "__RIVET_RUNTIME_PROFILE__":
    raise SystemExit("runtime ConfigMap must publish the selected tuning profile")
runtime_config_text = runtime_config.get("data", {}).get("config.jsonc", "")
for config_guard in (
    '"workflow_write_debt"',
    '"target_bytes": __RIVET_FDB_WRITE_DEBT_TARGET_BYTES__',
    '"limit_bytes": __RIVET_FDB_WRITE_DEBT_LIMIT_BYTES__',
    '"slot_jitter": __RIVET_ENVOY_SLOT_JITTER__',
    '"envoy_allocation_max_in_flight_per_pool": __RIVET_ENVOY_ALLOCATION_MAX_IN_FLIGHT_PER_POOL__',
):
    if config_guard not in runtime_config_text:
        raise SystemExit(f"runtime ConfigMap lost write-debt tuning: {config_guard}")
runtime_statefulset = next(
    document for document in runtime_documents
    if document.get("kind") == "StatefulSet"
    and document.get("metadata", {}).get("name") == "actor-bj-k01-runtime-hosts"
)
runtime_spec = runtime_statefulset["spec"]
if runtime_spec.get("replicas") != 3 or runtime_spec.get("podManagementPolicy") != "Parallel":
    raise SystemExit("runtime hosts must retain three stable operational slots")
if runtime_spec.get("volumeClaimTemplates"):
    raise SystemExit("runtime host local state is disposable and must not claim durable storage")
if "RIVET_ENVOY_KEY" in runtime_manifest:
    raise SystemExit("runtime host identity must be a fresh process UUID, not a Pod-derived key")
nats_statefulset = next(
    document for document in nats_documents
    if document.get("kind") == "StatefulSet"
    and document.get("metadata", {}).get("name") == "actor-bj-k01-nats"
)
nats_spec = nats_statefulset["spec"]
if nats_spec.get("replicas") != 3 or nats_spec.get("podManagementPolicy") != "Parallel":
    raise SystemExit("NATS must retain three parallel, cross-zone members")
if nats_spec.get("volumeClaimTemplates"):
    raise SystemExit("core NATS is an ephemeral message plane and must not claim durable storage")
nats_pod_spec = nats_spec["template"]["spec"]
nats_anti_affinity = nats_pod_spec["affinity"]["podAntiAffinity"][
    "requiredDuringSchedulingIgnoredDuringExecution"
]
if {term.get("topologyKey") for term in nats_anti_affinity} != {
    "kubernetes.io/hostname",
    "topology.kubernetes.io/zone",
}:
    raise SystemExit("NATS members must use hard hostname and zone anti-affinity")
nats_container = nats_pod_spec["containers"][0]
if nats_container.get("image") != "__RIVET_NATS_IMAGE__":
    raise SystemExit("NATS image must remain an installer-supplied immutable digest")
nats_service = next(
    document for document in nats_documents
    if document.get("kind") == "Service"
    and document.get("metadata", {}).get("name") == "actor-bj-k01-nats"
)
if nats_service["spec"].get("clusterIP") != "None" or nats_service["spec"].get("publishNotReadyAddresses") is not True:
    raise SystemExit("NATS requires a headless bootstrap Service with stable pre-ready DNS")
nats_pdb = next(
    document for document in nats_documents
    if document.get("kind") == "PodDisruptionBudget"
    and document.get("metadata", {}).get("name") == "actor-bj-k01-nats"
)
if nats_pdb["spec"].get("minAvailable") != 2:
    raise SystemExit("NATS PDB must retain two of three members")
if nats_manifest.count("nats://actor-bj-k01-nats-") != 3 or "connect_retries: 120" not in nats_manifest:
    raise SystemExit("NATS must bootstrap from all three stable StatefulSet identities")
for installer_guard in (
    "RIVET_NATS_IMAGE",
    'statefulset/"${cell_name}-nats"',
    "NATS did not form a three-member route mesh",
    'get("num_routes", 0) >= 2',
    "wait_for_engine_nats_clients",
    "Engine NATS clients ready",
    "verify-engine-nats-clients.py",
    "Engine did not establish a NATS connection for every exact Ready Pod",
    "partial Engine/runtime-hosts/NATS topology",
    'partition-nats-manifest.py',
):
    if installer_guard not in runtime_installer:
        raise SystemExit(f"runtime installer lost NATS rollout gate: {installer_guard}")
for verifier_guard in (
    'labels.get("fleet.actor.dev/component") != "engine"',
    'status.get("podIP", "")',
    "if started >= required[address]",
    "not every Ready Engine Pod has a live NATS connection",
):
    if verifier_guard not in engine_nats_verifier:
        raise SystemExit(f"Engine NATS identity verifier lost guard: {verifier_guard}")
engine_rollout = runtime_installer.index('rollout status deployment/"${cell_name}-engine"')
engine_nats_gate = runtime_installer.index("wait_for_engine_nats_clients", engine_rollout)
engine_apply = runtime_installer.index('-f "$temporary/phase-engine.yaml"')
nats_release_handoff = runtime_installer.index(
    '-f "$temporary/runtime-release-fields-nats.json"', engine_nats_gate
)
deferred_nats = runtime_installer.index(
    '-f "$temporary/nats-statefulset.yaml"', nats_release_handoff
)
host_rollout = runtime_installer.index('-f "$temporary/phase-runtime.yaml"', deferred_nats)
if not engine_apply < engine_rollout < engine_nats_gate < nats_release_handoff < deferred_nats < host_rollout:
    raise SystemExit("existing Cell rollout must converge Engine before NATS before Host")
if 'runtime-release-fields-engine.json"' in runtime_installer[runtime_installer.index("# Apply release-owned workloads"):]:
    raise SystemExit("Engine rollout must not create a partial-template intermediate ReplicaSet")
engine_deployment = next(
    document for document in runtime_documents
    if document.get("kind") == "Deployment"
    and document.get("metadata", {}).get("name") == "actor-bj-k01-engine"
)
engine_spec = engine_deployment["spec"]
if engine_spec.get("replicas") != 6 or engine_spec.get("strategy") != {
    "type": "RollingUpdate",
    "rollingUpdate": {"maxUnavailable": 0, "maxSurge": 1},
}:
    raise SystemExit("Engine must retain six ready replicas while surging one replacement")
if (
    'str(rolling.get("maxUnavailable")) != "0"' not in engine_ha_qualifier
    or 'str(rolling.get("maxSurge")) != "1"' not in engine_ha_qualifier
    or "qualified unavailable=0/surge=1 policy" not in engine_ha_qualifier
):
    raise SystemExit("Engine HA qualifier rollout policy drifted from the runtime manifest")
engine_container = engine_spec["template"]["spec"]["containers"][0]
engine_resources = engine_container.get("resources", {})
if engine_resources.get("requests", {}).get("cpu") != "4" or engine_resources.get("limits", {}).get("cpu") != "6":
    raise SystemExit("Engine must reserve four cores and retain a bounded six-core burst envelope")
engine_pre_stop = engine_container.get("lifecycle", {}).get("preStop", {}).get("exec", {}).get("command")
if engine_pre_stop[:2] != ["/bin/sh", "-ec"]:
    raise SystemExit("Engine preStop must execute its explicit graceful-shutdown protocol")
if not all(fragment in engine_pre_stop[2] for fragment in (
    "touch /tmp/actor-engine-draining", "sleep 30",
)) or "kill -TERM 1" in engine_pre_stop[2] or "kill -0 1" in engine_pre_stop[2]:
    raise SystemExit("Engine preStop must fence readiness and return after endpoint propagation")
subprocess.run(["sh", "-n", "-c", engine_pre_stop[2]], check=True)
if engine_spec["template"]["spec"].get("terminationGracePeriodSeconds") != 150:
    raise SystemExit("Engine must bound endpoint propagation plus graceful shutdown to 150 seconds")
engine_readiness = engine_container.get("readinessProbe", {})
if engine_readiness.get("periodSeconds") != 1 or engine_readiness.get("failureThreshold") != 1:
    raise SystemExit("Engine draining readiness fence must converge within one probe period")
engine_readiness_command = engine_readiness.get("exec", {}).get("command", [])
if engine_readiness_command[:2] != ["/bin/sh", "-ec"] or "/tmp/actor-engine-draining" not in engine_readiness_command[2]:
    raise SystemExit("Engine readiness must reject the Pod-scoped draining marker")
engine_affinity = engine_spec["template"]["spec"]["affinity"]
engine_spread = engine_spec["template"]["spec"].get("topologySpreadConstraints")
engine_anti_affinity = engine_affinity.get("podAntiAffinity", {}).get(
    "preferredDuringSchedulingIgnoredDuringExecution", []
)
if {term.get("podAffinityTerm", {}).get("topologyKey") for term in engine_anti_affinity} != {
    "kubernetes.io/hostname",
    "topology.kubernetes.io/zone",
}:
    raise SystemExit("Engine replicas must prefer hostname and zone separation without blocking rollout surge")

def requires_node_label(pod_spec, key):
    expressions = pod_spec["affinity"]["nodeAffinity"]["requiredDuringSchedulingIgnoredDuringExecution"]["nodeSelectorTerms"][0]["matchExpressions"]
    return {"key": key, "operator": "In", "values": ["true"]} in expressions

engine_pod_spec = engine_spec["template"]["spec"]
if not requires_node_label(engine_pod_spec, "fleet.actor.dev/control-pool"):
    raise SystemExit("Engine must be pinned to the physical control node pool")
if engine_spread != [{
    "maxSkew": 1,
    "minDomains": 3,
    "topologyKey": "topology.kubernetes.io/zone",
    "whenUnsatisfiable": "DoNotSchedule",
    "labelSelector": {"matchLabels": {
        "fleet.actor.dev/cell-name": "actor-bj-k01",
        "fleet.actor.dev/component": "engine",
    }},
}]:
    raise SystemExit("Engine replicas must use hard, region-portable three-zone spreading")
engine_pdb = next(
    document for document in runtime_documents
    if document.get("kind") == "PodDisruptionBudget"
    and document.get("metadata", {}).get("name") == "actor-bj-k01-engine"
)
if engine_pdb["spec"].get("minAvailable") != 4 or "maxUnavailable" in engine_pdb["spec"]:
    raise SystemExit("Engine PDB must retain four of six steady replicas")
nats_statefulset = next(
    document for document in nats_documents
    if document.get("kind") == "StatefulSet"
    and document.get("metadata", {}).get("name") == "actor-bj-k01-nats"
)
if not requires_node_label(nats_statefulset["spec"]["template"]["spec"], "fleet.actor.dev/control-pool"):
    raise SystemExit("NATS must be pinned to the physical control node pool")
workerd_statefulset = next(
    document for document in runtime_documents
    if document.get("kind") == "StatefulSet"
    and document.get("metadata", {}).get("name") == "actor-bj-k01-runtime-hosts"
)
workerd_pod_spec = workerd_statefulset["spec"]["template"]["spec"]
if not requires_node_label(workerd_pod_spec, "rivet.dev/compute"):
    raise SystemExit("Actor runtime hosts must be pinned to the physical compute node pool")
if not requires_node_label(workerd_pod_spec, "fleet.actor.dev/runtime-admitted"):
    raise SystemExit("Actor runtime hosts must require exact runtime Node admission")
runtime_machine_set_terms = [
    expression
    for term in workerd_pod_spec["affinity"]["nodeAffinity"]["requiredDuringSchedulingIgnoredDuringExecution"]["nodeSelectorTerms"]
    for expression in term.get("matchExpressions", [])
    if expression.get("key") == "node.tke.cloud.tencent.com/machineset"
]
if runtime_machine_set_terms != [{
    "key": "node.tke.cloud.tencent.com/machineset",
    "operator": "In",
    "values": ["__RIVET_RUNTIME_MACHINE_SET__"],
}]:
    raise SystemExit("Actor runtime hosts lost the exact rendered MachineSet fence")
if workerd_pod_spec.get("tolerations") != [{
    "key": "rivet.dev/compute", "operator": "Equal", "value": "true", "effect": "NoSchedule"
}]:
    raise SystemExit("Actor runtime hosts may tolerate only the compute isolation taint")
if '"$script_dir/install-admission-controller.sh"' not in runtime_installer:
    raise SystemExit("runtime installer must converge exact Node admission before applying workerd")
if 'node.tke.cloud.tencent.com/machineset=${RUNTIME_MACHINE_SET:-np-runtime0}' not in runtime_installer:
    raise SystemExit("runtime release admission gate must inspect only its active MachineSet")
for topology_mode_guard in (
    "production-multi-zone) required_topology_zones=3",
    "qualification-single-zone) required_topology_zones=1",
    '"$runtime_install_required_nodes" "$required_topology_zones"',
):
    if topology_mode_guard not in runtime_installer:
        raise SystemExit(f"runtime installer lost admitted-subset topology guard: {topology_mode_guard}")
if 'RUNTIME_CAPACITY_MAX_REPAIR_SURGE="$runtime_repair_surge"' not in runtime_installer:
    raise SystemExit("runtime installer does not preserve the Cell repair-surge contract")
if 'if [[ $runtime_profile == production && $cell_reporter_mode == enabled ]]' not in runtime_installer:
    raise SystemExit("production Reporter source identity is still gated by one historical Cell name")
if (
    'if [[ $runtime_profile == production && $cell_name =~ ^actor-[a-z0-9]+-[a-z][0-9]{2}$' not in runtime_release
    or 'production Cell releases must resolve Gasoline retention from the bound StorageProfile' not in runtime_release
):
    raise SystemExit("production Gasoline retention is not enforced for every production Cell")
if runtime_admission_installer.count("apply --server-side --force-conflicts") != 2:
    raise SystemExit("runtime admission installer must canonically reclaim SSA ownership in dry-run and apply")
runtime_admission_controller = next(
    document for document in runtime_admission_documents
    if document.get("kind") == "Deployment"
)
runtime_admission_env = {
    item["name"]: item.get("value")
    for item in runtime_admission_controller["spec"]["template"]["spec"]["containers"][0]["env"]
    if "name" in item
}
if runtime_admission_env.get("RUNTIME_CAPACITY_TARGETED_REPAIR_ENABLED") != "__TARGETED_REPAIR_ENABLED__":
    raise SystemExit("runtime Machine repair template lost its explicit qualification-gated switch")
if runtime_admission_env.get("RUNTIME_EXACT_SCALE_DOWN_ENABLED") != "__EXACT_SCALE_DOWN_ENABLED__":
    raise SystemExit("runtime capacity template lost exact provider scale-down switch")
if runtime_admission_env.get("RUNTIME_TKE_CLUSTER_ID") != "__TKE_CLUSTER_ID__":
    raise SystemExit("runtime capacity template lost its provider cluster identity")
if runtime_admission_env.get("RUNTIME_CAPACITY_MAX_REPAIR_SURGE") != "__MAX_REPAIR_SURGE__":
    raise SystemExit("runtime admission template lost its explicit repair-surge bound")
if runtime_admission_env.get("RUNTIME_CAPACITY_REQUIRED_ZONES") != "3":
    raise SystemExit("runtime capacity controller lost its exact three-zone self-healing contract")
for hold_guard in (
    "fleet.actor.dev/runtime-capacity-qualification-hold",
    '"op": "test", "path": "/metadata/uid"',
    '"op": "test", "path": "/metadata/resourceVersion"',
):
    if hold_guard not in q01_machine_repair_qualification:
        raise SystemExit(f"runtime Machine repair qualification lost its scale-down CAS hold: {hold_guard}")
runtime_admission_cluster_role = next(
    document for document in runtime_admission_documents
    if document.get("kind") == "ClusterRole"
)
machine_rule = next(
    rule for rule in runtime_admission_cluster_role["rules"]
    if rule.get("resources") == ["machines"]
)
if machine_rule.get("verbs") != ["__MACHINE_VERBS__"]:
    raise SystemExit("runtime Machine RBAC is not rendered by the qualification-gated installer")
for repair_gate in (
    '[[ $cell_name =~ ^actor-[a-z0-9]+-[a-z][0-9]{2}$ && $machine_set == np-runtime0 ]]',
    '[[ $max_repair_surge == 1 ]]',
    'verify-runtime-machine-repair-receipt.py',
    '--expected-cell "$cell_name" --expected-machine-set "$machine_set"',
    'machine_verbs="get, list, patch, delete"',
    'RUNTIME_MACHINE_REPAIR_QUALIFICATION_RECEIPT',
):
    if repair_gate not in runtime_admission_installer:
        raise SystemExit(f"automatic runtime Machine repair lost promotion gate: {repair_gate}")
for exact_scale_down_gate in (
    '[[ $cell_name =~ ^actor-[a-z0-9]+-[a-z][0-9]{2}$ && $machine_set == np-runtime0 ]]',
    'RUNTIME_EXACT_SCALE_DOWN_ENABLED',
    'RUNTIME_TKE_CLUSTER_ID',
    'RUNTIME_TKE_OIDC_ROLE_ARN',
    'TKE_ROLE_ARN',
    'TKE_PROVIDER_ID',
    'TKE_WEB_IDENTITY_TOKEN_FILE',
    'serviceAccountToken:',
    'sts.cloud.tencent.com',
):
    if exact_scale_down_gate not in runtime_admission_installer + runtime_oidc_renderer:
        raise SystemExit(f"exact provider scale-down lost fail-closed install gate: {exact_scale_down_gate}")
if '--oidc-credential-self-check' not in runtime_capacity_main:
    raise SystemExit("runtime capacity controller lost its non-destructive OIDC credential preflight")
for receipt_outcome in (
    'provider_acknowledged',
    'observed_exact_convergence_after_ambiguous_response',
    'intent.Phase != downscalePhaseIssued || intent.Attempts != 1',
):
    if receipt_outcome not in runtime_capacity_controller:
        raise SystemExit(f"runtime exact scale-down receipt lost outcome invariant: {receipt_outcome}")
if re.search(r"downscaleReceiptVersion\s*=\s*2", runtime_capacity_controller) is None:
    raise SystemExit("runtime exact scale-down receipt schema is not v2")
if 'sts.internal.tencentcloudapi.com' not in runtime_tencent_oidc:
    raise SystemExit("runtime OIDC exchange must remain on Tencent Cloud's VPC endpoint")
if 'tke.internal.tencentcloudapi.com' not in runtime_tencent_scale_down:
    raise SystemExit("exact runtime scale-down must remain on Tencent Cloud's VPC endpoint")
if 'identity.get("runtime_image") != expected_runtime_image' not in runtime_admission_installer:
    raise SystemExit("runtime admission installer must bind Node evidence to the exact candidate image")
workerd_containers = {
    container["name"]: container for container in workerd_pod_spec["containers"]
}
metrics_resources = workerd_containers["workerd-metrics"]["resources"]
if metrics_resources.get("requests") != {"cpu": "20m", "memory": "16Mi"}:
    raise SystemExit("workerd metrics sidecar lost its bounded scheduling request")
if metrics_resources.get("limits") != {"memory": "64Mi"}:
    raise SystemExit(
        "workerd metrics sidecar must retain a memory limit without a CFS CPU limit"
    )
metrics_script = workerd_containers["workerd-metrics"]["args"][0]
for shutdown_guard in (
    "collector_pid=$!",
    "httpd_pid=$!",
    "trap 'stop_metrics; exit 0' TERM INT",
    'kill "$httpd_pid" "$collector_pid"',
    'wait "$httpd_pid"',
):
    if shutdown_guard not in metrics_script:
        raise SystemExit(
            f"workerd metrics sidecar lost bounded SIGTERM cleanup: {shutdown_guard}"
        )
pool_init = next(
    document for document in runtime_documents
    if document.get("kind") == "Job"
    and document.get("metadata", {}).get("name") == "actor-bj-k01-workerd-pool-init"
)
reporter = next(
    document for document in runtime_documents
    if document.get("kind") == "Deployment"
    and document.get("metadata", {}).get("name") == "actor-bj-k01-cell-reporter"
)
reporter_annotations = reporter["spec"]["template"]["metadata"].get("annotations", {})
if reporter_annotations != {
    "fleet.actor.dev/reporter-source-commit": "__RIVET_REPORTER_SOURCE_REVISION__",
    "fleet.actor.dev/reporter-source-manifest-sha256": "__RIVET_REPORTER_SOURCE_MANIFEST_SHA256__",
}:
    raise SystemExit("Cell reporter Pod template must bind the immutable reporter source identity")
for component, pod_spec in (
    ("runner pool initializer", pool_init["spec"]["template"]["spec"]),
    ("Cell reporter", reporter["spec"]["template"]["spec"]),
):
    if pod_spec.get("nodeSelector") != {"fleet.actor.dev/control-pool": "true"}:
        raise SystemExit(f"{component} must be pinned to the physical control node pool")
for dynamic_reporter_input in (
    "CAPACITY_RISK", "QUALIFICATION_READY", "QUALIFICATION_RECEIPT",
    "QUALIFICATION_DIGEST", "QUALIFICATION_RELEASE_DIGEST",
):
    if dynamic_reporter_input in runtime_manifest:
        raise SystemExit("dynamic qualification state must not be owned by the static runtime manifest")
for fail_closed_default in (
    'env("CAPACITY_RISK", "AdmissionClosed")',
    'strings.EqualFold(os.Getenv("QUALIFICATION_READY"), "true")',
):
    if fail_closed_default not in (root.parents[2] / "cmd" / "rivet-cell-reporter" / "main.go").read_text():
        raise SystemExit("Cell reporter must default missing qualification state to fail closed")
for qualification_handoff in (
    'CAPACITY_RISK- QUALIFICATION_READY- QUALIFICATION_RECEIPT-',
    'QUALIFICATION_DIGEST- QUALIFICATION_RELEASE_DIGEST-',
):
    if qualification_handoff not in runtime_releaser:
        raise SystemExit("runtime release must close and relinquish dynamic qualification state before reporter apply")
if runtime_manifest.count('curl --fail --silent --header "x-rivet-workerd-token: $RIVET_WORKERD_TOKEN"') != 2:
    raise SystemExit("workerd-host probes must use the bridge authentication protocol")
if "Authorization: Bearer $RIVET_WORKERD_TOKEN" in runtime_manifest:
    raise SystemExit("workerd bridge probes must not use Engine Bearer authentication")
for storage_identity_guard in (
    "RIVET_COLD_BUCKET must be the exact Terraform Cell cold bucket",
    'get secret "${cell_name}-runtime-cos"',
    'credential-scope"] == "cell-cold"',
    'storage-bucket"] == $bucket',
    ".immutable == true",
):
    if storage_identity_guard not in runtime_installer:
        raise SystemExit(f"runtime lost immutable Cell cold-storage identity guard: {storage_identity_guard}")
for forbidden_storage_derivation in (
    "blob-credentials.json", "credential-scope=cloud-root",
    'create secret generic "${cell_name}-runtime-cos"',
):
    if forbidden_storage_derivation in runtime_installer:
        raise SystemExit("runtime release must not derive cold credentials from FDB backup credentials")
if "actor-bj-k01-runtime-cos" not in runtime_manifest:
    raise SystemExit("runtime manifest lost the Cell-scoped cold storage Secret reference")
if "SecretKey" in runtime_manifest or "AKID" in runtime_manifest:
    raise SystemExit("runtime manifest must not contain cloud credentials")
for token_guard in (
    "wc -c",
    "^[0-9a-f]{64}$",
    "tr -d '\\n'",
    "RIVET_RUNTIME_ROLLOUT_TIMEOUT_SECONDS",
    "RIVET_RUNTIME_RESTART_FAIL_THRESHOLD",
    "runtime rollout entered a terminal container state",
):
    if token_guard not in runtime_installer:
        raise SystemExit(f"runtime installer lost token/rollout safety guard: {token_guard}")
if runtime_installer.count("http://127.0.0.1:19083/v1/sqlite/drain") != 2:
    raise SystemExit("runtime rollout must publish drain once and retry active-actor sleep until quiescent")
for drain_guard in (
    '"host_active_actors":[[:space:]]*0',
    '"bridge_active_actors":[[:space:]]*0',
    '"in_flight":[[:space:]]*0',
    '"queued":[[:space:]]*0',
    "last bounded drain response",
):
    if drain_guard not in runtime_installer:
        raise SystemExit(f"runtime rollout lost exact drain convergence evidence: {drain_guard}")
for tuning_guard in (
    "RIVET_RUNTIME_PROFILE",
    "default_write_debt_target=10485760",
    "default_write_debt_target=262144",
    "__RIVET_FDB_WRITE_DEBT_TARGET_BYTES__",
    "__RIVET_FDB_WRITE_DEBT_LIMIT_BYTES__",
    "RIVET_DEPOT_RECLAIM_INTERVAL_MS",
    "default_depot_reclaim_interval_ms=600000",
    "default_depot_reclaim_interval_ms=5000",
    "__RIVET_DEPOT_RECLAIM_INTERVAL_MS__",
    'python3 "$script_dir/manifest-identity.py"',
    '--file "$script_dir/runtime.yaml"',
    '--value "$cell_name"',
    '--value "$runtime_profile"',
    '--value "$write_debt_target"',
    '--value "$write_debt_limit"',
):
    if tuning_guard not in runtime_installer:
        raise SystemExit(f"runtime installer lost profile/config rollout guard: {tuning_guard}")
for build_guard in (
    "RIVET_CARGO_TARGET_DIR",
    "Cargo target directory must be outside the immutable source tree",
    '"$CARGO_TARGET_DIR/release/rivet-engine"',
    "RIVET_SOURCE_MANIFEST_FILE",
    'sha256sum --check "$source_manifest"',
    'install -m 0644 "$source_dir/infra/cells/deploy/tencent/fleet/runtime/Dockerfile"',
    '"$stage_dir/workerd" test',
    "worker-loader-abi-test.wd-test",
    'org.opencontainers.image.revision=$source_revision',
    'fleet.actor.dev/workerd-sha256=$workerd_sha',
    '"$stage_dir/rivet-engine" --config "$runtime_config" config show',
    "source-manifest-sha256",
    'buildah run "$validation_container"',
    'product_python=${ACTOR_BUILD_PYTHON:-python3}',
    '"$product_python" "$script_dir/../gitops/image-seed/record-product-image.py"',
):
    if build_guard not in runtime_builder:
        raise SystemExit(f"runtime build lost source/config compatibility gate: {build_guard}")
for remote_build_guard in (
    "CreateInstanceToken",
    "TokenType temp",
    "q01-runtime-build-",
    "trap cleanup_remote EXIT INT TERM",
    "getent ahostsv4",
    "q01-runtime-cargo-home.",
    "python3.11",
    "ACTOR_BUILD_PYTHON=python3.11",
    "RIVET_CARGO_TARGET_DIR=/data/build-cache/rivet-runtime-cargo-target",
    "q01-remove-runtime-build-auth",
):
    if remote_build_guard not in runtime_tat_builder:
        raise SystemExit(f"runtime TAT build lost ephemeral authority or immutable input gate: {remote_build_guard}")
for stage_reuse_guard in (
    '@sha256:[0-9a-f]{64}',
    'sha256sum --check .actor-source/RELEASE_SHA256SUMS',
    'python3 "$script_dir/verify-stage-reuse-inputs.py"',
    '"$base_source_dir" "$source_dir" "${stage_inputs[@]}"',
    '[[ $stage_inputs_digest =~ ^[0-9a-f]{64}$ ]]',
    'fleet.actor.dev/source-revision',
    'fleet.actor.dev/source-manifest-sha256',
    'fleet.actor.dev/workerd-sha256',
    'reused workerd is not static',
    'mode:"verified-base-runtime-reuse"',
):
    if stage_reuse_guard not in runtime_stage_reuser:
        raise SystemExit(f"Runtime stage reuse lost immutable equivalence gate: {stage_reuse_guard}")
for stage_closure_guard in (
    'base Runtime stage inputs differ from the release source',
    '"cargo", "metadata", "--locked", "--offline"',
    'FFI_ROOTS = {"rivet-depot-client", "rivet-envoy-protocol"}',
    'workerd bridge direct dependency contract is not audited for this fork',
    'workerd Rust dependency escaped reviewed source',
    'dependency.get("kind") == "dev"',
    'target_bytes = handle.read()',
    'target_mode = os.stat(target).st_mode & 0o111',
    'left_inventory != right_inventory',
):
    if stage_closure_guard not in runtime_stage_reuse_inputs:
        raise SystemExit(f"Runtime stage reuse lost production input proof: {stage_closure_guard}")
for stage_reuse_entry_guard in (
    'base_sources=()',
    'if (( ${#base_sources[@]} != 1 )); then',
    'RIVET_STAGE_RECEIPT="$stage_receipt"',
):
    if stage_reuse_entry_guard not in runtime_tat_builder:
        raise SystemExit(f"runtime TAT build lost unique stage baseline gate: {stage_reuse_entry_guard}")
for baseline_guard in (
    "verify-full-source-bundle.py",
    "unsafe runtime baseline member",
    "sha256sum --check .actor-source/RELEASE_SHA256SUMS",
    "cmp .actor-source/actual-files .actor-source/manifest-files",
    "chmod -R a-w",
    "/var/lib/actor-build/runtime-baselines",
):
    if baseline_guard not in runtime_baseline_materializer:
        raise SystemExit(f"historical Runtime baseline lost immutable materialization gate: {baseline_guard}")
if "verify-manifests.sh" in runtime_baseline_materializer:
    raise SystemExit("historical Runtime baseline must not be confused with releasable reviewed source")
for cargo_cache_guard in (
    "cargo metadata --locked --offline",
    'item["name"] in {"rivet-engine", "rivet-workerd-host"}',
    "local Cargo dependency escaped source",
    "cargo --version --verbose",
    "rustc --version --verbose",
    'find "$target_dir" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +',
):
    if cargo_cache_guard not in runtime_cargo_cache:
        raise SystemExit(f"Runtime Cargo cache lost transitive input invalidation gate: {cargo_cache_guard}")
for stable_workspace_guard in (
    'flock -n 9',
    'mount --bind "$immutable_source" "$stable_source"',
    'mount -o remount,bind,ro "$stable_source"',
    'RIVET_CARGO_CACHE_STATE="$workspace_root/cargo-cache.sha256"',
):
    if stable_workspace_guard not in runtime_tat_builder:
        raise SystemExit(f"runtime TAT build lost stable read-only Cargo workspace gate: {stable_workspace_guard}")
for name, builder in (
    ("runtime", runtime_builder),
    ("controller", controller_builder),
    ("loadgen", loadgen_builder),
):
    if 'sha256sum --check "$source_manifest" >/dev/null' not in builder:
        raise SystemExit(f"{name} build must bound complete source-manifest output")
for abi_guard in (
    "await worker.ready()",
    "await worker.validateEntrypoint()",
    'await worker.validateDurableObjectClass("Counter")',
    "workerLoader = ()",
    '__RIVET_OBJECT_ROUTER: env.OBJECT_ROUTER',
    'Object.keys(env).join(",") !== "COUNTER"',
    '(name = "OBJECT_ROUTER", service = "object-router-abi-test")',
    'request.headers.get(ROUTER_TOKEN_HEADER) !== OBJECT_ROUTER_TOKEN',
):
    if abi_guard not in worker_loader_abi_test + worker_loader_abi_config + object_router_abi_test:
        raise SystemExit(f"runtime WorkerLoader ABI test lost coverage: {abi_guard}")
for source_guard in (
    "jj log --no-graph",
    'jj diff --from "$base_commit" --to "$source_commit" --name-only',
    "source delta contains deletions",
    ".actor-source/SHA256SUMS",
    ".actor-source/RELEASE_SHA256SUMS",
    "COPYFILE_DISABLE=1",
):
    if source_guard not in runtime_source_bundler:
        raise SystemExit(f"runtime source bundler lost completeness gate: {source_guard}")
for apply_source_guard in (
    "ACTOR_SOURCE_APPLIER_STAGED",
    "unsafe source bundle member",
    "prospective overlay",
    "builder base identity mismatch",
    "builder base tree no longer matches its reviewed release manifest",
    ".actor-source/RELEASE_SHA256SUMS",
    "sha256sum --check .actor-source/RELEASE_SHA256SUMS >/dev/null",
):
    if apply_source_guard not in runtime_source_applier:
        raise SystemExit(f"runtime source applier lost fail-closed gate: {apply_source_guard}")
for validator_guard in (
    'script_dir=$(CDPATH=',
    "release-compatibility-check",
    "source-revision",
    "source-manifest-sha256",
    "config show",
    "backoffLimit: 0",
):
    if validator_guard not in runtime_image_validator:
        raise SystemExit(f"runtime image validator lost compatibility gate: {validator_guard}")
for release_guard in (
    "health.fullReplication",
    "fdbbackup describe",
    "Restorable: true",
    "validate-runtime-image.sh",
    "configmap-patch.json",
    "engine-patch.json",
    "runtime-patch.json",
    "nats-config-patch.json",
    "nats-patch.json",
    "capacity-patch.json",
    "rivet-runtime-admission-rollback",
    "reporter-patch.json",
    "rollback-admission-ownership.json",
    'rollout_started=true',
    '[[ $zones -ge $required_topology_zones ]]',
    'production Cell releases must explicitly preserve or disable exact provider scale-down',
    'RUNTIME_EXACT_SCALE_DOWN_ENABLED+x',
    'ACTOR_IMAGE_PREFLIGHT_NAME=runtime-capacity-release',
    'ACTOR_IMAGE_PREFLIGHT_NAME=cell-reporter-release',
    '/usr/local/bin/workerd-runtime-capacity-controller --help',
    '/usr/local/bin/rivet-cell-reporter --help',
    'ACTOR_IMAGE_PREFLIGHT_EXPECTED_EXIT_CODE=0',
    'ACTOR_IMAGE_PREFLIGHT_EXPECTED_EXIT_CODE=1',
):
    if release_guard not in runtime_release:
        raise SystemExit(f"runtime release workflow lost transactional gate: {release_guard}")
for reporter_migration_guard in (
    "desired-reporter.yaml",
    "desired-reporter.json",
    'item["name"] == "reporter"',
):
    if reporter_migration_guard not in runtime_installer:
        raise SystemExit(f"runtime installer lost scoped reporter ownership migration: {reporter_migration_guard}")
if runtime_host_autoscaling_installer.count(
    "apply --server-side --force-conflicts"
) != 2:
    raise SystemExit(
        "Host autoscaling installer must atomically reclaim legacy Update ownership "
        "during dry-run and live apply"
    )
for controller_release_guard in (
    'kustomize "$fleet_dir/controller-fdb-operator"',
    'fleet.actor.dev/source-manifest-sha256',
    'reporter-source-manifest-sha256',
    'old_controller_annotations',
    'old_reporter_annotations',
    'ACTOR_IMAGE_PREFLIGHT_NAME=controller-release',
    'ACTOR_IMAGE_PREFLIGHT_NAME=reporter-release',
    'preflight-image-pull.sh',
):
    if controller_release_guard not in (root / "controller" / "release-controller.sh").read_text():
        raise SystemExit(
            f"controller release lost immutable rollout/rollback gate: {controller_release_guard}"
        )
for qualifier_guard in (
    '--workers-api-url "http://127.0.0.1:${workers_api_port}"',
    '--depot-inspect-url "http://127.0.0.1:${engine_admin_port}"',
    'public_worker=${QUALIFICATION_PUBLIC_WORKER:-${cell_name##*-}-bottomless-qualification}',
    '--public-worker "$public_worker"',
    "--public-class-name Agent",
    'service/"${cell_name}-workers-api"',
    'runtime_replicas=$(kubectl',
    'runtime_replicas >= 3 && runtime_replicas <= 64',
    'python3 - "$((runtime_replicas + 3))"',
    'host_ports=("${allocated_ports[@]:3}")',
    'for ((ordinal = 0; ordinal < runtime_replicas; ordinal++))',
    'host_stats_args+=(',
    '"${host_stats_args[@]}"',
    "--min-active-hosts 3",
    "--prove-sleep",
    "--wake-after-sleep",
    "--min-recovery-queued-hosts",
    "post_cleanup",
    'checkpoint = result["online_checkpoint"]',
    'qualification_profile=${QUALIFICATION_PROFILE:-production}',
    "default_cold_state_timeout=3600",
    "default_cold_state_timeout=300",
    "default_bottomless_bytes=3145728",
    "does not match deployed runtime profile",
    'result["receipt_scope"]',
    'result["logical_quota"]',
    'verify_bottomless_receipt.py',
    'capture_release_binding "$temporary/release-before"',
    'capture_release_binding "$temporary/release-after"',
    'cmp "$temporary/release-before-binding.json" "$temporary/release-after-binding.json"',
    'result["release_binding"]',
):
    if qualifier_guard not in runtime_qualifier:
        raise SystemExit(f"runtime Actor qualification lost gate: {qualifier_guard}")
if "127.0.0.1:16421" in runtime_qualifier:
    raise SystemExit("runtime qualification must not depend on an operator's residual port-forward")
for transport_guard in (
    "port_forward_supervisor()",
    "port-forward supervisor restart=",
    'result.setdefault("transport", {})["port_forward_restarts"]',
    "QUALIFICATION_FAILURE_DIAGNOSTICS_DIR",
    "retry_idempotent_transport(create_public_once)",
    '"transport": {"create_retries": create_transport_retries}',
):
    if transport_guard not in runtime_qualifier + qualification_harness:
        raise SystemExit("runtime qualification lost reconnecting transport guard: " + transport_guard)
for harness_guard in (
    '"public_api_only": public_api_only',
    '"path_prefix": "/v1"',
    'public_object_url(',
    'resolve_public_actor(',
    '{"force_reclaim": True}',
    'payload.get("force_reclaim_accepted") is not True',
    'payload.get("checkpoint_contract_version") != 2',
):
    if harness_guard not in qualification_harness:
        raise SystemExit(f"runtime Actor harness lost force-reclaim gate: {harness_guard}")
for generation_guard in (
    'REGISTRY_RESOLVE_PATH: &str = "/v1/sqlite/registry-resolve"',
    "request.actor_ids.len() > MAX_REGISTRY_LOOKUP_ACTORS",
    "invalid or duplicate actor identity",
    "host_generation",
    "bridge_generation",
):
    if generation_guard not in workerd_sqlite_bridge:
        raise SystemExit(f"workerd exact generation resolver lost invariant: {generation_guard}")
for generation_guard in (
    "resolve_current_public_generation(",
    'host_generation != bridge_generation',
    'len(owners) != 1',
):
    if generation_guard not in qualification_harness:
        raise SystemExit(f"public Bottomless generation proof lost invariant: {generation_guard}")
for monitor_guard in (
    '"$script_dir/../tat"',
    "BOTTOMLESS_MONITOR_POLL_SECONDS:-300",
    'export TAT_POLL_SECONDS=$poll_seconds',
    'tat-wait.sh" "$invocation_id"',
    'tat-download.sh" "$remote_receipt" "$local_receipt"',
    'verify_bottomless_receipt.py" --profile "$profile" "$local_receipt"',
):
    if monitor_guard not in bottomless_monitor:
        raise SystemExit(f"Bottomless monitor lost slow immutable follow guard: {monitor_guard}")
for receipt_guard in (
    'receipt.get("public_api_only") is True',
    '"legacy_engine_actor_data_plane" not in privileged',
    '"claim_eligible": profile == "production"',
    'logical size did not cross transient write-debt limit',
    'cold-read sample count does not cover every Actor',
    'recovery storm did not require all hosts',
    'bridge registry did not clean up',
    'same_immutable_release_and_pod_set_before_after_qualification',
    'runtime image is not pinned to the bound digest',
):
    if receipt_guard not in bottomless_receipt_verifier:
        raise SystemExit(f"Bottomless production receipt verifier lost gate: {receipt_guard}")
bottomless_requirements = runpy.run_path(
    str(root / "runtime" / "verify_bottomless_receipt.py")
)["PROFILE_REQUIREMENTS"]
if bottomless_requirements.get("production") != {
    "scope": "production-qualification",
    "actors": 96,
    "concurrency": 96,
    "increments": 130,
    "bottomless_bytes": 12 * 1024 * 1024,
}:
    raise SystemExit("Bottomless production receipt verifier load contract changed")
if "policy_cleanup = bounded_map(" not in qualification_harness:
    raise SystemExit("runtime qualification cleanup must not serialize per-Actor policy timeouts")
for harness_guard in (
    '"cold_ready_after_sleep"',
    "cold_state_progress(",
    "A live workerd may legitimately pin the current hot shard",
):
    if harness_guard not in qualification_harness:
        raise SystemExit(f"runtime qualification lost cold-state ordering guard: {harness_guard}")
sleep_gate = qualification_harness.index('write_inflight("sleep")')
cold_call = qualification_harness.index("wait_for_exact_cold_state()", sleep_gate)
wake_gate = qualification_harness.index("if wake_after_sleep:", cold_call)
if not sleep_gate < cold_call < wake_gate:
    raise SystemExit("runtime qualification must prove sleep, then exact cold-only, then wake")
for ha_guard in (
    "expected exactly six non-terminating Ready Engine Pods",
    "Engine replicas are not evenly spread over three hostnames",
    "Engine replicas are not evenly spread over three zones",
    '"kind": "DeleteOptions"',
    '"gracePeriodSeconds": 0',
    '"preconditions": {"uid": "$victim_uid"}',
    '--raw "/api/v1/namespaces/$namespace/pods/$victim_pod"',
    'uid_fenced_zero_grace_engine_pod_delete',
    '"failures") != 0',
    'result.get("public_api") != "/v1"',
    'result.get("object_count") != 10',
    'result.get("cleanup") != "passed"',
    "post_failure_write_count",
    "public_v1_workers_api_survives_one_engine_pod_loss_without_request_failure",
):
    if ha_guard not in engine_ha_qualifier:
        raise SystemExit(f"Engine HA qualification lost gate: {ha_guard}")
if 'delete pod "$victim_pod" --wait=false' in engine_ha_qualifier:
    raise SystemExit("Engine HA qualification retained the weak graceful Pod deletion path")
for probe_guard in (
    "probe_ready",
    'REQUEST_COUNT:-1500',
    'REQUEST_CONCURRENCY:-10',
    '-X PUT',
    '--max-time 60',
    'if ! delete_objects; then',
    'WORKER_NAME:-q01-engine-ha-gate',
    '"worker_fixture_retained":true',
    'worker_failures=$((worker_failures + 1))',
    '/v1/workers/%s/objects/%s/%s',
    'X-Workers-Original-URL: https://agent.invalid/$route',
    '"public_api":"/v1"',
):
    if probe_guard not in engine_ha_probe:
        raise SystemExit(f"Engine HA request probe lost gate: {probe_guard}")
if "delete_worker" in engine_ha_probe:
    raise SystemExit("Engine HA probe must retain its fixed DO Worker fixture")
loadgen = (root / "loadgen" / "run.sh").read_text()
loadgen_runtime_floor = (root / "loadgen" / "verify_runtime_floor.py").read_text()
loadgen_dockerfile = (root / "loadgen" / "Dockerfile").read_text()
if "ARG ACTOR_LOADGEN_BASE_IMAGE" not in loadgen_dockerfile or "FROM ${ACTOR_LOADGEN_BASE_IMAGE}" not in loadgen_dockerfile:
    raise SystemExit("FDB load generator must consume its inventory-provided base digest")
if "tencentcloudcr.com/actor-fleet/base-golang@" in loadgen_dockerfile:
    raise SystemExit("FDB load generator retained a historical base digest")
for loadgen_guard in (
    'cell_obj.get("spec",{}).get("className")==class_name',
    'shard_class.get("spec",{}).get("profileRef",{}).get("name")==profile_name',
    'conditions.get("Ready")=="True"',
    'pod.get("status",{}).get("phase")=="Running"',
):
    if loadgen_guard not in (root / "autoscaling" / "qualify.sh").read_text():
        raise SystemExit(f"FDB autoscaling qualification lost identity gate: {loadgen_guard}")
autoscaling_qualifier = (root / "autoscaling" / "qualify.sh").read_text()
for runtime_floor_guard in (
    "runtime_baseline_replicas=${ACTOR_RUNTIME_BASELINE_REPLICAS:-}",
    '"${cell}-runtime-hosts-actor-capacity"',
    "-o jsonpath='{.spec.minReplicas}'",
    "$runtime_baseline_replicas -ge 4",
):
    if runtime_floor_guard not in autoscaling_qualifier:
        raise SystemExit(f"FDB autoscaling qualification lost dynamic Runtime floor: {runtime_floor_guard}")
if "ACTOR_RUNTIME_BASELINE_REPLICAS:-3" in autoscaling_qualifier:
    raise SystemExit("FDB autoscaling qualification retained the obsolete three-Host floor")
if '"key":"fleet.actor.dev/control-pool","operator":"In","values":["true"]' not in loadgen:
    raise SystemExit("FDB load generator must run only on the control pool")
if '"requests":{"cpu":"200m","memory":"512Mi"}' not in loadgen:
    raise SystemExit("FDB load generator lost its reviewed burstable scheduling request")
for floor_guard in (
    'MIN_PRODUCTION_HOSTS = 4',
    'Runtime is not fully converged at the authoritative HPA floor',
    'fleet.actor.dev/runtime-release-hold',
    'fleet.actor.dev/workerd-host-drain-state',
    'ScalingActive',
):
    if floor_guard not in loadgen_runtime_floor:
        raise SystemExit(f"FDB load generator lost Runtime floor gate: {floor_guard}")
if 'verify_runtime_floor.py' not in loadgen:
    raise SystemExit("FDB load generator does not invoke the Runtime floor gate")
for pull_guard in (
    '"kind":"DaemonSet"',
    '"imagePullPolicy":"Always"',
    'expected_pull_nodes',
    'immutable loadgen image did not pull on every control node',
    '.status.numberUnavailable}{"\\n"}',
    'wait --for=delete pod',
):
    if pull_guard not in loadgen:
        raise SystemExit(f"FDB load generator lost registry/node pull preflight: {pull_guard}")
for public_loadgen_guard in (
    'ACTOR_LOADGEN_API_MODE:-actor',
    'ACTOR_LOADGEN_BATCH_SETTLE_SECONDS:-0',
    'ACTOR_LOADGEN_OPERATION_RATE:-0',
    'ACTOR_LOADGEN_MAX_IDEMPOTENT_RETRIES:-3',
    'ACTOR_LOADGEN_RETRY_BASE_DELAY_SECONDS:-0.1',
    '"--api-mode",api_mode',
    '"--batch-settle-seconds",batch_settle_seconds',
    '"--operation-rate",operation_rate',
    '"--max-idempotent-retries",max_idempotent_retries',
    '"--retry-base-delay-seconds",retry_base_delay_seconds',
    '"--workers-url",workers_url',
    '"fleet.actor.dev/public-api-only":"true"',
):
    if public_loadgen_guard not in loadgen:
        raise SystemExit(f"FDB load generator lost public Workers API binding: {public_loadgen_guard}")
cell_autoscale = (root / "qualification" / "actor-bj-q01" / "run-fdb-autoscaling-qualification.sh").read_text()
for cell_guard in (
    "CELL must name the exact qualification Cell",
    "CELL_NAMESPACE must name the exact qualification namespace",
    "rivet-fdb-operator-cbs-beijing-v1",
    "rivet-fdb-cos-kubernetes-v1",
    "ACTOR_QUALIFICATION_ACTORS:-1000",
    "ACTOR_QUALIFICATION_PROBES:-256",
    "ACTOR_QUALIFICATION_BATCH_SIZE:-32",
    "ACTOR_QUALIFICATION_BATCH_SETTLE_SECONDS:-45",
    "ACTOR_QUALIFICATION_OPERATION_RATE:-0",
    "ACTOR_QUALIFICATION_MAX_IDEMPOTENT_RETRIES:-3",
    "ACTOR_QUALIFICATION_RETRY_BASE_DELAY_SECONDS:-0.1",
    "loadgen/build-image.sh",
    'source_identity_dir="$source_root/.actor-source"',
    '$source_identity_dir/SOURCE_REVISION',
    '$source_identity_dir/RELEASE_SHA256SUMS',
    'sha256sum --check "$source_manifest"',
    "ACTOR_LOADGEN_API_MODE=workers-v1",
    'ACTOR_LOADGEN_WORKERS_URL:-http://${cell}-workers-api:8080',
    'autoscaling/verify_receipt.py" "$ACTOR_AUTOSCALING_RECEIPT"',
    "uuid.uuid4().hex[:16]",
):
    if cell_guard not in cell_autoscale:
        raise SystemExit(f"Cell one-command autoscaling gate lost invariant: {cell_guard}")
autoscale_qualifier = (root / "autoscaling" / "qualify.sh").read_text()
full_source_bundler = (root / "runtime" / "bundle-full-reviewed-source.sh").read_text()
full_source_materializer = (root / "qualification" / "actor-bj-q01" / "materialize-full-reviewed-source.sh").read_text()
for full_source_guard in (
    "git -C \"$repository_root\" archive",
    '"schema": "actor-reviewed-source-bundle/v2"',
    '"projectPath": project_path',
    '"projectTree": project_tree',
    ".actor-source/RELEASE_SHA256SUMS",
    ".actor-source/SOURCE_REVISION",
    "RIVET_SOURCE_RECEIPT",
    "tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner",
    "publish_exact",
    "verify-full-source-bundle.py",
):
    if full_source_guard not in full_source_bundler:
        raise SystemExit(f"full reviewed source bundler lost invariant: {full_source_guard}")
for full_materialize_guard in (
    "Usage: materialize-full-reviewed-source.sh BUNDLE RECEIPT",
    "install -d -m 0755 /var/lib/actor-build/deploy",
    "verify-full-source-bundle.py",
    "unsafe full source member",
    "escaping source symlink",
    "sha256sum --check .actor-source/RELEASE_SHA256SUMS",
    "cmp .actor-source/actual-files .actor-source/manifest-files",
    "verify-manifests.sh",
    "chmod -R a-w",
):
    if full_materialize_guard not in full_source_materializer:
        raise SystemExit(f"full reviewed source materializer lost invariant: {full_materialize_guard}")
pre_destroy_run = (root / "terraform" / "create-first" / "pre-destroy" / "run.sh").read_text()
pre_destroy_plan = (root / "terraform" / "create-first" / "pre-destroy" / "plan-destroy.sh").read_text()
for pre_destroy_source in (pre_destroy_run, pre_destroy_plan):
    for source_guard in (
        'fleet_dir=$(CDPATH= cd -- "$script_dir/../../.." && pwd)',
        'project_root=$(CDPATH= cd -- "$fleet_dir/../../../../.." && pwd)',
    ):
        if source_guard not in pre_destroy_source:
            raise SystemExit(f"pre-destroy source boundary lost invariant: {source_guard}")
q01_bootstrap_creator = (root / "qualification" / "actor-bj-q01" / "create-bootstrap-node.sh").read_text()
for bootstrap_guard in (
    "DescribeInstances",
    "DescribeClusterInstances",
    "DescribeAutomationAgentStatus",
    "AgentStatus == \"Online\"",
    "bootstrap-node-retired-",
    "bootstrap-node-intent.json",
    "multiple live q01 bootstrap candidates exist",
    "flock 9",
):
    if bootstrap_guard not in q01_bootstrap_creator:
        raise SystemExit(f"q01 bootstrap replacement lost convergence invariant: {bootstrap_guard}")
autoscale_receipt_verifier = (root / "autoscaling" / "verify_receipt.py").read_text()
for renewal_guard in (
    "actor-fdb-autoscaling-qualification-v5",
    '"loadgenConfig"',
    "baselineAutoscalingMode",
    '"profileBinding":profile_binding',
    '[[ $baseline_mode == ObserveOnly || $baseline_mode == Automatic ]]',
    '[[ $mode == "$baseline_mode" && $desired == 9 ]]',
):
    if renewal_guard not in autoscale_qualifier:
        raise SystemExit(f"FDB autoscaling renewal lost production-mode invariant: {renewal_guard}")
for verifier_guard in (
    'schema == "actor-fdb-autoscaling-qualification-v5"',
    'config["runtimeBaselineReplicas"] >= 4',
    "verify_profile_binding(document)",
    'annotations.get("fleet.actor.dev/profile-digest") == binding["profileDigest"]',
    'baseline_mode in {"ObserveOnly", "Automatic"}',
):
    if verifier_guard not in autoscale_receipt_verifier:
        raise SystemExit(f"FDB autoscaling receipt verifier lost version/mode invariant: {verifier_guard}")
q01_fdb_promoter = (root / "qualification" / "actor-bj-q01" / "promote-fdb-automatic.sh").read_text()
q01_fdb_promotion_tat = (root / "qualification" / "actor-bj-q01" / "promote-fdb-automatic-via-tat.sh").read_text()
for promotion_guard in (
    "fdb.autoscaling.promote",
    "qualification receipt is not the latest terminal autoscaling attempt",
    "qualification receipt is older than the 24-hour promotion window",
    "verify_receipt.py",
    "receipt[\"foundationDB\"][\"metadata\"][\"uid\"]",
    "receipt[\"machineSet\"][\"metadata\"][\"uid\"]",
    "Restorable: true",
    "active Jobs or FDB scale operations block Automatic promotion",
    "restoring the exact ObserveOnly profile",
    "newProfileDigest",
):
    if promotion_guard not in q01_fdb_promoter:
        raise SystemExit(f"q01 FDB Automatic promotion lost invariant: {promotion_guard}")
for promotion_tat_guard in (
    "actor-bj-q01-current",
    "promote-fdb-automatic.sh",
    "relay-download-from-builder.sh",
    "actor-fdb-automatic-promotion-v1",
):
    if promotion_tat_guard not in q01_fdb_promotion_tat:
        raise SystemExit(f"q01 FDB Automatic TAT entry lost invariant: {promotion_tat_guard}")
for isolation_guard in (
    "runtimeIsolationTimeline",
    "loadgenResults",
    "capture_loadgen_result",
    "wait_runtime_baseline",
    "rivet_workerd_active_actors_total",
    "ACTOR_LOADGEN_BATCH_SETTLE_SECONDS=$loadgen_batch_settle_seconds",
    "ACTOR_LOADGEN_OPERATION_RATE=$loadgen_operation_rate",
    "ACTOR_LOADGEN_MAX_IDEMPOTENT_RETRIES=$loadgen_max_idempotent_retries",
    "ACTOR_LOADGEN_RETRY_BASE_DELAY_SECONDS=$loadgen_retry_base_delay_seconds",
    ': >"$temporary/runtime-timeline.jsonl"',
):
    if isolation_guard not in autoscale_qualifier:
        raise SystemExit(f"FDB autoscaling gate lost compute-isolation invariant: {isolation_guard}")
cell_autoscale_tat = (root / "qualification" / "actor-bj-q01" / "run-fdb-autoscaling-via-tat.sh").read_text()
for autoscale_tat_guard in (
    "CELL must name the exact qualification Cell",
    "CELL_NAMESPACE must name the exact qualification namespace",
    "ACTOR_IMAGE_INVENTORY",
    '.images[] | select(.repository == "actor-loadgen") | .ref',
    'actor-loadgen@sha256:',
    "export ACTOR_LOADGEN_IMAGE=",
    'operations_env=/etc/actor/rivet-autonomy-audit.env',
    'source "\\$operations_env"',
    '[[ \\${CELL:?} == $cell && \\${CELL_NAMESPACE:?} == $namespace ]]',
    'export CELL CELL_NAMESPACE',
    'export KUBECONFIG=\\$KUBECONFIG_PATH',
    "autoscaling_local_receipt=",
    "relay-download-from-builder.sh",
):
    if autoscale_tat_guard not in cell_autoscale_tat:
        raise SystemExit(f"Cell FDB TAT entry lost immutable inventory binding: {autoscale_tat_guard}")
for forbidden in ("CreateInstanceToken", "TAT_UPLOAD_MODE", "REGISTRY_AUTH_FILE"):
    if forbidden in cell_autoscale_tat:
        raise SystemExit(f"Cell FDB qualification must not publish a loadgen at run time: {forbidden}")
q01_fdb_recovery = (root / "qualification" / "actor-bj-q01" / "recover-expanded-fdb.py").read_text()
q01_fdb_recovery_entry = (root / "qualification" / "actor-bj-q01" / "run-recover-expanded-fdb.sh").read_text()
q01_fdb_recovery_tat = (root / "qualification" / "actor-bj-q01" / "run-recover-expanded-fdb-via-tat.sh").read_text()
for recovery_guard in (
    "sourceOperationUID",
    "activeActors",
    "continuous backup is not exactly restorable",
    "source expansion already has a later 12 to 9 operation",
    "exact three retired volumes are not safely quarantined",
    "restored ObserveOnly 9-process profile",
    "downOperationResource",
):
    if recovery_guard not in q01_fdb_recovery:
        raise SystemExit(f"q01 expanded FDB recovery lost safety invariant: {recovery_guard}")
for recovery_entry_guard in (
    "ALLOW_FDB_EXPANDED_RECOVERY",
    "ACTOR_FDB_RECOVERY_SOURCE_OPERATION",
    "with-autonomy-operation-lock.sh",
    "RELEASE_SHA256SUMS",
    "verify-expanded-fdb-recovery.py",
):
    if recovery_entry_guard not in q01_fdb_recovery_entry:
        raise SystemExit(f"q01 expanded FDB recovery entry lost safety invariant: {recovery_entry_guard}")
for recovery_tat_guard in (
    "--detach",
    "actor-bj-q01-current",
    "ACTOR_FDB_RECOVERY_SOURCE_OPERATION",
    "ALLOW_FDB_EXPANDED_RECOVERY=1",
):
    if recovery_tat_guard not in q01_fdb_recovery_tat:
        raise SystemExit(f"q01 expanded FDB TAT recovery lost safety invariant: {recovery_tat_guard}")
q01_engine_ha = (root / "qualification" / "actor-bj-q01" / "run-engine-ha.sh").read_text()
for engine_ha_guard in (
    "cell=actor-bj-q01",
    "namespace=actor-fdb-cell-system",
    "/var/lib/actor-build/credentials/actor-bj-q01.kubeconfig",
    "${cell}-engine-ha-${run_id}.json",
    "AUTONOMY_OPERATION_LOCK_HELD=1",
    '"$runtime_dir/qualify-engine-ha.sh"',
):
    if engine_ha_guard not in q01_engine_ha:
        raise SystemExit(f"q01 Engine HA wrapper lost invariant: {engine_ha_guard}")
q01_source_promoter = (root / "qualification" / "actor-bj-q01" / "promote-reviewed-source.sh").read_text()
q01_source_materializer = (root / "qualification" / "actor-bj-q01" / "materialize-reviewed-source.sh").read_text()
q01_semantic_candidate = (root / "qualification" / "actor-bj-q01" / "build-semantic-failure-candidate-via-tat.sh").read_text()
q01_semantic_patch = (root / "qualification" / "actor-bj-q01" / "semantic-failure-candidate.patch").read_text()
q01_upgrade_gate = (root / "qualification" / "actor-bj-q01" / "user-transparent-upgrade.py").read_text()
q01_upgrade_tat = (root / "qualification" / "actor-bj-q01" / "run-user-transparent-upgrade-via-tat.sh").read_text()
q01_upgrade_builder = (root / "qualification" / "actor-bj-q01" / "run-user-transparent-upgrade-on-builder.sh").read_text()
for upgrade_entrypoint, source in (
    ("direct builder", q01_upgrade_builder),
    ("TAT", q01_upgrade_tat),
):
    for required_release_input in (
        "export RIVET_GASOLINE_STORAGE_PROFILE_ENFORCE=1",
        "export ACTOR_IMAGE_INVENTORY=",
        "export RIVET_COLD_BUCKET=",
    ):
        if required_release_input not in source:
            raise SystemExit(
                f"q01 {upgrade_entrypoint} upgrade entrypoint lost release input: {required_release_input}"
            )
q01_failed_release_rollback = (root / "qualification" / "actor-bj-q01" / "verify-failed-release-rollback.py").read_text()
q01_upgrade_verifier = (root / "qualification" / "actor-bj-q01" / "verify-user-transparent-upgrade.py").read_text()
q01_rollback_gate = (root / "qualification" / "actor-bj-q01" / "user-transparent-rollback.py").read_text()
q01_rollback_verifier = (root / "qualification" / "actor-bj-q01" / "verify-user-transparent-rollback.py").read_text()
loadgen_runner = (root / "loadgen" / "run.sh").read_text()
if '"ttlSecondsAfterFinished":86400' not in loadgen_runner:
    raise SystemExit("FDB loadgen Jobs must expire one day after success or failure")
for upgrade_guard in (
    '"public_api_only": True',
    'worker = "q01-platform-upgrade-gate"',
    'args.objects < 32 or args.probe_concurrency < 20',
    'endpoint + "/v1/workers/"',
    "run_release(args.release_script",
    'assert_component_transition(',
    '"changed_complete_rollout"',
    '"unchanged_preserved_existing_ordinals"',
    'assert_target_images(',
    'target_images_from_environment()',
    '"container/workerd-host": runtime_image',
    "wait_for_healthy_capacity(",
    'args.capacity_convergence_timeout',
    'receipt["runtime_replica_delta"]',
    "STATIC_REPLICA_MANAGERS.intersection",
    'value != 2',
):
    if upgrade_guard not in q01_upgrade_gate:
        raise SystemExit(f"q01 user-transparent upgrade gate lost invariant: {upgrade_guard}")
if 'after["runtime_spec_replicas"] != before["runtime_spec_replicas"]' in q01_upgrade_gate:
    raise SystemExit("q01 upgrade gate must not treat HPA-owned replica movement as release drift")
if '"/actors' in q01_upgrade_gate or "'/actors" in q01_upgrade_gate:
    raise SystemExit("q01 public upgrade gate must not call the internal Actor API")
if '"DELETE", endpoint + "/v1/workers/"' in q01_upgrade_gate:
    raise SystemExit("q01 upgrade gate must retain its DO Worker fixture instead of leaking one per run")
for upgrade_tat_guard in (
    "/var/lib/actor-build/deploy/actor-bj-q01-current",
    "/var/lib/actor-build/credentials/actor-bj-q01.kubeconfig",
    "--timeout 7200",
    "RUNTIME_EXACT_SCALE_DOWN_ENABLED",
    "RUNTIME_TKE_OIDC_ROLE_ARN",
    "validate-inventory --lock",
    "resolve_image nats",
    "resolve_image observability-busybox",
    "all-images-$inventory_sha.lock.json",
    "AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY=1",
    "FAILED_RELEASE_RECEIPT",
    'AUTONOMY_CONTROL_ALLOW_DEGRADE="\\$allow_degrade"',
    'AUTONOMY_CONTROL_QUALIFICATION_ROLLBACK_RECEIPT',
    "verify-failed-release-rollback.py",
    "verify-user-transparent-upgrade.py",
    "user-transparent-upgrade.py",
    "verify-user-transparent-rollback.py",
    "user-transparent-rollback.py",
):
    if upgrade_tat_guard not in q01_upgrade_tat:
        raise SystemExit(f"q01 TAT upgrade entry lost invariant: {upgrade_tat_guard}")
for builder_guard in (
    "ACTOR_CONTROL_SOURCE",
    "runtime_source=/var/lib/actor-build/deploy/q01-src-${runtime_revision}-${runtime_manifest}",
    'runtime_release_script=$source/infra/cells/deploy/tencent/fleet/runtime/release-runtime.sh',
    "validate-runtime-image.sh",
    '--release-script "$runtime_release_script"',
    "actor-bj-q01.kubeconfig",
    "actor-bj-q01-user-transparent-upgrade-${run_id}.json",
    "actor-bj-q01-user-transparent-rollback-${run_id}.json",
    "ACTOR_IMAGE_INVENTORY must be an immutable builder inventory path",
    "resolve_image nats",
    "resolve_image observability-busybox",
    "verify-failed-release-rollback.py",
    "verify-user-transparent-upgrade.py",
    "verify-user-transparent-rollback.py",
    "AUTONOMY_CONTROL_ALLOW_DEGRADE",
    "AUTONOMY_CONTROL_QUALIFICATION_CANDIDATE_RECEIPT",
    "AUTONOMY_CONTROL_QUALIFICATION_ROLLBACK_RECEIPT",
):
    if builder_guard not in q01_upgrade_builder:
        raise SystemExit(f"q01 approved release command lost builder invariant: {builder_guard}")
for rollback_guard in (
    "rollback receipt does not prove a completed failed release",
    "rollback receipt has no public failure evidence",
    "rollback receipt has incomplete public resource cleanup",
    "rollback receipt is not a public /v1 qualification",
    "failed candidate did not complete the {} rollout",
    "failed receipt has no immutable release log evidence",
    "platform candidate changed the user Worker deployment identity",
    "live runtime is not the distinct failed candidate",
    "require_pod_image(before.get(\"engine_pods\"), rollback_image",
    "require_pod_image(before.get(\"runtime_pods\"), rollback_image",
):
    if rollback_guard not in q01_failed_release_rollback:
        raise SystemExit(f"q01 failed-release rollback verifier lost invariant: {rollback_guard}")
for upgrade_verify_guard in (
    'document["public_api_only"] is True',
    '"container/workerd-host"',
    'before.isdisjoint(after_uids)',
    'probe["failures"] == []',
    'document["public_worker_before"] == document["public_worker_after"]',
):
    if upgrade_verify_guard not in q01_upgrade_verifier:
        raise SystemExit(f"q01 user-transparent upgrade verifier lost invariant: {upgrade_verify_guard}")
for rollback_gate_guard in (
    '"public_api_only": True',
    'receipt["candidate_probe"]',
    'receipt["public_worker_before"]',
    'receipt["public_worker_after"]',
    'value != 1',
    'value != 2',
    'require_pre_cleanup=False',
    'receipt.get("verdict") == "passed"',
):
    if rollback_gate_guard not in q01_rollback_gate:
        raise SystemExit(f"q01 user-transparent rollback gate lost invariant: {rollback_gate_guard}")
for rollback_verify_guard in (
    'failed["rollback_objects_retained"] is True',
    'source["sha256"] == hashlib.sha256(failed_bytes).hexdigest()',
    'item.get("error") or (item.get("status") == 200 and item.get("request_id"))',
    'isinstance(campaign["failures"], list)',
    'document["public_worker_before"] == document["public_worker_after"]',
    'item["value"] == 2',
    'document["pre_cleanup_verification"] == result',
):
    if rollback_verify_guard not in q01_rollback_verifier:
        raise SystemExit(f"q01 user-transparent rollback verifier lost invariant: {rollback_verify_guard}")
for candidate_guard in (
    "BASE_RUNTIME_IMAGE CANDIDATE_TAG",
    "q01-semantic-failure-",
    'cp -al "$source/." "$candidate/"',
    'sha256sum --check .actor-source/RELEASE_SHA256SUMS',
    'candidateSourceManifestSHA256',
    'candidate_source=/var/lib/actor-build/deploy/q01-src-${expected_revision}-${candidate_manifest_sha}',
    'install -m 0644 "$candidate_manifest" "$candidate_staging/.actor-source/RELEASE_SHA256SUMS"',
    'chmod -R a-w "$candidate_staging"',
    "printf 'repository=%q\\n' \"$repository\"",
    'buildah push --authfile "$auth" --digestfile "$candidate_digest_file"',
    "RIVET_PUSH_IMAGE=0",
    '((build_status == 0)) || exit "$build_status"',
    '.["fleet.actor.dev/source-manifest-sha256"]',
    '"candidateSourcePath":candidate_source',
    '"resumedPublishedImage":resumed=="true"',
    '"intentionallyNotProduction":True',
    '"affectedWorker":"q01-platform-upgrade-gate"',
):
    if candidate_guard not in q01_semantic_candidate:
        raise SystemExit(f"q01 semantic-failure candidate builder lost invariant: {candidate_guard}")
if ".FromImageDigest" in q01_semantic_candidate:
    raise SystemExit("q01 semantic-failure resume must use the registry push digest, not FromImageDigest")
if "ACTOR_PRODUCT_BUILD_RECEIPT=" in q01_semantic_candidate:
    raise SystemExit("q01 intentionally bad image must not mint a production build receipt")
if 'worker.worker != "q01-platform-upgrade-gate"' not in q01_semantic_patch:
    raise SystemExit("q01 semantic-failure patch is not bounded to the qualification Worker")
if r'path}\\n" for path' in q01_semantic_candidate or r'path}\n" for path' not in q01_semantic_candidate:
    raise SystemExit("q01 semantic-failure candidate manifest must contain real newline escapes")
for launch_guard in (
    "/var/lib/actor-build/deploy/actor-bj-q01-current",
    "operations_env=/etc/actor/rivet-autonomy-audit.env",
    'export KUBECONFIG=\\$KUBECONFIG_PATH',
    '--timeout "$tat_timeout_seconds"',
    "14400 <= tat_timeout <= 86400",
    "1 <= actors <= 1_000_000",
    "RELEASE_SHA256SUMS",
):
    if launch_guard not in cell_autoscale_tat:
        raise SystemExit(f"Cell TAT launch entry lost invariant: {launch_guard}")
for promotion_guard in (
    "ACTOR_BUILD_PYTHON:-python3.11",
    'sys.version_info[:2] == (3, 11)',
    'python_shim=$(mktemp -d)',
    "q01-src-([0-9a-f]{40})-([0-9a-f]{64})",
    'expected_revision=${BASH_REMATCH[1]}',
    'expected_manifest_sha=${BASH_REMATCH[2]}',
    'revision == "$expected_revision"',
    'manifest_sha == "$expected_manifest_sha"',
    "sha256sum --check",
    "verify-manifests.sh",
    'mv -Tf "$temporary_link" "$link"',
    "source-promotions",
):
    if promotion_guard not in q01_source_promoter:
        raise SystemExit(f"q01 source promotion lost invariant: {promotion_guard}")
for materializer_guard in (
    "--exclude='./target'",
    "source staging inherited a root target directory",
    "apply-source-delta.sh",
    "RIVET_BASE_REVISION",
    "RIVET_SOURCE_REVISION",
    "RELEASE_SHA256SUMS",
):
    if materializer_guard not in q01_source_materializer:
        raise SystemExit(f"q01 source materialization lost cache/identity guard: {materializer_guard}")
if 'chmod -R a-w "$target"' not in q01_source_promoter:
    raise SystemExit("q01 promoted source must be marked read-only")
for launch_guard in (
    "q01-src-([0-9a-f]{40})-([0-9a-f]{64})",
    'source_revision == "\$expected_revision"',
    'source_manifest_sha == "\$expected_manifest_sha"',
):
    if launch_guard not in cell_autoscale_tat:
        raise SystemExit(f"Cell TAT source identity lost invariant: {launch_guard}")
for preflight_guard in (
    "imagePullPolicy\":\"Always",
    '"automountServiceAccountToken":False',
    '"nodeName":node_name',
    'state["terminated"].get("exitCode") != expected_exit',
    "ACTOR_IMAGE_PREFLIGHT_EXPECTED_EXIT_CODE",
    '3<<<"$nodes"',
    'json.load(os.fdopen(3))',
    '3<<<"$pods"',
    'kubectl "${kubeconfig_args[@]}" -n "$namespace" delete pods -l "$selector"',
):
    if preflight_guard not in image_preflight:
        raise SystemExit(f"shared immutable-image preflight lost invariant: {preflight_guard}")
if '"$nodes" "$@"' in image_preflight or '"$expected_exit_code" "$pods"' in image_preflight:
    raise SystemExit("shared immutable-image preflight must not pass Kubernetes lists through argv")
if q01_code_plane_installer.count('preflight-image-pull.sh') != 2:
    raise SystemExit("q01 Code Plane must preflight both immutable images before rollout")
if 'with-autonomy-operation-lock.sh' not in q01_code_plane_installer:
    raise SystemExit("q01 Code Plane rollout must share the fleet operation lock")
job_spec = engine_ha_job["spec"]
pod_spec = job_spec["template"]["spec"]
probe_container = pod_spec["containers"][0]
if job_spec.get("backoffLimit") != 0 or job_spec.get("ttlSecondsAfterFinished") != 3600:
    raise SystemExit("Engine HA probe Job must be one-shot and self-cleaning")
if job_spec.get("activeDeadlineSeconds") != 1800 or pod_spec.get("terminationGracePeriodSeconds") != 180:
    raise SystemExit("Engine HA probe must retain bounded execution and exact-cleanup grace")
probe_env = {item["name"]: item["value"] for item in probe_container.get("env", [])}
if probe_env.get("REQUEST_COUNT") != "1500" or probe_env.get("REQUEST_CONCURRENCY") != "10":
    raise SystemExit("Engine HA probe must retain the qualified 1500-request, 10-client load")
if probe_env.get("TMPDIR") != "/tmp":
    raise SystemExit("Engine HA probe must place temporary state on its writable emptyDir")
probe_mounts = {item["mountPath"]: item for item in probe_container.get("volumeMounts", [])}
if probe_mounts.get("/tmp", {}).get("name") != "tmp" or probe_mounts["/tmp"].get("readOnly") is True:
    raise SystemExit("Engine HA probe /tmp must be backed by a writable volume")
if pod_spec.get("automountServiceAccountToken") is not False or pod_spec.get("restartPolicy") != "Never":
    raise SystemExit("Engine HA probe Job must not mount Kubernetes credentials or retry")
if not requires_node_label(pod_spec, "fleet.actor.dev/control-pool"):
    raise SystemExit("Engine HA probe must not consume Actor compute capacity")
if probe_container.get("securityContext", {}).get("readOnlyRootFilesystem") is not True:
    raise SystemExit("Engine HA probe Job must use a read-only root filesystem")
if probe_container.get("image") != "example.invalid/runtime@sha256:" + "a" * 64:
    raise SystemExit("Engine HA Job must consume the exact deployed Engine image")
if re.search(
    r"\b(?:80000[0-9]|ap-[a-z]+-[0-9]+)\b",
    nats_manifest + runtime_manifest + runtime_qualifier + engine_ha_probe + engine_ha_qualifier + engine_ha_job_template,
):
    raise SystemExit("runtime scheduling and qualification must not hard-code TKE zones")

if len(native_machine_sets) != 1 or native_machine_sets[0]["metadata"]["name"] != "np-fdbpool0":
    raise SystemExit("production Operator Cell must declare one portable multi-zone TKE Native MachineSet")
for machine_set in native_machine_sets:
    name = machine_set["metadata"]["name"]
    spec = machine_set["spec"]
    template = spec["template"]["spec"]
    labels = template["metadata"]["labels"]
    provider = template["providerSpec"]
    if machine_set["apiVersion"] != "node.tke.cloud.tencent.com/v1beta1" or machine_set["kind"] != "MachineSet" or spec["type"] != "Native":
        raise SystemExit(f"{name}: node pool must use the TKE Native MachineSet API")
    if spec["replicas"] != 9 or spec["scaling"] != {"createPolicy": "ZoneEquality", "minReplicas": 9, "maxReplicas": 30}:
        raise SystemExit(f"{name}: production FDB pool must declare a nine-node floor, 30-node ceiling and multi-zone equality")
    if spec["autoRepair"] is not False:
        raise SystemExit(f"{name}: autoRepair requires a successful FDB replacement drill before enablement")
    if spec.get("deletePolicy") != "Newest":
        raise SystemExit(f"{name}: FDB shrink safety requires deterministic newest-Machine deletion")
    if spec["instanceTypes"] != ["SA9.LARGE16"] or set(spec["subnetIDs"]) != {"subnet-qljvksy9", "subnet-k1rounhb", "subnet-kx0feejb"}:
        raise SystemExit(f"{name}: unexpected instance type or regional candidate subnet inventory")
    if labels.get("fleet.actor.dev/cell-name") != "actor-bj-k01" or labels.get("fleet.actor.dev/fdb-dedicated") != "true":
        raise SystemExit(f"{name}: node scheduling identity does not match the FDB Cell")
    if "fleet.actor.dev/fdb-zone" in labels:
        raise SystemExit(f"{name}: node manifests must not hard-code an availability-zone identity")
    if labels.get("node.tke.cloud.tencent.com/spread-placement-group-type") != "HOST":
        raise SystemExit(f"{name}: native nodes must request HOST-level placement spreading")
    if template["taints"] != [{"key": "fleet.actor.dev/fdb-dedicated", "value": "true", "effect": "NoSchedule"}]:
        raise SystemExit(f"{name}: dedicated FDB taint changed")
    if provider["type"] != "Native" or provider["value"]["instanceChargeType"] != "PostpaidByHour":
        raise SystemExit(f"{name}: unexpected native provider or qualification billing mode")
    if provider["value"]["systemDisk"] != {"diskSize": 100, "diskType": "CloudBSSD"} or "dataDisks" in provider["value"]:
        raise SystemExit(f"{name}: system disk must be BSSD and FDB data must remain on retained PVCs")

if len(control_machine_sets) != 1 or control_machine_sets[0]["metadata"]["name"] != "np-control0":
    raise SystemExit("production Cell must declare one portable multi-zone TKE control MachineSet")
control_set = control_machine_sets[0]
control_spec = control_set["spec"]
control_template = control_spec["template"]["spec"]
control_labels = control_template["metadata"]["labels"]
control_provider = control_template["providerSpec"]
if control_set["apiVersion"] != "node.tke.cloud.tencent.com/v1beta1" or control_set["kind"] != "MachineSet" or control_spec["type"] != "Native":
    raise SystemExit("control node pool must use the TKE Native MachineSet API")
if control_spec["replicas"] != 3 or control_spec["scaling"] != {"createPolicy": "ZoneEquality", "minReplicas": 3, "maxReplicas": 3}:
    raise SystemExit("control pool must declare three fixed nodes with multi-zone equality")
if control_spec["autoRepair"] is not False:
    raise SystemExit("control autoRepair requires a successful replacement drill before enablement")
if control_spec["instanceTypes"] != ["SA9.4XLARGE32"] or set(control_spec["subnetIDs"]) != {"subnet-qljvksy9", "subnet-k1rounhb", "subnet-kx0feejb"}:
    raise SystemExit("unexpected control instance type or regional candidate subnet inventory")
if control_labels.get("fleet.actor.dev/cell-name") != "actor-bj-k01" or control_labels.get("fleet.actor.dev/control-pool") != "true":
    raise SystemExit("control node scheduling identity does not match the Cell")
if any(key in control_labels for key in ("fleet.actor.dev/fdb-dedicated", "fleet.actor.dev/runtime-pool", "rivet.dev/compute", "rivet.dev/pvm")):
    raise SystemExit("control capacity must not advertise storage or Actor execution identity")
if control_template.get("taints"):
    raise SystemExit("control nodes must remain available to required cluster services")
if control_labels.get("node.tke.cloud.tencent.com/spread-placement-group-type") != "HOST":
    raise SystemExit("control nodes must request HOST-level placement spreading")
if control_provider["type"] != "Native" or control_provider["value"]["instanceChargeType"] != "PostpaidByHour":
    raise SystemExit("unexpected control native provider or qualification billing mode")
if control_provider["value"]["systemDisk"] != {"diskSize": 100, "diskType": "CloudBSSD"} or "dataDisks" in control_provider["value"]:
    raise SystemExit("control nodes must use only their BSSD system disk")

if len(runtime_machine_sets) != 1 or runtime_machine_sets[0]["metadata"]["name"] != "np-runtime0":
    raise SystemExit("production Cell must declare one portable multi-zone TKE compute MachineSet")
runtime_set = runtime_machine_sets[0]
runtime_spec = runtime_set["spec"]
runtime_template = runtime_spec["template"]["spec"]
runtime_labels = runtime_template["metadata"]["labels"]
runtime_provider = runtime_template["providerSpec"]
if runtime_set["apiVersion"] != "node.tke.cloud.tencent.com/v1beta1" or runtime_set["kind"] != "MachineSet" or runtime_spec["type"] != "Native":
    raise SystemExit("runtime node pool must use the TKE Native MachineSet API")
if runtime_spec["replicas"] != 3 or runtime_spec["scaling"] != {"createPolicy": "ZoneEquality", "minReplicas": 3, "maxReplicas": 3}:
    raise SystemExit("runtime pool must declare three fixed nodes with multi-zone equality")
if runtime_spec["autoRepair"] is not False:
    raise SystemExit("runtime autoRepair requires a successful replacement drill before enablement")
if runtime_spec["instanceTypes"] != ["SA9.LARGE8", "SA9e.LARGE8", "SA5.LARGE8", "S9.LARGE8"] or set(runtime_spec["subnetIDs"]) != {"subnet-qljvksy9", "subnet-k1rounhb", "subnet-kx0feejb"}:
    raise SystemExit("unexpected runtime instance type or regional candidate subnet inventory")
if runtime_labels.get("fleet.actor.dev/cell-name") != "actor-bj-k01" or runtime_labels.get("fleet.actor.dev/runtime-pool") != "true" or runtime_labels.get("rivet.dev/compute") != "true":
    raise SystemExit("runtime node scheduling identity does not match the Cell")
if any(key in runtime_labels for key in ("fleet.actor.dev/fdb-dedicated", "fleet.actor.dev/control-pool", "rivet.dev/pvm")):
    raise SystemExit("ordinary runtime capacity must not advertise control, FDB, or unqualified PVM identity")
if runtime_template.get("taints") != [
    {"key": "rivet.dev/compute", "value": "true", "effect": "NoSchedule"},
    {"key": "fleet.actor.dev/runtime-admission", "value": "pending", "effect": "NoSchedule"},
]:
    raise SystemExit("runtime capacity must carry the compute and default-deny admission taints")
if "node.tke.cloud.tencent.com/spread-placement-group-type" in runtime_labels or \
        "node.tke.cloud.tencent.com/spread-placement-group-id" in runtime_labels:
    raise SystemExit("elastic runtime nodes must not inherit a single placement-group quota ceiling")
if runtime_provider["type"] != "Native" or runtime_provider["value"]["instanceChargeType"] != "PostpaidByHour":
    raise SystemExit("unexpected runtime native provider or qualification billing mode")
if runtime_provider["value"]["systemDisk"] != {"diskSize": 100, "diskType": "CloudBSSD"} or "dataDisks" in runtime_provider["value"]:
    raise SystemExit("runtime nodes must use only their BSSD system disk")
if set(control_labels).intersection({"fleet.actor.dev/runtime-pool", "rivet.dev/compute", "rivet.dev/pvm"}) or "fleet.actor.dev/control-pool" in runtime_labels:
    raise SystemExit("control and Actor compute node identities must remain mutually exclusive")

documents = [document for document in yaml.safe_load_all(fleet) if document]
profile = next(
    document for document in documents if document.get("kind") == "RivetCellProfile"
)
if not next(document for document in documents if document.get("kind") == "RivetCell" and document["metadata"]["name"] == "actor-bj-b01")["spec"]["cos"]["coldBucket"].startswith(profile["spec"]["cos"]["coldBucketPrefix"]):
    raise SystemExit("Cell B cold bucket must use the profile's no-versioning namespace")
if not next(document for document in documents if document.get("kind") == "RivetCell" and document["metadata"]["name"] == "actor-bj-b01")["spec"]["cos"]["backupBucket"].startswith(profile["spec"]["cos"]["backupBucketPrefix"]):
    raise SystemExit("Cell B backup bucket must use the profile's no-versioning namespace")
shard_class = next(
    document for document in documents if document.get("kind") == "ShardClass"
)
canonical_profile = json.dumps(
    profile["spec"], sort_keys=True, separators=(",", ":")
).encode()
expected_profile_digest = "sha256:" + hashlib.sha256(canonical_profile).hexdigest()
actual_profile_digest = shard_class["spec"]["profileRef"]["digest"]
if actual_profile_digest != expected_profile_digest:
    raise SystemExit(
        "ShardClass profile digest is stale: "
        f"expected {expected_profile_digest}, got {actual_profile_digest}"
    )

print("manifest_sha256", hashlib.sha256((crds + fleet + storage).encode()).hexdigest())
print("fleet_manifest_invariants=passed")
PY
