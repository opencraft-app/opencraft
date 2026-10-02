package runtimecapacity

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"

	"github.com/rivet-dev/rivet/infra/cells/internal/runtimecapacity/admission"
)

const (
	DrainAnnotation             = "fleet.actor.dev/runtime-capacity-drain"
	DrainTaintKey               = "fleet.actor.dev/runtime-capacity-drain"
	DownscaleIntentAnnotation   = "fleet.actor.dev/runtime-capacity-downscale-intent"
	DownscaleReceiptAnnotation  = "fleet.actor.dev/runtime-capacity-last-downscale-receipt"
	QualificationHoldAnnotation = "fleet.actor.dev/runtime-capacity-qualification-hold"
	RepairDrainStateAnnotation  = "fleet.actor.dev/runtime-machine-repair-drain"
	machineListLimit            = int64(500)
)

var (
	machineSetResource = schema.GroupVersionResource{
		Group: "node.tke.cloud.tencent.com", Version: "v1beta1", Resource: "machinesets",
	}
	machineResource = schema.GroupVersionResource{
		Group: "node.tke.cloud.tencent.com", Version: "v1beta1", Resource: "machines",
	}
)

type ControllerConfig struct {
	Namespace              string
	CellName               string
	StatefulSetName        string
	MachineSetName         string
	ProviderClusterID      string
	MinReplicas            int64
	MaxReplicas            int64
	MaxRepairSurge         int64
	RequiredZones          int
	TargetedRepairEnabled  bool
	RuntimeAuthToken       string
	ManagementPort         int
	RepairDrainTimeout     time.Duration
	ScaleDownStabilization time.Duration
	ReconcileInterval      time.Duration
}

type ExactScaleDownRequest struct {
	ClusterID      string
	MachineName    string
	MachineUID     string
	NodeName       string
	NodeUID        string
	MachineSetName string
	MachineSetUID  string
	FromReplicas   int64
	ToReplicas     int64
}

type ExactScaleDownResponse struct {
	RequestID string
}

// ExactScaleDownProvider owns the one operation Kubernetes cannot express:
// atomically name one provider Machine and lower the native node-pool desired
// count. The controller never retries an ambiguous destructive request.
type ExactScaleDownProvider interface {
	DeleteMachineAndScaleDown(context.Context, ExactScaleDownRequest) (ExactScaleDownResponse, error)
}

type Controller struct {
	Kubernetes     kubernetes.Interface
	Dynamic        dynamic.Interface
	HTTPClient     *http.Client
	ExactScaleDown ExactScaleDownProvider
	Config         ControllerConfig
	Now            func() time.Time
	Logf           func(string, ...any)

	downscaleDesired int64
	downscaleCurrent int64
	downscaleSince   time.Time
}

type downscaleIntent struct {
	Version        int       `json:"version"`
	Phase          string    `json:"phase"`
	ClusterID      string    `json:"cluster_id"`
	MachineName    string    `json:"machine_name"`
	MachineUID     string    `json:"machine_uid"`
	NodeName       string    `json:"node_name"`
	NodeUID        string    `json:"node_uid"`
	MachineSetName string    `json:"machine_set_name"`
	MachineSetUID  string    `json:"machine_set_uid"`
	DesiredHosts   int64     `json:"desired_hosts"`
	FromReplicas   int64     `json:"from_replicas"`
	ToReplicas     int64     `json:"to_replicas"`
	CreatedAt      time.Time `json:"created_at"`
	AttemptAt      time.Time `json:"attempt_at,omitempty"`
	Attempts       int       `json:"attempts,omitempty"`
	RequestID      string    `json:"request_id,omitempty"`
}

type downscaleReceipt struct {
	Version     int             `json:"version"`
	CompletedAt time.Time       `json:"completed_at"`
	Outcome     string          `json:"outcome"`
	Intent      downscaleIntent `json:"intent"`
}

const (
	downscaleIntentVersion                    = 2
	downscaleReceiptVersion                   = 2
	downscalePhasePrepared                    = "prepared"
	downscalePhaseIssued                      = "issued"
	downscaleOutcomeAcknowledged              = "provider_acknowledged"
	downscaleOutcomeAmbiguousExactConvergence = "observed_exact_convergence_after_ambiguous_response"
	// A bounded batch avoids the O(minutes) one-Machine loop at hundreds of
	// Nodes while limiting stranded pending capacity during an AZ shortage.
	maxTopologyRepairBatch int64 = 32
)

type ReconcileResult struct {
	DesiredHosts int64
	DesiredNodes int64
	UsableNodes  int64
	Action       string
	Candidate    string
}

