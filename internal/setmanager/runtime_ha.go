package setmanager

import (
	"fmt"
	"strings"
	"time"
)

const (
	SetRuntimeHAPending  = "pending"
	SetRuntimeHAHealthy  = "healthy"
	SetRuntimeHADegraded = "degraded"

	defaultTrafficHATopologyKey     = "topology.kubernetes.io/zone"
	defaultTrafficHAPDBMinAvailable = 1
)

type SetRuntimeHAObservation struct {
	Status          string
	DesiredReplicas int
	ReadyReplicas   int
	PDBHealthy      bool
	TopologyKey     string
	Error           string
	CheckedAt       time.Time
}

func EffectiveTrafficHAPolicy(fleet LLMFleet, fallbackReplicas int) LLMFleetTrafficAvailability {
	return normalizeTrafficHAPolicy(fleet.Spec.Availability.Traffic, fallbackReplicas)
}

func normalizeTrafficHAPolicy(policy LLMFleetTrafficAvailability, fallbackReplicas int) LLMFleetTrafficAvailability {
	if policy.MinReplicas <= 0 {
		policy.MinReplicas = fallbackReplicas
	}
	if policy.MinReplicas <= 0 {
		policy.MinReplicas = 1
	}
	if strings.TrimSpace(policy.TopologyKey) == "" {
		policy.TopologyKey = defaultTrafficHATopologyKey
	}
	if policy.PDBMinAvailable <= 0 {
		policy.PDBMinAvailable = defaultTrafficHAPDBMinAvailable
	}
	return policy
}

func ObserveFleetRuntimeHA(fleet LLMFleet, policy LLMFleetTrafficAvailability, checkedAt time.Time) map[string]SetRuntimeHAObservation {
	policy = normalizeTrafficHAPolicy(policy, 1)
	deploymentByRuntime := make(map[string]LLMFleetTrafficDeploymentStatus, len(fleet.Status.TrafficDeployments))
	for _, deployment := range fleet.Status.TrafficDeployments {
		deploymentByRuntime[runtimeStatusKey(deployment.SetID, deployment.Generation)] = deployment
	}
	pdbByRuntime := make(map[string]LLMFleetTrafficPDBStatus, len(fleet.Status.TrafficPodDisruptionBudgets))
	for _, pdb := range fleet.Status.TrafficPodDisruptionBudgets {
		pdbByRuntime[runtimeStatusKey(pdb.SetID, pdb.Generation)] = pdb
	}

	observations := make(map[string]SetRuntimeHAObservation, len(fleet.Spec.Sets))
	for _, set := range fleet.Spec.Sets {
		runtime, ok := firstTrafficRuntimeForSet(fleet.Spec.TrafficRuntimes, set.Name)
		if !ok {
			observations[set.Name] = SetRuntimeHAObservation{
				Status: SetRuntimeHAPending, DesiredReplicas: policy.MinReplicas,
				TopologyKey: policy.TopologyKey, Error: "versioned traffic runtime is not ready", CheckedAt: checkedAt,
			}
			continue
		}
		key := runtimeStatusKey(runtime.SetID, runtime.Generation)
		deployment, deploymentOK := deploymentByRuntime[key]
		pdb, pdbOK := pdbByRuntime[key]
		if !deploymentOK || !pdbOK {
			missing := "traffic Deployment status"
			if deploymentOK {
				missing = "traffic PodDisruptionBudget status"
			}
			observations[set.Name] = SetRuntimeHAObservation{
				Status: SetRuntimeHAPending, DesiredReplicas: policy.MinReplicas,
				TopologyKey: policy.TopologyKey, Error: missing + " is not projected", CheckedAt: checkedAt,
			}
			continue
		}
		observations[set.Name] = EvaluateSetRuntimeHA(runtime, deployment, pdb, policy, checkedAt)
	}
	return observations
}

func EvaluateSetRuntimeHA(runtime LLMFleetTrafficRuntime, deployment LLMFleetTrafficDeploymentStatus, pdb LLMFleetTrafficPDBStatus, policy LLMFleetTrafficAvailability, checkedAt time.Time) SetRuntimeHAObservation {
	result := SetRuntimeHAObservation{
		Status: SetRuntimeHAHealthy, DesiredReplicas: policy.MinReplicas,
		ReadyReplicas: deployment.ReadyReplicas, TopologyKey: policy.TopologyKey, CheckedAt: checkedAt,
	}
	errors := make([]string, 0, 5)
	if runtime.Replicas < policy.MinReplicas || deployment.DesiredReplicas < policy.MinReplicas {
		errors = append(errors, fmt.Sprintf("desired replicas below HA floor %d", policy.MinReplicas))
	}
	if deployment.ObservedGeneration < deployment.ObjectGeneration {
		errors = append(errors, "traffic Deployment has not observed the latest generation")
	}
	if deployment.ReadyReplicas < policy.MinReplicas {
		errors = append(errors, fmt.Sprintf("ready replicas %d below desired %d", deployment.ReadyReplicas, policy.MinReplicas))
	}
	if deployment.AvailableReplicas < policy.MinReplicas {
		errors = append(errors, fmt.Sprintf("available replicas %d below desired %d", deployment.AvailableReplicas, policy.MinReplicas))
	}
	result.PDBHealthy = pdb.MinAvailable == policy.PDBMinAvailable &&
		pdb.ExpectedPods >= policy.MinReplicas &&
		pdb.CurrentHealthy >= policy.MinReplicas &&
		pdb.DisruptionsAllowed >= 1
	if !result.PDBHealthy {
		errors = append(errors, "traffic PodDisruptionBudget is not healthy")
	}
	if len(errors) > 0 {
		result.Status = SetRuntimeHADegraded
		result.Error = strings.Join(errors, "; ")
	}
	return result
}

func runtimeStatusKey(setID string, generation int64) string {
	return fmt.Sprintf("%s\x00%d", setID, generation)
}