func (c *Controller) Run(ctx context.Context) {
	interval := c.Config.ReconcileInterval
	if interval <= 0 {
		interval = 5 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		result, err := c.ReconcileOnce(ctx)
		if err != nil {
			c.logf("runtime capacity reconcile failed: %v", err)
		} else if result.Action != "" {
			c.logf("runtime capacity desired_hosts=%d desired_nodes=%d usable_nodes=%d action=%s candidate=%s",
				result.DesiredHosts, result.DesiredNodes, result.UsableNodes, result.Action, result.Candidate)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (c *Controller) ReconcileOnce(ctx context.Context) (ReconcileResult, error) {
	if err := c.validate(); err != nil {
		return ReconcileResult{}, err
	}
	statefulSet, machineSet, desiredHosts, desiredNodes, statusNodes, err := c.observe(ctx)
	if err != nil {
		return ReconcileResult{}, err
	}
	result := ReconcileResult{DesiredHosts: desiredHosts, DesiredNodes: desiredNodes}
	if desiredHosts < c.Config.MinReplicas || desiredHosts > c.Config.MaxReplicas {
		return result, fmt.Errorf("StatefulSet desired replicas %d are outside [%d,%d]", desiredHosts, c.Config.MinReplicas, c.Config.MaxReplicas)
	}
	if raw := machineSet.GetAnnotations()[DownscaleIntentAnnotation]; raw != "" {
		return c.reconcileDownscaleIntent(ctx, result, statefulSet, machineSet, raw)
	}
	inventory, err := c.capacityInventory(ctx, string(machineSet.GetUID()))
	if err != nil {
		return result, err
	}
	result.UsableNodes = inventory.usableNodes
	// The Node placement fence is written before the durable MachineSet intent.
	// If the process exits in that narrow interval, no provider request can have
	// been issued, but the fenced Node is excluded from usable capacity forever.
	// Confirm the no-intent snapshot at the API server before restoring any
	// orphaned fence. A stale GET must not authorize clearing a committed intent's
	// fence. Restart stabilization after restoration on the next reconciliation.
	restored, err := c.restoreOrphanedScaleDownFences(ctx, machineSet)
	if err != nil {
		return result, err
	}
	if len(restored) > 0 {
		c.resetDownscale()
		result.Action = "restore-orphaned-scale-down-fence"
		result.Candidate = strings.Join(restored, ",")
		return result, nil
	}
	quarantined := inventory.quarantined
	balancedCapacity, err := balancedRuntimeCapacity(inventory.usableTargets, c.Config.RequiredZones)
	if err != nil {
		return result, err
	}
	preparedFrontierCapacity, err := preparedAdmissionFrontierCapacity(
		inventory.usableTargets, inventory.preparedTargets, c.Config.RequiredZones,
	)
	if err != nil {
		return result, err
	}
	repairSurge := int64(len(quarantined)) + inventory.suspectNodes
	if repairSurge > c.Config.MaxRepairSurge {
		repairSurge = c.Config.MaxRepairSurge
	}
	repairTarget := desiredHosts + repairSurge
	readyNodes, foundReadyNodes, readyNodesErr := unstructured.NestedInt64(machineSet.Object, "status", "readyReplicas")
	if readyNodesErr != nil {
		return result, fmt.Errorf("read runtime MachineSet ready replicas: %w", readyNodesErr)
	}
	providerConverged := foundReadyNodes && statusNodes == desiredNodes && readyNodes == desiredNodes
	// TKE's ZoneEquality policy is a placement preference at Machine creation
	// time; a burst or a temporarily unavailable zone can still leave a live
	// MachineSet skewed. A hard runtime topology spread then has less usable
	// Host capacity than the raw admitted Node count. Once every requested
	// Machine is present and admitted, add only the capacity needed for a
	// maxSkew=1 Host placement. This is non-destructive and serialized: after
	// every provider convergence we recompute from the actual zones rather than
	// trusting that the provider placed the new Machines as predicted.
	steadyBaselineRepair := c.Config.TargetedRepairEnabled && desiredHosts == c.Config.MinReplicas &&
		desiredNodes == desiredHosts && statusNodes == desiredNodes &&
		int64(statefulSet.Status.ReadyReplicas) == desiredHosts && inventory.usableNodes == desiredHosts
	if c.Config.RequiredZones > 0 && !steadyBaselineRepair && inventory.unsettledNodes == 0 &&
		providerConverged && inventory.usableNodes == desiredNodes {
		topologyTarget, err := topologyCapacityTarget(inventory.usableTargets, desiredHosts, c.Config.RequiredZones)
		if err != nil {
			return result, err
		}
		if topologyTarget > repairTarget {
			// Correct at most MaxRepairSurge Nodes per provider convergence.
			// ZoneEquality has produced skew specifically when a burst requested
			// several Machines together; serial correction also bounds wasted
			// capacity when an AZ cannot currently provision the requested type.
			correctiveTarget := desiredNodes + c.Config.MaxRepairSurge
			if correctiveTarget > topologyTarget {
				correctiveTarget = topologyTarget
			}
			if correctiveTarget > repairTarget {
				repairTarget = correctiveTarget
			}
		}
	}
	// Admission opens Nodes only at a common cross-zone frontier. If a provider
	// burst is physically skewed, surplus fast-zone Nodes deliberately remain
	// fenced and usableNodes can no longer equal desiredNodes. Continue asking
	// for one Machine per provider convergence until the admitted topology can
	// actually host every desired Host. This is bounded by MaxReplicas and does
	// not guess which AZ the provider will choose.
	topologyCapacityInsufficient := c.Config.RequiredZones > 0 && !steadyBaselineRepair && balancedCapacity < desiredHosts
	// A completed probe becomes Prepared until every required zone reaches the
	// same admission frontier.  Treat a set consisting entirely of Prepared
	// Nodes as a settled provider round: if that common frontier is still too
	// small, request a bounded share of the missing common frontier and
	// re-observe. Waiting for every Node to be currently usable deadlocks when
	// ZoneEquality returns only a subset of zones, because Prepared Nodes remain
	// fenced and an already-Admitted Node can transiently become unavailable.
	admissionRoundSettled := inventory.admissionInFlightNodes == 0
	if topologyCapacityInsufficient && admissionRoundSettled && providerConverged &&
		preparedFrontierCapacity < desiredHosts && desiredNodes < c.Config.MaxReplicas {
		shortfall := desiredHosts - preparedFrontierCapacity
		batch := (shortfall + int64(c.Config.RequiredZones) - 1) / int64(c.Config.RequiredZones)
		if batch < 1 {
			batch = 1
		}
		if batch > maxTopologyRepairBatch {
			batch = maxTopologyRepairBatch
		}
		if remaining := c.Config.MaxReplicas - desiredNodes; batch > remaining {
			batch = remaining
		}
		if desiredNodes+batch > repairTarget {
			repairTarget = desiredNodes + batch
		}
	}
	if repairTarget > c.Config.MaxReplicas {
		repairTarget = c.Config.MaxReplicas
	}

	if repairTarget > desiredNodes {
		c.resetDownscale()
		if err := c.restoreOwnedNodes(ctx); err != nil {
			return result, err
		}
		target := repairTarget
		if err := c.patchMachineSetReplicas(ctx, machineSet, desiredNodes, target); err != nil {
			return result, err
		}
		result.Action = fmt.Sprintf("scale-up-to-%d", target)
		return result, nil
	}
	if topologyCapacityInsufficient {
		c.resetDownscale()
		if inventory.admissionInFlightNodes > 0 || len(inventory.preparedTargets) > 0 {
			result.Action = "await-runtime-admission-convergence"
		} else if !providerConverged {
			result.Action = "await-runtime-provider-convergence"
		} else {
			result.Action = "await-balanced-runtime-capacity"
		}
		return result, nil
	}
	if machineSet.GetAnnotations()[QualificationHoldAnnotation] != "" {
		// Provider qualification needs admission to remain active for its empty
		// surge Node, but the normal contraction path must not race that exact
		// Machine experiment. A hold never blocks demand-driven scale-up.
		c.resetDownscale()
		result.Action = "qualification-holds-scale-down"
		return result, nil
	}
	if len(quarantined) > 0 {
		topologyContraction := len(quarantined) == 1 &&
			strings.HasPrefix(quarantined[0].state.AttemptUID, "topology-contraction-")
		targetedRepairReady := c.Config.TargetedRepairEnabled &&
			desiredNodes == desiredHosts+c.Config.MaxRepairSurge
		topologyContractionReady := topologyContraction && desiredNodes > desiredHosts
		if len(quarantined) == 1 && (targetedRepairReady || topologyContractionReady) && statusNodes == desiredNodes &&
			int64(statefulSet.Status.ReadyReplicas) == desiredHosts && inventory.usableNodes >= desiredHosts {
			latestStatefulSet, latestMachineSet, latestHosts, latestNodes, latestStatusNodes, observeErr := c.observe(ctx)
			if observeErr != nil {
				return result, observeErr
			}
			latestInventory, inventoryErr := c.capacityInventory(ctx, string(latestMachineSet.GetUID()))
			if inventoryErr != nil {
				return result, inventoryErr
			}
			if latestHosts != desiredHosts || latestNodes != desiredNodes || latestStatusNodes != statusNodes ||
				int64(latestStatefulSet.Status.ReadyReplicas) != desiredHosts || latestInventory.usableNodes < desiredHosts {
				c.resetDownscale()
				result.Action = "revalidate-targeted-repair"
				return result, nil
			}
			latestTarget, found := exactQuarantinedTarget(latestInventory.quarantined, quarantined[0])
			if !found {
				c.resetDownscale()
				result.Action = "revalidate-targeted-repair"
				return result, nil
			}
			ready, drainAction, err := c.prepareQuarantinedHost(ctx, latestStatefulSet, latestTarget)
			if err != nil {
				return result, err
			}
			if !ready {
				c.resetDownscale()
				result.Action = drainAction
				result.Candidate = latestTarget.machine.GetName()
				return result, nil
			}
			if err := c.requireReplacementHostsReady(
				ctx, latestStatefulSet, desiredHosts, latestInventory.usableNodeUIDs,
			); err != nil {
				c.resetDownscale()
				result.Action = "wait-replacement-runtime-hosts"
				result.Candidate = latestTarget.machine.GetName()
				return result, nil
			}
			if topologyContraction {
				// HPA may continue decreasing while the selected Host drains. Move
				// the already quiescent exact Machine into the durable provider
				// protocol and contract only one replica. Any remaining surplus is
				// handled by a later stabilized iteration; never turn one exact
				// deletion into an ambiguous multi-Machine contraction.
				if err := c.cordonOwnedNode(ctx, latestTarget.node, string(latestTarget.machine.GetUID())); err != nil {
					return result, err
				}
				if err := c.requireNodeEmpty(ctx, latestTarget.node.Name); err != nil {
					return result, c.withScaleDownFenceRollback(
						ctx, latestTarget.node, string(latestTarget.machine.GetUID()), err,
					)
				}
				targetReplicas := desiredNodes - 1
				if targetReplicas < desiredHosts {
					return result, c.withScaleDownFenceRollback(
						ctx, latestTarget.node, string(latestTarget.machine.GetUID()),
						fmt.Errorf("topology contraction target %d fell below %d Hosts", targetReplicas, desiredHosts),
					)
				}
				intent := downscaleIntent{
					Version: downscaleIntentVersion, Phase: downscalePhasePrepared,
					ClusterID:   c.Config.ProviderClusterID,
					MachineName: latestTarget.machine.GetName(), MachineUID: string(latestTarget.machine.GetUID()),
					NodeName: latestTarget.node.Name, NodeUID: string(latestTarget.node.UID),
					MachineSetName: latestMachineSet.GetName(), MachineSetUID: string(latestMachineSet.GetUID()),
					DesiredHosts: desiredHosts, FromReplicas: desiredNodes, ToReplicas: targetReplicas, CreatedAt: c.now(),
				}
				if err := c.persistDownscaleIntent(ctx, latestMachineSet, "", intent); err != nil {
					return result, c.withScaleDownFenceRollback(
						ctx, latestTarget.node, string(latestTarget.machine.GetUID()), err,
					)
				}
				c.resetDownscale()
				result.Action = fmt.Sprintf("prepare-exact-topology-contraction-to-%d", targetReplicas)
				result.Candidate = latestTarget.machine.GetName()
				return result, nil
			}
			if err := c.deleteExactQuarantinedMachine(ctx, latestTarget); err != nil {
				return result, err
			}
			latestStatefulSet, latestMachineSet, latestHosts, _, _, observeErr = c.observe(ctx)
			if observeErr != nil {
				return result, fmt.Errorf("observe runtime capacity after targeted repair: %w", observeErr)
			}
			latestDesired, found, nestedErr := unstructured.NestedInt64(latestMachineSet.Object, "spec", "replicas")
			if nestedErr != nil || !found {
				return result, fmt.Errorf("runtime MachineSet lost desired replicas after targeted repair")
			}
			// A concurrent HPA increase wins: deleting the exact unusable Machine
			// is safe, but its surge capacity must not be released underneath new
			// demand.
			if latestHosts == desiredHosts && int64(latestStatefulSet.Status.ReadyReplicas) == desiredHosts && latestDesired == desiredNodes {
				if err := c.patchMachineSetReplicas(ctx, latestMachineSet, latestDesired, desiredHosts); err != nil {
					return result, err
				}
			}
			c.resetDownscale()
			result.Action = "delete-exact-quarantined-machine"
			result.Candidate = latestTarget.machine.GetName()
			return result, nil
		}
		// A generic MachineSet contraction cannot prove which Machine TKE will
		// delete. Keep the exact bad Node fenced and the bounded replacement
		// surge alive until a UID-targeted provider operation is qualified.
		c.resetDownscale()
		result.Action = "quarantine-awaits-targeted-repair"
		return result, nil
	}
	if inventory.suspectNodes > 0 {
		// Keep one pre-admitted replacement warm while the Node-local fault
		// persistence window runs. Recovery releases it through the ordinary
		// newest-empty contraction path; quarantine advances to exact repair.
		c.resetDownscale()
		result.Action = "suspect-awaits-recovery-or-quarantine"
		return result, nil
	}
	if c.Config.TargetedRepairEnabled && c.Config.RequiredZones > 0 &&
		desiredHosts == c.Config.MinReplicas && desiredNodes == desiredHosts &&
		statusNodes == desiredNodes && int64(statefulSet.Status.ReadyReplicas) == desiredHosts &&
		inventory.usableNodes == desiredHosts {
		candidate, err := c.topologyRepairCandidate(inventory)
		if err != nil {
			return result, err
		}
		if candidate != nil {
			if err := c.quarantineTopologyTarget(ctx, *candidate, "topology"); err != nil {
				return result, err
			}
			c.resetDownscale()
			result.Action = "quarantine-runtime-topology-skew"
			result.Candidate = candidate.machine.GetName()
			return result, nil
		}
	}

	if desiredHosts == desiredNodes {
		c.resetDownscale()
		// A MachineSet may still be deleting the cordoned node after spec.replicas
		// converged. Do not resurrect it while status still exceeds the target.
		if statusNodes <= desiredNodes {
			if err := c.restoreOwnedNodes(ctx); err != nil {
				return result, err
			}
		}
		if inventory.usableNodes < desiredHosts {
			result.Action = "await-usable-capacity"
		}
		return result, nil
	}

	now := time.Now().UTC()
	if c.Now != nil {
		now = c.Now().UTC()
	}
	// A lower Host target during an already-qualified contraction episode only
	// increases the Machine surplus. Preserve the original low-capacity
	// observation window so exact empty-Machine deletion can progress alongside
	// serial Host drain. Any Host increase, MachineSet shape change, or missing
	// observation still restarts stabilization; every destructive operation
	// below independently revalidates readiness, topology, emptiness and UIDs.
	if c.downscaleSince.IsZero() || c.downscaleCurrent != desiredNodes || desiredHosts > c.downscaleDesired {
		c.downscaleDesired = desiredHosts
		c.downscaleCurrent = desiredNodes
		c.downscaleSince = now
		result.Action = "observe-scale-down"
		return result, nil
	}
	if desiredHosts < c.downscaleDesired {
		c.downscaleDesired = desiredHosts
	}
	if now.Sub(c.downscaleSince) < c.Config.ScaleDownStabilization {
		return result, nil
	}
	if int64(statefulSet.Status.ReadyReplicas) != desiredHosts || statusNodes != desiredNodes || inventory.usableNodes <= desiredHosts {
		if inventory.usableNodes <= desiredHosts {
			result.Action = "await-usable-capacity"
		}
		return result, nil
	}

	contractionCandidates, err := topologyContractionCandidates(inventory.usableTargets, desiredHosts, c.Config.RequiredZones)
	if err != nil {
		return result, err
	}
	eligibleMachines := make(map[string]struct{}, len(contractionCandidates))
	for _, target := range contractionCandidates {
		eligibleMachines[string(target.machine.GetUID())] = struct{}{}
	}
	candidate, node, err := c.safeEmptyMachine(ctx, desiredNodes, eligibleMachines)
	if err != nil {
		return result, err
	}
	if candidate == nil {
		// The final surplus Machine can be the empty Node that repaired a
		// cross-zone imbalance. Deleting that Node would immediately recreate
		// the imbalance and cause an add/delete loop. Move one Host off the
		// overrepresented zone through the existing fail-closed drain protocol,
		// then delete that exact Machine instead.
		if c.Config.RequiredZones > 1 && c.ExactScaleDown != nil && c.Config.ProviderClusterID != "" &&
			c.Config.MaxRepairSurge == 1 &&
			desiredNodes == desiredHosts+1 && len(contractionCandidates) > 0 {
			target := contractionCandidates[0]
			if err := c.quarantineTopologyTarget(ctx, target, "topology-contraction"); err != nil {
				return result, err
			}
			c.resetDownscale()
			result.Action = "quarantine-runtime-topology-contraction"
			result.Candidate = target.machine.GetName()
			return result, nil
		}
		return result, fmt.Errorf("no empty runtime Machine is topology-safe for exact scale-down")
	}
	if c.ExactScaleDown == nil || c.Config.ProviderClusterID == "" {
		return result, fmt.Errorf("exact provider scale-down is unavailable; refusing ambiguous MachineSet contraction")
	}
	if err := c.cordonOwnedNode(ctx, node, string(candidate.GetUID())); err != nil {
		return result, err
	}
	// Close both observation/action races: no new workload may appear after the
	// cordon, and a concurrent HPA increase must win over node deletion.
	if err := c.requireNodeEmpty(ctx, node.Name); err != nil {
		return result, c.withScaleDownFenceRollback(ctx, node, string(candidate.GetUID()), err)
	}
	_, latestMachineSet, latestHosts, latestNodes, _, err := c.observe(ctx)
	if err != nil {
		return result, c.withScaleDownFenceRollback(ctx, node, string(candidate.GetUID()), err)
	}
	if latestHosts != desiredHosts || latestNodes != desiredNodes {
		if err := c.restoreScaleDownFence(ctx, node, string(candidate.GetUID())); err != nil {
			return result, err
		}
		c.resetDownscale()
		return result, nil
	}
	latestInventory, err := c.capacityInventory(ctx, string(latestMachineSet.GetUID()))
	if err != nil {
		return result, c.withScaleDownFenceRollback(ctx, node, string(candidate.GetUID()), err)
	}
	latestBalancedCapacity, err := balancedRuntimeCapacity(latestInventory.usableTargets, c.Config.RequiredZones)
	if err != nil {
		return result, c.withScaleDownFenceRollback(ctx, node, string(candidate.GetUID()), err)
	}
	if latestBalancedCapacity < latestHosts {
		return result, c.withScaleDownFenceRollback(
			ctx, node, string(candidate.GetUID()),
			fmt.Errorf("runtime topology capacity fell to %d below %d Hosts after scale-down fence", latestBalancedCapacity, latestHosts),
		)
	}
	target := desiredNodes - 1
	if target < desiredHosts {
		target = desiredHosts
	}
	intent := downscaleIntent{
		Version: downscaleIntentVersion, Phase: downscalePhasePrepared,
		ClusterID:   c.Config.ProviderClusterID,
		MachineName: candidate.GetName(), MachineUID: string(candidate.GetUID()),
		NodeName: node.Name, NodeUID: string(node.UID),
		MachineSetName: latestMachineSet.GetName(), MachineSetUID: string(latestMachineSet.GetUID()),
		DesiredHosts: desiredHosts, FromReplicas: desiredNodes, ToReplicas: target, CreatedAt: c.now(),
	}
	if err := c.persistDownscaleIntent(ctx, latestMachineSet, "", intent); err != nil {
		return result, c.withScaleDownFenceRollback(ctx, node, string(candidate.GetUID()), err)
	}
	c.resetDownscale()
	result.Action = fmt.Sprintf("prepare-exact-scale-down-to-%d", target)
	result.Candidate = candidate.GetName()
	return result, nil
}

func (c *Controller) withScaleDownFenceRollback(
	ctx context.Context, original *corev1.Node, machineUID string, cause error,
) error {
	if err := c.restoreScaleDownFence(ctx, original, machineUID); err != nil {
		return fmt.Errorf("%v; additionally failed to restore exact scale-down fence: %w", cause, err)
	}
	return cause
}

func (c *Controller) restoreScaleDownFence(ctx context.Context, original *corev1.Node, machineUID string) error {
	node, err := c.Kubernetes.CoreV1().Nodes().Get(ctx, original.Name, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("re-read runtime Node for scale-down rollback: %w", err)
	}
	if node.UID != original.UID || node.Annotations[DrainAnnotation] != machineUID ||
		drainTaintIndex(node.Spec.Taints, machineUID) < 0 {
		return fmt.Errorf("runtime Node scale-down fence identity changed before rollback")
	}
	return c.restoreOwnedNode(ctx, node)
}

type quarantinedTarget struct {
	node    *corev1.Node
	machine *unstructured.Unstructured
	state   admission.State
}

type nodeCapacityInventory struct {
	usableNodes     int64
	usableNodeUIDs  map[string]string
	usableTargets   []quarantinedTarget
	preparedTargets []quarantinedTarget
	suspectNodes    int64
	unsettledNodes  int64
	// admissionInFlightNodes is deliberately narrower than unsettledNodes.
	// An Admitted or Prepared Node whose current health keeps it out of usable
	// capacity has completed its admission round; treating it as an in-flight
	// probe deadlocks topology compensation. Missing identity/evidence and the
	// Pending/Probing/Blocked/Cancelled phases still serialize provider rounds.
	admissionInFlightNodes int64
	quarantined            []quarantinedTarget
}

func (c *Controller) reconcileDownscaleIntent(
	ctx context.Context,
	result ReconcileResult,
	statefulSet *appsv1.StatefulSet,
	machineSet *unstructured.Unstructured,
	raw string,
) (ReconcileResult, error) {
	var intent downscaleIntent
	if err := json.Unmarshal([]byte(raw), &intent); err != nil {
		return result, fmt.Errorf("decode exact scale-down intent: %w", err)
	}
	if err := c.validateDownscaleIntent(intent, machineSet); err != nil {
		return result, err
	}
	result.Candidate = intent.MachineName
	desiredHosts := result.DesiredHosts
	desiredNodes, found, err := unstructured.NestedInt64(machineSet.Object, "spec", "replicas")
	if err != nil || !found {
		return result, fmt.Errorf("runtime MachineSet lost desired replicas while exact scale-down is pending")
	}
	machine, getErr := c.Dynamic.Resource(machineResource).Get(ctx, intent.MachineName, metav1.GetOptions{})
	if apierrors.IsNotFound(getErr) {
		if desiredNodes != intent.ToReplicas {
			result.Action = "await-exact-scale-down-capacity-convergence"
			return result, nil
		}
		remainingNode, nodeErr := c.Kubernetes.CoreV1().Nodes().Get(ctx, intent.NodeName, metav1.GetOptions{})
		if nodeErr == nil {
			if string(remainingNode.UID) != intent.NodeUID {
				return result, fmt.Errorf("replacement Node reused an exact scale-down name")
			}
			result.Action = "await-exact-scale-down-node-deletion"
			return result, nil
		}
		if !apierrors.IsNotFound(nodeErr) {
			return result, fmt.Errorf("confirm exact scale-down Node deletion: %w", nodeErr)
		}
		if err := c.completeDownscaleIntent(ctx, machineSet, raw, intent); err != nil {
			return result, err
		}
		// One stable Host contraction episode may leave many empty Machines.
		// Revalidate exact inventory, topology and emptiness for every deletion,
		// but do not repay the stabilization window after each successfully
		// observed one-Machine operation. A changed desired Host count still
		// invalidates these fields on the next reconcile and starts a fresh wait.
		c.downscaleDesired = intent.DesiredHosts
		c.downscaleCurrent = intent.ToReplicas
		c.downscaleSince = c.now().Add(-c.Config.ScaleDownStabilization)
		result.Action = fmt.Sprintf("complete-exact-scale-down-to-%d", intent.ToReplicas)
		return result, nil
	}
	if getErr != nil {
		return result, fmt.Errorf("re-read exact scale-down Machine: %w", getErr)
	}
	if string(machine.GetUID()) != intent.MachineUID {
		return result, fmt.Errorf("exact scale-down Machine UID changed")
	}
	node, err := c.Kubernetes.CoreV1().Nodes().Get(ctx, intent.NodeName, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) && intent.Phase == downscalePhaseIssued && intent.Attempts > 0 {
			// TKE may remove the Node just before its owning Machine becomes
			// NotFound. The provider operation is already durably marked as
			// attempted, so this is forward convergence, not missing identity.
			// Keep observing the exact Machine and replica target; completion
			// still requires both objects gone in the branch above.
			result.Action = "await-exact-scale-down-deletion"
			return result, nil
		}
		return result, fmt.Errorf("re-read exact scale-down Node: %w", err)
	}
	if string(node.UID) != intent.NodeUID {
		return result, fmt.Errorf("exact scale-down Node ownership fence changed")
	}
	if node.Annotations[DrainAnnotation] != intent.MachineUID ||
		drainTaintIndex(node.Spec.Taints, intent.MachineUID) < 0 {
		// A stale no-intent snapshot could previously restore this Node after the
		// prepared intent had committed. No provider side effect is possible until
		// Attempts is persisted. Cancel only an entirely absent fence on the exact
		// original Node, then rerun full demand/topology/emptiness admission. Never
		// overwrite another owner's fence or retry an attempted provider operation.
		if intent.Attempts == 0 && intent.RequestID == "" &&
			node.Annotations[DrainAnnotation] == "" && !hasTaintKey(node.Spec.Taints, DrainTaintKey) {
			if err := c.clearDownscaleIntent(ctx, machineSet, raw); err != nil {
				return result, err
			}
			c.resetDownscale()
			result.Action = "abort-unfenced-exact-scale-down"
			return result, nil
		}
		return result, fmt.Errorf("exact scale-down Node ownership fence changed")
	}
	if machine.GetDeletionTimestamp() != nil || node.DeletionTimestamp != nil {
		result.Action = "await-exact-scale-down-deletion"
		return result, nil
	}
	if err := c.requireNodeEmpty(ctx, node.Name); err != nil {
		return result, err
	}

	switch intent.Phase {
	case downscalePhasePrepared:
		// No provider request can precede the durable issued transition. Demand
		// growth therefore aborts a merely prepared operation without ambiguity.
		// A lower Host target only increases surplus capacity; refresh the same
		// UID-fenced intent instead of discarding a safe contraction in progress.
		if desiredNodes != intent.FromReplicas || desiredHosts > intent.DesiredHosts {
			if err := c.clearDownscaleIntent(ctx, machineSet, raw); err != nil {
				return result, err
			}
			if err := c.restoreOwnedNode(ctx, node); err != nil {
				return result, err
			}
			c.resetDownscale()
			result.Action = "abort-prepared-exact-scale-down"
			return result, nil
		}
		if desiredHosts < intent.DesiredHosts {
			intent.DesiredHosts = desiredHosts
			if err := c.persistDownscaleIntent(ctx, machineSet, raw, intent); err != nil {
				return result, err
			}
			result.Action = "refresh-prepared-exact-scale-down"
			return result, nil
		}
		intent.Phase = downscalePhaseIssued
		intent.AttemptAt = c.now()
		intent.Attempts = 0
		if err := c.persistDownscaleIntent(ctx, machineSet, raw, intent); err != nil {
			return result, err
		}
		result.Action = "arm-exact-scale-down"
		return result, nil
	case downscalePhaseIssued:
		if desiredNodes != intent.FromReplicas {
			result.Action = "await-exact-scale-down-capacity-convergence"
			return result, nil
		}
		// Issued means the next reconcile may contact the provider, not that it
		// already did. Demand growth while Attempts is still zero is unambiguous
		// and must win; monotonic Host contraction safely refreshes the same
		// durable intent before any provider side effect.
		if intent.Attempts == 0 && intent.RequestID == "" {
			if desiredHosts > intent.DesiredHosts {
				if err := c.clearDownscaleIntent(ctx, machineSet, raw); err != nil {
					return result, err
				}
				if err := c.restoreOwnedNode(ctx, node); err != nil {
					return result, err
				}
				c.resetDownscale()
				result.Action = "abort-armed-exact-scale-down"
				return result, nil
			}
			if desiredHosts < intent.DesiredHosts {
				intent.DesiredHosts = desiredHosts
				if err := c.persistDownscaleIntent(ctx, machineSet, raw, intent); err != nil {
					return result, err
				}
				result.Action = "refresh-armed-exact-scale-down"
				return result, nil
			}
		}
		if c.ExactScaleDown == nil {
			return result, fmt.Errorf("exact provider scale-down is unavailable with an issued intent")
		}
		// A non-empty RequestID proves the provider accepted this exact operation.
		// Never submit it twice merely because asynchronous Machine deletion is
		// slow; an operator can diagnose the immutable provider receipt instead.
		if intent.RequestID != "" {
			result.Action = "await-accepted-exact-scale-down"
			return result, nil
		}
		// Attempts is persisted before the HTTP call. A transport failure cannot
		// prove that the provider did not receive the destructive request, and
		// this API has no caller-supplied idempotency token. Observe exact state
		// forever rather than risk decrementing the pool twice.
		if intent.Attempts > 0 {
			result.Action = "await-ambiguous-exact-scale-down"
			return result, nil
		}
		intent.AttemptAt = c.now()
		intent.Attempts++
		if err := c.persistDownscaleIntent(ctx, machineSet, raw, intent); err != nil {
			return result, err
		}
		response, err := c.ExactScaleDown.DeleteMachineAndScaleDown(ctx, ExactScaleDownRequest{
			ClusterID: intent.ClusterID, MachineName: intent.MachineName, MachineUID: intent.MachineUID,
			NodeName: intent.NodeName, NodeUID: intent.NodeUID,
			MachineSetName: intent.MachineSetName, MachineSetUID: intent.MachineSetUID,
			FromReplicas: intent.FromReplicas, ToReplicas: intent.ToReplicas,
		})
		if err != nil {
			return result, fmt.Errorf("request exact provider scale-down: %w", err)
		}
		if response.RequestID == "" {
			return result, fmt.Errorf("exact provider scale-down returned an empty request ID")
		}
		latestMachineSet, getErr := c.Dynamic.Resource(machineSetResource).Get(
			ctx, intent.MachineSetName, metav1.GetOptions{},
		)
		if getErr != nil {
			return result, fmt.Errorf("provider accepted exact scale-down but its receipt could not be persisted: %w", getErr)
		}
		latestRaw := latestMachineSet.GetAnnotations()[DownscaleIntentAnnotation]
		var latestIntent downscaleIntent
		if latestRaw == "" || json.Unmarshal([]byte(latestRaw), &latestIntent) != nil ||
			latestIntent.MachineUID != intent.MachineUID || latestIntent.Attempts != intent.Attempts {
			return result, fmt.Errorf("provider accepted exact scale-down but durable intent changed")
		}
		latestIntent.RequestID = response.RequestID
		if err := c.persistAcceptedDownscaleRequestID(
			ctx, latestMachineSet.GetName(), string(latestMachineSet.GetUID()), latestRaw, latestIntent,
		); err != nil {
			return result, fmt.Errorf("provider accepted exact scale-down but persist request ID: %w", err)
		}
		result.Action = "request-exact-scale-down"
		return result, nil
	default:
		return result, fmt.Errorf("exact scale-down intent has unknown phase %q", intent.Phase)
	}
}

func (c *Controller) validateDownscaleIntent(intent downscaleIntent, machineSet *unstructured.Unstructured) error {
	if intent.Version != downscaleIntentVersion ||
		(intent.Phase != downscalePhasePrepared && intent.Phase != downscalePhaseIssued) ||
		intent.ClusterID == "" || intent.ClusterID != c.Config.ProviderClusterID ||
		intent.MachineName == "" || intent.MachineUID == "" || intent.NodeName == "" || intent.NodeUID == "" ||
		intent.MachineSetName != c.Config.MachineSetName || intent.MachineSetName != machineSet.GetName() ||
		intent.MachineSetUID == "" || intent.MachineSetUID != string(machineSet.GetUID()) ||
		intent.DesiredHosts < c.Config.MinReplicas || intent.DesiredHosts > intent.ToReplicas ||
		intent.FromReplicas <= c.Config.MinReplicas || intent.ToReplicas != intent.FromReplicas-1 ||
		intent.CreatedAt.IsZero() {
		return fmt.Errorf("exact scale-down intent identity or bounds mismatch")
	}
	return nil
}

func (c *Controller) persistDownscaleIntent(
	ctx context.Context, machineSet *unstructured.Unstructured, expected string, intent downscaleIntent,
) error {
	raw, err := json.Marshal(intent)
	if err != nil {
		return fmt.Errorf("encode exact scale-down intent: %w", err)
	}
	operations := []map[string]any{
		{"op": "test", "path": "/metadata/uid", "value": string(machineSet.GetUID())},
		{"op": "test", "path": "/metadata/resourceVersion", "value": machineSet.GetResourceVersion()},
	}
	if expected != "" {
		operations = append(operations,
			map[string]any{"op": "test", "path": "/metadata/annotations/" + escapeJSONPointer(DownscaleIntentAnnotation), "value": expected},
			map[string]any{"op": "replace", "path": "/metadata/annotations/" + escapeJSONPointer(DownscaleIntentAnnotation), "value": string(raw)},
		)
	} else if len(machineSet.GetAnnotations()) == 0 {
		operations = append(operations, map[string]any{
			"op": "add", "path": "/metadata/annotations", "value": map[string]string{DownscaleIntentAnnotation: string(raw)},
		})
	} else {
		operations = append(operations, map[string]any{
			"op": "add", "path": "/metadata/annotations/" + escapeJSONPointer(DownscaleIntentAnnotation), "value": string(raw),
		})
	}
	payload, _ := json.Marshal(operations)
	if _, err := c.Dynamic.Resource(machineSetResource).Patch(ctx, machineSet.GetName(), types.JSONPatchType, payload, metav1.PatchOptions{}); err != nil {
		return fmt.Errorf("persist exact scale-down intent: %w", err)
	}
	return nil
}

// persistAcceptedDownscaleRequestID runs after the provider has already
// accepted an irreversible exact deletion. Provider-side MachineSet status and
// replica updates legitimately churn resourceVersion at this point. UID plus
// an exact full-value annotation test still gives an atomic ownership/CAS
// fence without letting unrelated provider status updates turn an acknowledged
// request into ambiguous evidence.
func (c *Controller) persistAcceptedDownscaleRequestID(
	ctx context.Context, machineSetName, machineSetUID, expected string, intent downscaleIntent,
) error {
	raw, err := json.Marshal(intent)
	if err != nil {
		return fmt.Errorf("encode accepted exact scale-down intent: %w", err)
	}
	payload, _ := json.Marshal([]map[string]any{
		{"op": "test", "path": "/metadata/uid", "value": machineSetUID},
		{"op": "test", "path": "/metadata/annotations/" + escapeJSONPointer(DownscaleIntentAnnotation), "value": expected},
		{"op": "replace", "path": "/metadata/annotations/" + escapeJSONPointer(DownscaleIntentAnnotation), "value": string(raw)},
	})
	if _, err := c.Dynamic.Resource(machineSetResource).Patch(
		ctx, machineSetName, types.JSONPatchType, payload, metav1.PatchOptions{},
	); err != nil {
		return fmt.Errorf("persist accepted exact scale-down request ID: %w", err)
	}
	return nil
}

func (c *Controller) clearDownscaleIntent(ctx context.Context, machineSet *unstructured.Unstructured, expected string) error {
	payload, _ := json.Marshal([]map[string]any{
		{"op": "test", "path": "/metadata/uid", "value": string(machineSet.GetUID())},
		{"op": "test", "path": "/metadata/resourceVersion", "value": machineSet.GetResourceVersion()},
		{"op": "test", "path": "/metadata/annotations/" + escapeJSONPointer(DownscaleIntentAnnotation), "value": expected},
		{"op": "remove", "path": "/metadata/annotations/" + escapeJSONPointer(DownscaleIntentAnnotation)},
	})
	if _, err := c.Dynamic.Resource(machineSetResource).Patch(ctx, machineSet.GetName(), types.JSONPatchType, payload, metav1.PatchOptions{}); err != nil {
		return fmt.Errorf("clear exact scale-down intent: %w", err)
	}
	return nil
}

func (c *Controller) completeDownscaleIntent(
	ctx context.Context, machineSet *unstructured.Unstructured, expected string, intent downscaleIntent,
) error {
	if intent.Phase != downscalePhaseIssued || intent.Attempts != 1 {
		return fmt.Errorf("complete exact scale-down without one issued provider attempt")
	}
	outcome := downscaleOutcomeAcknowledged
	if intent.RequestID == "" {
		// The provider API has no caller-supplied idempotency key. If its response
		// is lost after it commits, the exact Machine and Node disappearance plus
		// target replica convergence (proved by the caller) are the only safe
		// completion evidence. Make that ambiguity explicit in the durable receipt.
		outcome = downscaleOutcomeAmbiguousExactConvergence
	}
	receipt, err := json.Marshal(downscaleReceipt{
		Version: downscaleReceiptVersion, CompletedAt: c.now(), Outcome: outcome, Intent: intent,
	})
	if err != nil {
		return fmt.Errorf("encode exact scale-down receipt: %w", err)
	}
	payload, _ := json.Marshal([]map[string]any{
		{"op": "test", "path": "/metadata/uid", "value": string(machineSet.GetUID())},
		{"op": "test", "path": "/metadata/resourceVersion", "value": machineSet.GetResourceVersion()},
		{"op": "test", "path": "/metadata/annotations/" + escapeJSONPointer(DownscaleIntentAnnotation), "value": expected},
		{"op": "remove", "path": "/metadata/annotations/" + escapeJSONPointer(DownscaleIntentAnnotation)},
		{"op": "add", "path": "/metadata/annotations/" + escapeJSONPointer(DownscaleReceiptAnnotation), "value": string(receipt)},
	})
	if _, err := c.Dynamic.Resource(machineSetResource).Patch(
		ctx, machineSet.GetName(), types.JSONPatchType, payload, metav1.PatchOptions{},
	); err != nil {
		return fmt.Errorf("complete exact scale-down intent: %w", err)
	}
	return nil
}

func (c *Controller) capacityInventory(ctx context.Context, machineSetUID string) (nodeCapacityInventory, error) {
	machines, err := c.listMachines(ctx)
	if err != nil {
		return nodeCapacityInventory{}, fmt.Errorf("list runtime Machines for capacity evidence: %w", err)
	}
	machineByNode := make(map[string]*unstructured.Unstructured, len(machines.Items))
	for index := range machines.Items {
		nodeName, found, nestedErr := unstructured.NestedString(machines.Items[index].Object, "status", "nodeRef", "name")
		if nestedErr != nil || !found || nodeName == "" || machines.Items[index].GetUID() == "" {
			continue
		}
		if machineByNode[nodeName] != nil {
			return nodeCapacityInventory{}, fmt.Errorf("multiple runtime Machines claim Node %s", nodeName)
		}
		machineByNode[nodeName] = &machines.Items[index]
	}
	nodes, err := c.Kubernetes.CoreV1().Nodes().List(ctx, metav1.ListOptions{
		LabelSelector: "node.tke.cloud.tencent.com/machineset=" + c.Config.MachineSetName,
	})
	if err != nil {
		return nodeCapacityInventory{}, fmt.Errorf("list runtime Nodes for capacity evidence: %w", err)
	}
	result := nodeCapacityInventory{
		usableNodeUIDs:  make(map[string]string),
		usableTargets:   make([]quarantinedTarget, 0),
		preparedTargets: make([]quarantinedTarget, 0),
		quarantined:     make([]quarantinedTarget, 0),
	}
	for index := range nodes.Items {
		node := &nodes.Items[index]
		if node.Labels["fleet.actor.dev/cell-name"] != c.Config.CellName {
			return nodeCapacityInventory{}, fmt.Errorf("runtime Node %s Cell identity mismatch", node.Name)
		}
		raw := node.Annotations[admission.StateAnnotation]
		if raw == "" {
			result.unsettledNodes++
			result.admissionInFlightNodes++
			continue
		}
		state, err := admission.DecodeState(raw)
		if err != nil {
			return nodeCapacityInventory{}, fmt.Errorf("runtime Node %s has invalid admission evidence: %w", node.Name, err)
		}
		machine := machineByNode[node.Name]
		if machine == nil {
			result.unsettledNodes++
			result.admissionInFlightNodes++
			continue
		}
		if state.Identity.NodeUID != string(node.UID) || state.Identity.ProviderID != node.Spec.ProviderID ||
			state.Identity.MachineUID != string(machine.GetUID()) || state.Identity.MachineSetUID != machineSetUID ||
			state.Identity.ProfileDigest != admission.ProfileDigest() {
			return nodeCapacityInventory{}, fmt.Errorf("runtime Node %s admission identity mismatch", node.Name)
		}
		if state.Phase == admission.PhaseQuarantined {
			result.quarantined = append(result.quarantined, quarantinedTarget{node: node.DeepCopy(), machine: machine.DeepCopy(), state: state})
			continue
		}
		if state.Phase == admission.PhaseSuspect {
			result.suspectNodes++
			continue
		}
		if state.Phase == admission.PhaseAdmitted && nodeIsUsable(node) {
			result.usableNodes++
			result.usableNodeUIDs[node.Name] = string(node.UID)
			result.usableTargets = append(result.usableTargets, quarantinedTarget{
				node: node.DeepCopy(), machine: machine.DeepCopy(), state: state,
			})
			continue
		}
		preparedForFrontier := state.Phase == admission.PhasePrepared && nodeIsPreparedForFrontier(node)
		if preparedForFrontier {
			result.preparedTargets = append(result.preparedTargets, quarantinedTarget{
				node: node.DeepCopy(), machine: machine.DeepCopy(), state: state,
			})
		}
		admittedRoundComplete := state.Phase == admission.PhaseAdmitted &&
			node.Labels[admission.AdmittedLabel] == "true" &&
			!hasTaintKey(node.Spec.Taints, admission.PendingTaintKey)
		preparedRoundComplete := state.Phase == admission.PhasePrepared &&
			node.Labels[admission.AdmittedLabel] == "" &&
			hasExactTaint(node.Spec.Taints, admission.PendingTaintKey, "pending", corev1.TaintEffectNoSchedule)
		if !admittedRoundComplete && !preparedRoundComplete {
			result.admissionInFlightNodes++
		}
		result.unsettledNodes++
	}
	sort.Slice(result.quarantined, func(i, j int) bool {
		return result.quarantined[i].machine.GetName() < result.quarantined[j].machine.GetName()
	})
	return result, nil
}

func (c *Controller) topologyRepairCandidate(inventory nodeCapacityInventory) (*quarantinedTarget, error) {
	counts := make(map[string]int)
	for _, target := range inventory.usableTargets {
		zone := target.node.Labels[corev1.LabelTopologyZone]
		if zone == "" {
			return nil, fmt.Errorf("runtime Node %s has no topology zone", target.node.Name)
		}
		counts[zone]++
	}
	if len(counts) > c.Config.RequiredZones {
		return nil, fmt.Errorf("runtime capacity spans %d zones, more than configured %d", len(counts), c.Config.RequiredZones)
	}
	if len(counts) == c.Config.RequiredZones {
		minimum, maximum := len(inventory.usableTargets), 0
		for _, count := range counts {
			if count < minimum {
				minimum = count
			}
			if count > maximum {
				maximum = count
			}
		}
		if maximum-minimum <= 1 {
			return nil, nil
		}
	}
	maximum := 0
	for _, count := range counts {
		if count > maximum {
			maximum = count
		}
	}
	candidates := make([]quarantinedTarget, 0)
	for _, target := range inventory.usableTargets {
		if counts[target.node.Labels[corev1.LabelTopologyZone]] == maximum {
			candidates = append(candidates, target)
		}
	}
	if len(candidates) == 0 || maximum <= 1 {
		return nil, fmt.Errorf("runtime topology cannot select an overrepresented zone for repair: %v", counts)
	}
	sort.Slice(candidates, func(i, j int) bool {
		left, right := candidates[i].machine.GetCreationTimestamp().Time, candidates[j].machine.GetCreationTimestamp().Time
		if left.Equal(right) {
			return candidates[i].machine.GetName() > candidates[j].machine.GetName()
		}
		return left.After(right)
	})
	return &candidates[0], nil
}

// topologyCapacityTarget returns the minimum Machine target that can host the
// requested replicas with one Host per Node and maxSkew=1 across requiredZones.
// Missing zones are represented as zeroes. New Machines are modelled in the
// least-populated zone, matching the MachineSet ZoneEquality contract; the
// caller always re-observes real placement before requesting any further step.
func topologyCapacityTarget(targets []quarantinedTarget, desiredHosts int64, requiredZones int) (int64, error) {
	if requiredZones <= 1 || desiredHosts <= 0 {
		return int64(len(targets)), nil
	}
	countsByZone := make(map[string]int64, requiredZones)
	for _, target := range targets {
		zone := target.node.Labels[corev1.LabelTopologyZone]
		if zone == "" {
			return 0, fmt.Errorf("runtime Node %s has no topology zone", target.node.Name)
		}
		countsByZone[zone]++
	}
	if len(countsByZone) > requiredZones {
		return 0, fmt.Errorf("runtime capacity spans %d zones, more than configured %d", len(countsByZone), requiredZones)
	}
	counts := make([]int64, 0, requiredZones)
	for _, count := range countsByZone {
		counts = append(counts, count)
	}
	for len(counts) < requiredZones {
		counts = append(counts, 0)
	}
	target := int64(len(targets))
	for balancedHostCapacity(counts) < desiredHosts {
		sort.Slice(counts, func(i, j int) bool { return counts[i] < counts[j] })
		counts[0]++
		target++
	}
	return target, nil
}

func balancedHostCapacity(counts []int64) int64 {
	if len(counts) == 0 {
		return 0
	}
	minimum := counts[0]
	for _, count := range counts[1:] {
		if count < minimum {
			minimum = count
		}
	}
	capacity := int64(0)
	for _, count := range counts {
		if count > minimum+1 {
			capacity += minimum + 1
		} else {
			capacity += count
		}
	}
	return capacity
}

func balancedRuntimeCapacity(targets []quarantinedTarget, requiredZones int) (int64, error) {
	if requiredZones <= 0 {
		return int64(len(targets)), nil
	}
	countsByZone := make(map[string]int64, requiredZones)
	for _, target := range targets {
		zone := target.node.Labels[corev1.LabelTopologyZone]
		if zone == "" {
			return 0, fmt.Errorf("runtime Node %s has no topology zone", target.node.Name)
		}
		countsByZone[zone]++
	}
	if len(countsByZone) > requiredZones {
		return 0, fmt.Errorf("runtime capacity spans %d zones, more than configured %d", len(countsByZone), requiredZones)
	}
	counts := make([]int64, 0, requiredZones)
	for _, count := range countsByZone {
		counts = append(counts, count)
	}
	for len(counts) < requiredZones {
		counts = append(counts, 0)
	}
	return balancedHostCapacity(counts), nil
}

// preparedAdmissionFrontierCapacity mirrors admission.balancedAdmissionPlan:
// Prepared Nodes become usable only up to the common per-zone frontier.  It
// returns the capacity that the already-probed set can open without another
// Machine, preventing both a partial-zone deadlock and an unnecessary surge.
func preparedAdmissionFrontierCapacity(
	admitted, prepared []quarantinedTarget, requiredZones int,
) (int64, error) {
	if requiredZones <= 0 || len(prepared) == 0 {
		return int64(len(admitted)), nil
	}
	admittedByZone := make(map[string]int64, requiredZones)
	totalByZone := make(map[string]int64, requiredZones)
	for _, group := range [][]quarantinedTarget{admitted, prepared} {
		for _, target := range group {
			zone := target.node.Labels[corev1.LabelTopologyZone]
			if zone == "" {
				return 0, fmt.Errorf("runtime Node %s has no topology zone", target.node.Name)
			}
			totalByZone[zone]++
		}
	}
	for _, target := range admitted {
		admittedByZone[target.node.Labels[corev1.LabelTopologyZone]]++
	}
	if len(totalByZone) > requiredZones {
		return 0, fmt.Errorf("runtime admission frontier spans %d zones, more than configured %d", len(totalByZone), requiredZones)
	}
	if len(totalByZone) < requiredZones {
		return int64(len(admitted)), nil
	}
	frontier := int64(-1)
	for _, total := range totalByZone {
		if frontier < 0 || total < frontier {
			frontier = total
		}
	}
	capacity := int64(0)
	for zone := range totalByZone {
		count := admittedByZone[zone]
		if count < frontier {
			count = frontier
		}
		capacity += count
	}
	return capacity, nil
}

// topologyContractionCandidates returns admitted Machines whose removal still
// leaves enough maxSkew=1 capacity for every desired Host. Newest candidates
// win so the provider and controller retain one deterministic deletion order.
// A caller must revalidate after fencing because admission or HPA state can
// change between observation and action.
func topologyContractionCandidates(
	targets []quarantinedTarget, desiredHosts int64, requiredZones int,
) ([]quarantinedTarget, error) {
	candidates := make([]quarantinedTarget, 0, len(targets))
	for index := range targets {
		remaining := make([]quarantinedTarget, 0, len(targets)-1)
		remaining = append(remaining, targets[:index]...)
		remaining = append(remaining, targets[index+1:]...)
		capacity, err := balancedRuntimeCapacity(remaining, requiredZones)
		if err != nil {
			return nil, err
		}
		if capacity >= desiredHosts {
			candidates = append(candidates, targets[index])
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		left, right := candidates[i].machine.GetCreationTimestamp().Time, candidates[j].machine.GetCreationTimestamp().Time
		if left.Equal(right) {
			return candidates[i].machine.GetName() > candidates[j].machine.GetName()
		}
		return left.After(right)
	})
	return candidates, nil
}

func (c *Controller) quarantineTopologyTarget(
	ctx context.Context, target quarantinedTarget, attemptPrefix string,
) error {
	if target.state.Phase != admission.PhaseAdmitted || target.node.Labels[admission.AdmittedLabel] != "true" ||
		hasTaintKey(target.node.Spec.Taints, admission.PendingTaintKey) {
		return fmt.Errorf("runtime topology repair target %s is not exactly admitted", target.node.Name)
	}
	if attemptPrefix != "topology" && attemptPrefix != "topology-contraction" {
		return fmt.Errorf("runtime topology repair attempt prefix is invalid")
	}
	state := target.state
	state.Phase = admission.PhaseQuarantined
	now := c.now()
	state.AttemptUID = fmt.Sprintf("%s-%s-%d", attemptPrefix, target.machine.GetUID(), now.UnixNano())
	state.Attempt++
	if state.Attempt < 1 {
		state.Attempt = 1
	}
	state.StartedAt = now
	state.TransitionAt = now
	state.ProbePodName = ""
	state.ProbePodUID = ""
	state.RetryAt = time.Time{}
	state.Reason = "runtime topology zone rebalance"
	state.Fault = ""
	state.FaultSince = time.Time{}
	encoded, err := admission.EncodeState(state)
	if err != nil {
		return fmt.Errorf("encode runtime topology repair state: %w", err)
	}
	raw := target.node.Annotations[admission.StateAnnotation]
	operations := []map[string]any{
		{"op": "test", "path": "/metadata/uid", "value": string(target.node.UID)},
		{"op": "test", "path": "/metadata/resourceVersion", "value": target.node.ResourceVersion},
		{"op": "test", "path": "/metadata/annotations/" + escapeJSONPointer(admission.StateAnnotation), "value": raw},
		{"op": "test", "path": "/metadata/labels/" + escapeJSONPointer(admission.AdmittedLabel), "value": "true"},
		{"op": "add", "path": "/metadata/annotations/" + escapeJSONPointer(admission.StateAnnotation), "value": encoded},
		{"op": "add", "path": "/metadata/labels/" + escapeJSONPointer(admission.PhaseLabel), "value": "quarantined"},
		{"op": "remove", "path": "/metadata/labels/" + escapeJSONPointer(admission.AdmittedLabel)},
	}
	taint := corev1.Taint{Key: admission.PendingTaintKey, Value: "pending", Effect: corev1.TaintEffectNoSchedule}
	if target.node.Spec.Taints == nil {
		operations = append(operations, map[string]any{"op": "add", "path": "/spec/taints", "value": []corev1.Taint{taint}})
	} else {
		operations = append(operations, map[string]any{"op": "add", "path": "/spec/taints/-", "value": taint})
	}
	payload, err := json.Marshal(operations)
	if err != nil {
		return err
	}
	if _, err := c.Kubernetes.CoreV1().Nodes().Patch(ctx, target.node.Name, types.JSONPatchType, payload, metav1.PatchOptions{}); err != nil {
		return fmt.Errorf("quarantine runtime topology repair target %s: %w", target.node.Name, err)
	}
	return nil
}

func nodeIsUsable(node *corev1.Node) bool {
	if node.DeletionTimestamp != nil || node.Spec.Unschedulable || node.Annotations[DrainAnnotation] != "" ||
		node.Labels[admission.AdmittedLabel] != "true" || hasTaintKey(node.Spec.Taints, admission.PendingTaintKey) ||
		hasTaintKey(node.Spec.Taints, DrainTaintKey) {
		return false
	}
	conditions := make(map[corev1.NodeConditionType]corev1.ConditionStatus, len(node.Status.Conditions))
	for _, condition := range node.Status.Conditions {
		conditions[condition.Type] = condition.Status
	}
	if conditions[corev1.NodeReady] != corev1.ConditionTrue {
		return false
	}
	for _, condition := range []corev1.NodeConditionType{
		corev1.NodeDiskPressure, corev1.NodeMemoryPressure, corev1.NodePIDPressure, corev1.NodeNetworkUnavailable,
	} {
		if conditions[condition] == corev1.ConditionTrue {
			return false
		}
	}
	return true
}

func nodeIsPreparedForFrontier(node *corev1.Node) bool {
	if node.DeletionTimestamp != nil || node.Spec.Unschedulable || node.Annotations[DrainAnnotation] != "" ||
		node.Labels[admission.AdmittedLabel] != "" ||
		!hasExactTaint(node.Spec.Taints, admission.PendingTaintKey, "pending", corev1.TaintEffectNoSchedule) ||
		hasTaintKey(node.Spec.Taints, DrainTaintKey) {
		return false
	}
	conditions := make(map[corev1.NodeConditionType]corev1.ConditionStatus, len(node.Status.Conditions))
	for _, condition := range node.Status.Conditions {
		conditions[condition.Type] = condition.Status
	}
	if conditions[corev1.NodeReady] != corev1.ConditionTrue {
		return false
	}
	for _, condition := range []corev1.NodeConditionType{
		corev1.NodeDiskPressure, corev1.NodeMemoryPressure, corev1.NodePIDPressure, corev1.NodeNetworkUnavailable,
	} {
		if conditions[condition] == corev1.ConditionTrue {
			return false
		}
	}
	return true
}

func hasTaintKey(taints []corev1.Taint, key string) bool {
	for index := range taints {
		if taints[index].Key == key {
			return true
		}
	}
	return false
}

func (c *Controller) deleteExactQuarantinedMachine(ctx context.Context, target quarantinedTarget) error {
	node, err := c.Kubernetes.CoreV1().Nodes().Get(ctx, target.node.Name, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("re-read quarantined runtime Node: %w", err)
	}
	if node.UID != target.node.UID ||
		node.Annotations[admission.StateAnnotation] != target.node.Annotations[admission.StateAnnotation] {
		return fmt.Errorf("quarantined runtime Node changed before targeted repair")
	}
	machine, err := c.Dynamic.Resource(machineResource).Get(ctx, target.machine.GetName(), metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("re-read quarantined runtime Machine: %w", err)
	}
	if machine.GetUID() != target.machine.GetUID() {
		return fmt.Errorf("quarantined runtime Machine changed before targeted repair")
	}
	target.node = node
	target.machine = machine
	if target.node.DeletionTimestamp != nil || target.machine.GetDeletionTimestamp() != nil {
		return fmt.Errorf("quarantined runtime Machine is already deleting")
	}
	if target.node.Labels[admission.AdmittedLabel] != "" || !hasExactTaint(
		target.node.Spec.Taints, admission.PendingTaintKey, "pending", corev1.TaintEffectNoSchedule,
	) {
		return fmt.Errorf("quarantined runtime Node has no exact scheduling fence")
	}
	if target.node.Annotations[admission.StateAnnotation] == "" || target.state.Phase != admission.PhaseQuarantined {
		return fmt.Errorf("quarantined runtime Node lost durable evidence")
	}
	if err := c.requireNodeEmpty(ctx, target.node.Name); err != nil {
		return err
	}
	uid := target.machine.GetUID()
	policy := metav1.DeletePropagationForeground
	if err := c.Dynamic.Resource(machineResource).Delete(ctx, target.machine.GetName(), metav1.DeleteOptions{
		Preconditions: &metav1.Preconditions{UID: &uid}, PropagationPolicy: &policy,
	}); err != nil {
		return fmt.Errorf("delete exact quarantined runtime Machine %s: %w", target.machine.GetName(), err)
	}
	return nil
}

func hasExactTaint(taints []corev1.Taint, key, value string, effect corev1.TaintEffect) bool {
	for index := range taints {
		if taints[index].Key == key && taints[index].Value == value && taints[index].Effect == effect {
			return true
		}
	}
	return false
}

func (c *Controller) observe(ctx context.Context) (*appsv1.StatefulSet, *unstructured.Unstructured, int64, int64, int64, error) {
	statefulSet, err := c.Kubernetes.AppsV1().StatefulSets(c.Config.Namespace).Get(
		ctx, c.Config.StatefulSetName, metav1.GetOptions{},
	)
	if err != nil {
		return nil, nil, 0, 0, 0, fmt.Errorf("get runtime StatefulSet: %w", err)
	}
	if !admission.StatefulSetMatchesCell(statefulSet, c.Config.CellName) {
		return nil, nil, 0, 0, 0, fmt.Errorf("runtime StatefulSet Cell identity mismatch")
	}
	desiredHosts := int64(1)
	if statefulSet.Spec.Replicas != nil {
		desiredHosts = int64(*statefulSet.Spec.Replicas)
	}
	machineSet, err := c.Dynamic.Resource(machineSetResource).Get(ctx, c.Config.MachineSetName, metav1.GetOptions{})
	if err != nil {
		return nil, nil, 0, 0, 0, fmt.Errorf("get runtime MachineSet: %w", err)
	}
	cell, _, _ := unstructured.NestedString(machineSet.Object, "spec", "template", "spec", "metadata", "labels", "fleet.actor.dev/cell-name")
	runtimePool, _, _ := unstructured.NestedString(machineSet.Object, "spec", "template", "spec", "metadata", "labels", "fleet.actor.dev/runtime-pool")
	deletePolicy, _, _ := unstructured.NestedString(machineSet.Object, "spec", "deletePolicy")
	minimum, foundMinimum, _ := unstructured.NestedInt64(machineSet.Object, "spec", "scaling", "minReplicas")
	maximum, foundMaximum, _ := unstructured.NestedInt64(machineSet.Object, "spec", "scaling", "maxReplicas")
	desiredNodes, foundDesired, _ := unstructured.NestedInt64(machineSet.Object, "spec", "replicas")
	statusNodes, foundStatus, _ := unstructured.NestedInt64(machineSet.Object, "status", "replicas")
	if cell != c.Config.CellName || runtimePool != "true" ||
		(c.Config.TargetedRepairEnabled && deletePolicy != "Newest") || !foundMinimum || !foundMaximum || !foundDesired ||
		minimum != c.Config.MinReplicas || maximum != c.Config.MaxReplicas {
		return nil, nil, 0, 0, 0, fmt.Errorf("runtime MachineSet identity or capacity bounds mismatch")
	}
	if !foundStatus {
		statusNodes = desiredNodes
	}
	return statefulSet, machineSet, desiredHosts, desiredNodes, statusNodes, nil
}

func (c *Controller) safeEmptyMachine(
	ctx context.Context, expected int64, eligibleMachines map[string]struct{},
) (*unstructured.Unstructured, *corev1.Node, error) {
	machines, err := c.listMachines(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("list runtime Machines: %w", err)
	}
	if int64(len(machines.Items)) <= c.Config.MinReplicas {
		return nil, nil, fmt.Errorf("refuse to select a Machine at the capacity floor")
	}
	if int64(len(machines.Items)) != expected {
		return nil, nil, fmt.Errorf("runtime Machine inventory %d does not match desired capacity %d", len(machines.Items), expected)
	}
	sort.Slice(machines.Items, func(i, j int) bool {
		left, right := machines.Items[i].GetCreationTimestamp().Time, machines.Items[j].GetCreationTimestamp().Time
		if left.Equal(right) {
			return machines.Items[i].GetName() < machines.Items[j].GetName()
		}
		return left.Before(right)
	})
	// StatefulSet ordinals are not bound to Machine creation order. After the
	// Host drain controller removes the highest ordinal, the now-empty Machine
	// may therefore be older than a still-busy Machine. Inspect the complete,
	// bounded Machine inventory and choose the newest *empty* Machine. Identity
	// or API ambiguity remains fail closed; only an observed workload makes a
	// Machine ineligible while allowing another proven-empty Machine to win.
	for index := len(machines.Items) - 1; index >= 0; index-- {
		candidate := &machines.Items[index]
		if _, eligible := eligibleMachines[string(candidate.GetUID())]; !eligible {
			continue
		}
		nodeName, found, err := unstructured.NestedString(candidate.Object, "status", "nodeRef", "name")
		if err != nil || !found || nodeName == "" {
			return nil, nil, fmt.Errorf("runtime Machine %s has no Node identity", candidate.GetName())
		}
		node, err := c.Kubernetes.CoreV1().Nodes().Get(ctx, nodeName, metav1.GetOptions{})
		if err != nil {
			return nil, nil, fmt.Errorf("get runtime Node %s for Machine %s: %w", nodeName, candidate.GetName(), err)
		}
		if node.Labels["node.tke.cloud.tencent.com/machineset"] != c.Config.MachineSetName ||
			node.Labels["fleet.actor.dev/cell-name"] != c.Config.CellName {
			return nil, nil, fmt.Errorf("runtime Node %s identity mismatch", node.Name)
		}
		empty, err := c.nodeIsEmpty(ctx, node.Name)
		if err != nil {
			return nil, nil, err
		}
		if empty {
			return candidate, node, nil
		}
	}
	return nil, nil, nil
}

func (c *Controller) listMachines(ctx context.Context) (*unstructured.UnstructuredList, error) {
	// TKE's aggregated Native-node API has a distinct bounded-list path. An
	// unbounded LIST can return a provider-side 500 after a Machine deletion,
	// while the same label-scoped request with Kubernetes' standard 500-item
	// page is valid. q01 has a hard 31-Machine ceiling, so a continuation token
	// indicates that the selector or provider contract changed; never operate
	// on a partial inventory.
	machines, err := c.Dynamic.Resource(machineResource).List(ctx, metav1.ListOptions{
		LabelSelector: "node.tke.cloud.tencent.com/machineset=" + c.Config.MachineSetName,
		Limit:         machineListLimit,
	})
	if err != nil {
		return nil, err
	}
	if machines.GetContinue() != "" {
		return nil, fmt.Errorf("runtime Machine inventory exceeds bounded list of %d", machineListLimit)
	}
	return machines, nil
}

func (c *Controller) requireNodeEmpty(ctx context.Context, nodeName string) error {
	empty, err := c.nodeIsEmpty(ctx, nodeName)
	if err != nil {
		return err
	}
	if !empty {
		return fmt.Errorf("runtime Node %s still owns a workload Pod", nodeName)
	}
	return nil
}

func (c *Controller) nodeIsEmpty(ctx context.Context, nodeName string) (bool, error) {
	pods, err := c.Kubernetes.CoreV1().Pods("").List(ctx, metav1.ListOptions{
		FieldSelector: fields.OneTermEqualSelector("spec.nodeName", nodeName).String(),
	})
	if err != nil {
		return false, fmt.Errorf("list Pods on runtime Node %s: %w", nodeName, err)
	}
	for i := range pods.Items {
		pod := &pods.Items[i]
		if pod.Spec.NodeName != nodeName {
			continue
		}
		if pod.Status.Phase == corev1.PodSucceeded || pod.Status.Phase == corev1.PodFailed {
			continue
		}
		if _, mirror := pod.Annotations[corev1.MirrorPodAnnotationKey]; mirror {
			continue
		}
		if ownedByDaemonSet(pod) {
			continue
		}
		return false, nil
	}
	return true, nil
}

func ownedByDaemonSet(pod *corev1.Pod) bool {
	for _, owner := range pod.OwnerReferences {
		if owner.Controller != nil && *owner.Controller && owner.Kind == "DaemonSet" {
			return true
		}
	}
	return false
}

func (c *Controller) cordonOwnedNode(ctx context.Context, node *corev1.Node, machineUID string) error {
	if owner := node.Annotations[DrainAnnotation]; owner != "" {
		if owner != machineUID || drainTaintIndex(node.Spec.Taints, machineUID) < 0 {
			return fmt.Errorf("runtime Node has an incompatible drain fence")
		}
		return nil
	}
	if node.Spec.Unschedulable {
		return fmt.Errorf("runtime Node is cordoned by another controller")
	}
	operations := []map[string]any{
		{"op": "test", "path": "/metadata/uid", "value": string(node.UID)},
		{"op": "test", "path": "/metadata/resourceVersion", "value": node.ResourceVersion},
	}
	if len(node.Annotations) == 0 {
		operations = append(operations, map[string]any{
			"op": "add", "path": "/metadata/annotations", "value": map[string]string{DrainAnnotation: machineUID},
		})
	} else {
		operations = append(operations, map[string]any{
			"op": "add", "path": "/metadata/annotations/" + escapeJSONPointer(DrainAnnotation), "value": machineUID,
		})
	}
	drainTaint := corev1.Taint{Key: DrainTaintKey, Value: machineUID, Effect: corev1.TaintEffectNoSchedule}
	if node.Spec.Taints == nil {
		operations = append(operations, map[string]any{"op": "add", "path": "/spec/taints", "value": []corev1.Taint{drainTaint}})
	} else {
		operations = append(operations, map[string]any{"op": "add", "path": "/spec/taints/-", "value": drainTaint})
	}
	patch, _ := json.Marshal(operations)
	if _, err := c.Kubernetes.CoreV1().Nodes().Patch(ctx, node.Name, types.JSONPatchType, patch, metav1.PatchOptions{}); err != nil {
		return fmt.Errorf("cordon runtime Node selected for exact scale-down: %w", err)
	}
	return nil
}

func (c *Controller) restoreOwnedNodes(ctx context.Context) error {
	nodes, err := c.Kubernetes.CoreV1().Nodes().List(ctx, metav1.ListOptions{
		LabelSelector: "node.tke.cloud.tencent.com/machineset=" + c.Config.MachineSetName,
	})
	if err != nil {
		return fmt.Errorf("list runtime Nodes for drain recovery: %w", err)
	}
	for i := range nodes.Items {
		if nodes.Items[i].Annotations[DrainAnnotation] != "" {
			if err := c.restoreOwnedNode(ctx, &nodes.Items[i]); err != nil {
				return err
			}
		}
	}
	return nil
}

func (c *Controller) restoreOrphanedScaleDownFences(ctx context.Context, machineSet *unstructured.Unstructured) ([]string, error) {
	nodes, err := c.Kubernetes.CoreV1().Nodes().List(ctx, metav1.ListOptions{
		LabelSelector: "node.tke.cloud.tencent.com/machineset=" + c.Config.MachineSetName,
	})
	if err != nil {
		return nil, fmt.Errorf("list runtime Nodes for orphaned scale-down recovery: %w", err)
	}
	restored := make([]string, 0)
	for i := range nodes.Items {
		node := &nodes.Items[i]
		if node.Annotations[DrainAnnotation] == "" {
			continue
		}
		// GET can observe an older no-intent snapshot than a just-completed
		// prepare. Confirm it at the server before treating a fence as orphaned.
		// This controller is the sole Recreate writer for the MachineSet; both
		// the prepare and this check use its resourceVersion as their CAS fence.
		if machineSet.GetAnnotations()[DownscaleIntentAnnotation] != "" {
			return restored, fmt.Errorf("refuse orphan recovery with an exact scale-down intent")
		}
		if machineSet.GetUID() == "" || machineSet.GetResourceVersion() == "" {
			return restored, fmt.Errorf("refuse orphan recovery without MachineSet UID and resourceVersion")
		}
		proof, _ := json.Marshal([]map[string]any{
			{"op": "test", "path": "/metadata/uid", "value": string(machineSet.GetUID())},
			{"op": "test", "path": "/metadata/resourceVersion", "value": machineSet.GetResourceVersion()},
		})
		confirmed, err := c.Dynamic.Resource(machineSetResource).Patch(ctx, machineSet.GetName(), types.JSONPatchType, proof, metav1.PatchOptions{})
		if err != nil {
			return restored, fmt.Errorf("confirm no exact scale-down intent before orphan recovery: %w", err)
		}
		if confirmed.GetUID() != machineSet.GetUID() || confirmed.GetAnnotations()[DownscaleIntentAnnotation] != "" {
			return restored, fmt.Errorf("MachineSet identity or exact scale-down intent changed before orphan recovery")
		}
		if err := c.restoreOwnedNode(ctx, node); err != nil {
			return restored, fmt.Errorf("restore orphaned scale-down fence on Node %s: %w", node.Name, err)
		}
		restored = append(restored, node.Name)
	}
	sort.Strings(restored)
	return restored, nil
}

func (c *Controller) restoreOwnedNode(ctx context.Context, node *corev1.Node) error {
	owner := node.Annotations[DrainAnnotation]
	if owner == "" {
		return nil
	}
	index := drainTaintIndex(node.Spec.Taints, owner)
	if index < 0 {
		return fmt.Errorf("runtime Node drain annotation has no exact owned taint")
	}
	path := fmt.Sprintf("/spec/taints/%d", index)
	patch, _ := json.Marshal([]map[string]any{
		{"op": "test", "path": "/metadata/uid", "value": string(node.UID)},
		{"op": "test", "path": "/metadata/resourceVersion", "value": node.ResourceVersion},
		{"op": "test", "path": "/metadata/annotations/" + escapeJSONPointer(DrainAnnotation), "value": owner},
		{"op": "test", "path": path, "value": node.Spec.Taints[index]},
		{"op": "remove", "path": "/metadata/annotations/" + escapeJSONPointer(DrainAnnotation)},
		{"op": "remove", "path": path},
	})
	if _, err := c.Kubernetes.CoreV1().Nodes().Patch(ctx, node.Name, types.JSONPatchType, patch, metav1.PatchOptions{}); err != nil {
		return fmt.Errorf("restore runtime Node after aborted drain: %w", err)
	}
	return nil
}

func drainTaintIndex(taints []corev1.Taint, owner string) int {
	for index := range taints {
		if taints[index].Key == DrainTaintKey && taints[index].Value == owner && taints[index].Effect == corev1.TaintEffectNoSchedule {
			return index
		}
	}
	return -1
}

func (c *Controller) patchMachineSetReplicas(ctx context.Context, machineSet *unstructured.Unstructured, current, target int64) error {
	patch, _ := json.Marshal([]map[string]any{
		{"op": "test", "path": "/metadata/uid", "value": string(machineSet.GetUID())},
		{"op": "test", "path": "/metadata/resourceVersion", "value": machineSet.GetResourceVersion()},
		{"op": "test", "path": "/spec/replicas", "value": current},
		{"op": "replace", "path": "/spec/replicas", "value": target},
	})
	if _, err := c.Dynamic.Resource(machineSetResource).Patch(ctx, c.Config.MachineSetName, types.JSONPatchType, patch, metav1.PatchOptions{}); err != nil {
		return fmt.Errorf("CAS patch runtime MachineSet replicas: %w", err)
	}
	return nil
}

func (c *Controller) resetDownscale() {
	c.downscaleDesired = 0
	c.downscaleCurrent = 0
	c.downscaleSince = time.Time{}
}

func (c *Controller) now() time.Time {
	if c.Now != nil {
		return c.Now().UTC()
	}
	return time.Now().UTC()
}

func (c *Controller) validate() error {
	if c.Kubernetes == nil || c.Dynamic == nil {
		return fmt.Errorf("Kubernetes and dynamic clients are required")
	}
	if c.Config.Namespace == "" || c.Config.CellName == "" || c.Config.StatefulSetName == "" || c.Config.MachineSetName == "" {
		return fmt.Errorf("runtime capacity identities are required")
	}
	if c.ExactScaleDown != nil && !strings.HasPrefix(c.Config.ProviderClusterID, "cls-") {
		return fmt.Errorf("exact provider scale-down requires a TKE cluster identity")
	}
	if c.Config.MinReplicas < 1 || c.Config.MaxReplicas < c.Config.MinReplicas {
		return fmt.Errorf("invalid runtime capacity bounds")
	}
	if c.Config.MaxRepairSurge < 0 || c.Config.MaxRepairSurge > 1 {
		return fmt.Errorf("runtime capacity repair surge must be zero or one")
	}
	if c.Config.RequiredZones < 0 || c.Config.RequiredZones == 1 {
		return fmt.Errorf("runtime capacity required zones must be zero or at least two")
	}
	if c.Config.TargetedRepairEnabled && (c.Config.RuntimeAuthToken == "" || c.Config.ManagementPort < 1 ||
		c.Config.ManagementPort > 65535 || c.Config.RepairDrainTimeout <= 0) {
		return fmt.Errorf("targeted runtime repair requires Host authentication, management port, and drain timeout")
	}
	if c.Config.ScaleDownStabilization <= 0 {
		return fmt.Errorf("positive scale-down stabilization is required")
	}
	return nil
}

func escapeJSONPointer(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "~", "~0"), "/", "~1")
}

func (c *Controller) logf(format string, arguments ...any) {
	if c.Logf != nil {
		c.Logf(format, arguments...)
	}
}
