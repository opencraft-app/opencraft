package cellreporter

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
)

var (
	cellGVR    = schema.GroupVersionResource{Group: "fleet.actor.dev", Version: "v1alpha1", Resource: "rivetcells"}
	reportGVR  = schema.GroupVersionResource{Group: "fleet.actor.dev", Version: "v1alpha1", Resource: "rivetcellreports"}
	classGVR   = schema.GroupVersionResource{Group: "fleet.actor.dev", Version: "v1alpha1", Resource: "shardclasses"}
	profileGVR = schema.GroupVersionResource{Group: "fleet.actor.dev", Version: "v1alpha1", Resource: "rivetcellprofiles"}
	fdbGVR     = schema.GroupVersionResource{Group: "apps.foundationdb.org", Version: "v1beta2", Resource: "foundationdbclusters"}
	backupGVR  = schema.GroupVersionResource{Group: "apps.foundationdb.org", Version: "v1beta2", Resource: "foundationdbbackups"}
)

type Config struct {
	Namespace                  string
	CellName                   string
	BackupName                 string
	RuntimeSelector            string
	BackupSelector             string
	RuntimeCOSSecret           string
	RuntimeAuthSecret          string
	FDBTLSSecret               string
	ReleaseDigest              string
	ReleaseLedgerConfigMap     string
	CapacityRisk               string
	QualificationReady         bool
	QualificationReceipt       string
	QualificationDigest        string
	QualificationReleaseDigest string
	Interval                   time.Duration
	PrometheusURL              string
	WorkerRegistryURL          string
	PrometheusSampleFreshness  time.Duration
}

type Reporter struct {
	Dynamic     dynamic.Interface
	Core        kubernetes.Interface
	Config      Config
	Now         func() time.Time
	HTTP        *http.Client
	AfterReport func(Observation)
}

type Observation struct {
	Report               *unstructured.Unstructured
	ProfileDigestMatches bool
	RuntimeZones         []string
	FDBZones             []string
	BackupZones          []string
	StaticRelease        StaticReleaseEvidence
}

func (r *Reporter) Run(ctx context.Context) error {
	if err := r.validate(); err != nil {
		return err
	}
	if r.Now == nil {
		r.Now = time.Now
	}
	if err := r.ReportOnce(ctx); err != nil {
		return err
	}
	ticker := time.NewTicker(r.Config.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := r.ReportOnce(ctx); err != nil {
				return err
			}
		}
	}
}

func (r *Reporter) ReportOnce(ctx context.Context) error {
	if err := r.validate(); err != nil {
		return err
	}
	observation, err := r.Observe(ctx)
	if err != nil {
		return err
	}
	reports := r.Dynamic.Resource(reportGVR).Namespace(r.Config.Namespace)
	existing, err := reports.Get(ctx, r.Config.CellName, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		_, err = reports.Create(ctx, observation.Report, metav1.CreateOptions{})
		if err == nil && r.AfterReport != nil {
			r.AfterReport(observation)
		}
		return err
	}
	if err != nil {
		return err
	}
	existingUID := nestedString(existing.Object, "spec", "cellRef", "uid")
	desiredUID := nestedString(observation.Report.Object, "spec", "cellRef", "uid")
	if existingUID != desiredUID {
		return fmt.Errorf("RivetCellReport is bound to Cell UID %q, current Cell UID is %q; recreate the Report explicitly", existingUID, desiredUID)
	}
	existing.Object["spec"] = observation.Report.Object["spec"]
	_, err = reports.Update(ctx, existing, metav1.UpdateOptions{})
	if err == nil && r.AfterReport != nil {
		r.AfterReport(observation)
	}
	return err
}

func (r *Reporter) Observe(ctx context.Context) (Observation, error) {
	cfg := r.Config
	now := r.Now
	if now == nil {
		now = time.Now
	}
	cell, err := r.Dynamic.Resource(cellGVR).Namespace(cfg.Namespace).Get(ctx, cfg.CellName, metav1.GetOptions{})
	if err != nil {
		return Observation{}, fmt.Errorf("get RivetCell: %w", err)
	}
	className := nestedString(cell.Object, "spec", "className")
	class, err := r.Dynamic.Resource(classGVR).Get(ctx, className, metav1.GetOptions{})
	if err != nil {
		return Observation{}, fmt.Errorf("get ShardClass: %w", err)
	}
	profileName := nestedString(class.Object, "spec", "profileRef", "name")
	profileDigest := nestedString(class.Object, "spec", "profileRef", "digest")
	profile, err := r.Dynamic.Resource(profileGVR).Get(ctx, profileName, metav1.GetOptions{})
	if err != nil {
		return Observation{}, fmt.Errorf("get RivetCellProfile: %w", err)
	}
	computedProfileDigest, err := digestSpec(profile)
	if err != nil {
		return Observation{}, err
	}
	profileDigestMatches := validDigest(profileDigest) && profileDigest == computedProfileDigest

	fdbName := nestedString(cell.Object, "spec", "foundationDB", "clusterRef", "name")
	fdb, err := r.Dynamic.Resource(fdbGVR).Namespace(cfg.Namespace).Get(ctx, fdbName, metav1.GetOptions{})
	if err != nil {
		return Observation{}, fmt.Errorf("get FoundationDBCluster: %w", err)
	}
	connectionString := nestedString(fdb.Object, "status", "connectionString")
	observedIdentity := databaseIdentityHash(string(fdb.GetUID()), connectionString)
	boundIdentity := nestedString(cell.Object, "spec", "foundationDB", "clusterIdentityHash")
	identityMismatch := observedIdentity == "" || boundIdentity == "" || observedIdentity != boundIdentity

	zoneCount := int(nestedInt64(profile.Object, "spec", "topology", "zoneCount"))
	maxSkew := int(nestedInt64(profile.Object, "spec", "topology", "maxSkew"))
	processCount := int(nestedInt64(profile.Object, "spec", "foundationDB", "processCount"))
	fdbPods, err := r.Core.CoreV1().Pods(cfg.Namespace).List(ctx, metav1.ListOptions{
		LabelSelector: "foundationdb.org/fdb-cluster-name=" + fdbName,
	})
	if err != nil {
		return Observation{}, fmt.Errorf("list FDB Pods: %w", err)
	}
	fdbReady, fdbZones, err := r.readyPodTopology(ctx, fdbPods.Items, processCount, zoneCount, maxSkew)
	if err != nil {
		return Observation{}, err
	}

	runtimePods, err := r.Core.CoreV1().Pods(cfg.Namespace).List(ctx, metav1.ListOptions{LabelSelector: cfg.RuntimeSelector})
	if err != nil {
		return Observation{}, fmt.Errorf("list runtime Pods: %w", err)
	}
	minRuntime := int(nestedInt64(profile.Object, "spec", "runtime", "minWorkerdHosts"))
	runtimeReady, runtimeZones, err := r.readyPodTopology(ctx, runtimePods.Items, minRuntime, zoneCount, maxSkew)
	if err != nil {
		return Observation{}, err
	}

	backup, err := r.Dynamic.Resource(backupGVR).Namespace(cfg.Namespace).Get(ctx, cfg.BackupName, metav1.GetOptions{})
	if err != nil {
		return Observation{}, fmt.Errorf("get FoundationDBBackup: %w", err)
	}
	backupPods, err := r.Core.CoreV1().Pods(cfg.Namespace).List(ctx, metav1.ListOptions{LabelSelector: cfg.BackupSelector})
	if err != nil {
		return Observation{}, fmt.Errorf("list backup Pods: %w", err)
	}
	backupAgents := int(nestedInt64(backup.Object, "spec", "agentCount"))
	backupReadyPods, backupZones, err := r.readyPodTopology(ctx, backupPods.Items, backupAgents, zoneCount, maxSkew)
	if err != nil {
		return Observation{}, err
	}
	backupRestorable, backupEvidenceErr := r.prometheusBackupRestorable(ctx)
	backupReady := backupEvidenceErr == nil && backupRestorable &&
		backupReadyPods >= backupAgents && backupAgents > 0 &&
		nestedBool(backup.Object, "status", "deploymentConfigured") &&
		nestedBool(backup.Object, "status", "backupDetails", "running") &&
		nestedInt64(backup.Object, "status", "generations", "reconciled") == backup.GetGeneration()

	credentialsReady := r.secretHas(ctx, cfg.RuntimeCOSSecret, "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY") &&
		r.secretHas(ctx, cfg.RuntimeAuthSecret, "token") &&
		r.secretHas(ctx, cfg.FDBTLSSecret, "ca.pem", "cert.pem", "key.pem")
	staticRelease := r.observeStaticRelease(ctx)
	placementCount, err := r.workerRegistryPlacementCount(ctx, cell.GetName(), string(cell.GetUID()))
	if err != nil {
		return Observation{}, fmt.Errorf("read authoritative Cell placement count: %w", err)
	}

	fdbAvailable := nestedBool(fdb.Object, "status", "configured") && nestedBool(fdb.Object, "status", "health", "available")
	fdbHealthy := fdbAvailable && nestedBool(fdb.Object, "status", "health", "healthy") &&
		nestedBool(fdb.Object, "status", "health", "fullReplication") &&
		nestedInt64(fdb.Object, "status", "generations", "reconciled") == fdb.GetGeneration() && fdbReady >= processCount
	fdbTopology := fdbReady >= processCount && len(fdbZones) == zoneCount

	capacity := map[string]any{
		"riskLevel":                cfg.CapacityRisk,
		"scaleOutEpoch":            int64(0),
		"placementCount":           placementCount,
		"pendingReservations":      int64(0),
		"activeWriters":            int64(0),
		"inFlightCommits":          int64(0),
		"migrationBacklog":         int64(0),
		"compactionBacklog":        int64(0),
		"gcBacklog":                int64(0),
		"reconciliationBacklog":    int64(0),
		"fdbCapacityEvidenceReady": false,
	}
	if evidence, evidenceErr := r.prometheusCapacity(ctx); evidenceErr == nil {
		capacity["fdbCapacityEvidenceReady"] = true
		capacity["fdbStorageHeadroomBytes"] = evidence.HeadroomBytes
		capacity["fdbLogicalBytes"] = evidence.LogicalBytes
		capacity["fdbStorageHeadroomSamples"] = evidence.HeadroomSamples
		capacity["fdbWriteUtilizationPercent"] = evidence.WriteUtilizationPercent
		capacity["fdbDataMovementBytes"] = evidence.DataMovementBytes
		capacity["fdbStorageHeadroomETAKnown"] = evidence.ETAKnown
		if evidence.ETAKnown {
			capacity["fdbStorageHeadroomETASeconds"] = evidence.ETASeconds
		}
	}

	qualificationReady := qualificationMatchesRelease(cfg)
	spec := map[string]any{
		"cellRef":                map[string]any{"name": cell.GetName(), "uid": string(cell.GetUID())},
		"observedCellGeneration": cell.GetGeneration(),
		"observedAt":             now().UTC().Format(time.RFC3339),
		"profileDigest":          profileDigest,
		"foundationDB": map[string]any{
			"clusterIdentityHash": observedIdentity,
			"available":           fdbAvailable,
			"healthy":             fdbHealthy,
			"topologyConforming":  fdbTopology,
		},
		"health": map[string]any{
			"runtimeReadyHosts":    int64(runtimeReady),
			"backupReady":          backupReady,
			"credentialsReady":     credentialsReady,
			"correctnessViolation": identityMismatch || !profileDigestMatches,
		},
		"capacity":      capacity,
		"qualification": map[string]any{"ready": qualificationReady},
		"staticRelease": map[string]any{
			"ledgerRef":  "ConfigMap/" + releaseLedgerName(cfg),
			"converged":  staticRelease.Ready,
			"driftCount": int64(staticRelease.DriftCount),
		},
	}
	staticReleaseSpec := spec["staticRelease"].(map[string]any)
	if staticRelease.ReleaseID != "" {
		staticReleaseSpec["releaseId"] = staticRelease.ReleaseID
	}
	if staticRelease.PayloadDigest != "" {
		staticReleaseSpec["payloadDigest"] = staticRelease.PayloadDigest
	}
	if validDigest(cfg.ReleaseDigest) {
		spec["releaseDigest"] = cfg.ReleaseDigest
	}
	if qualificationReady {
		spec["qualification"] = map[string]any{
			"ready": true, "receiptRef": cfg.QualificationReceipt, "receiptDigest": cfg.QualificationDigest,
			"releaseDigest": cfg.QualificationReleaseDigest,
		}
	}
	report := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "fleet.actor.dev/v1alpha1",
		"kind":       "RivetCellReport",
		"metadata": map[string]any{
			"name":      cfg.CellName,
			"namespace": cfg.Namespace,
			"labels":    map[string]any{"fleet.actor.dev/cell-name": cfg.CellName, "app.kubernetes.io/managed-by": "rivet-cell-reporter"},
		},
		"spec": spec,
	}}
	return Observation{
		Report:               report,
		ProfileDigestMatches: profileDigestMatches,
		RuntimeZones:         runtimeZones,
		FDBZones:             fdbZones,
		BackupZones:          backupZones,
		StaticRelease:        staticRelease,
	}, nil
}

func (r *Reporter) readyPodTopology(ctx context.Context, pods []corev1.Pod, minimum, zoneCount, maxSkew int) (int, []string, error) {
	counts := map[string]int{}
	ready := 0
	for i := range pods {
		pod := &pods[i]
		if !podReady(pod) || pod.Spec.NodeName == "" {
			continue
		}
		node, err := r.Core.CoreV1().Nodes().Get(ctx, pod.Spec.NodeName, metav1.GetOptions{})
		if err != nil {
			return 0, nil, fmt.Errorf("get Node %s: %w", pod.Spec.NodeName, err)
		}
		zone := node.Labels[corev1.LabelTopologyZone]
		if zone == "" {
			continue
		}
		counts[zone]++
		ready++
	}
	zones := make([]string, 0, len(counts))
	for zone := range counts {
		zones = append(zones, zone)
	}
	sort.Strings(zones)
	if ready < minimum || len(zones) != zoneCount || !withinSkew(counts, maxSkew) {
		return 0, zones, nil
	}
	return ready, zones, nil
}

func (r *Reporter) secretHas(ctx context.Context, name string, keys ...string) bool {
	secret, err := r.Core.CoreV1().Secrets(r.Config.Namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return false
	}
	for _, key := range keys {
		if len(secret.Data[key]) == 0 {
			return false
		}
	}
	return true
}

func (r *Reporter) validate() error {
	if r.Dynamic == nil || r.Core == nil {
		return errors.New("Kubernetes clients are required")
	}
	if r.Config.Namespace == "" || r.Config.CellName == "" || r.Config.BackupName == "" {
		return errors.New("namespace, Cell name and backup name are required")
	}
	if r.Config.Interval <= 0 {
		return errors.New("report interval must be positive")
	}
	if err := validateWorkerRegistryURL(r.Config.WorkerRegistryURL); err != nil {
		return err
	}
	switch r.Config.CapacityRisk {
	case "Normal", "AdmissionClosed", "Protect", "Emergency":
	default:
		return fmt.Errorf("invalid capacity risk %q", r.Config.CapacityRisk)
	}
	if r.Config.QualificationReady && (r.Config.QualificationReceipt == "" || !validDigest(r.Config.QualificationDigest) || !validDigest(r.Config.QualificationReleaseDigest)) {
		return errors.New("a ready qualification requires a receipt, receipt digest, and release digest")
	}
	return nil
}

func qualificationMatchesRelease(cfg Config) bool {
	return cfg.QualificationReady && validDigest(cfg.ReleaseDigest) && cfg.QualificationReleaseDigest == cfg.ReleaseDigest
}

func podReady(pod *corev1.Pod) bool {
	if pod.DeletionTimestamp != nil {
		return false
	}
	for _, condition := range pod.Status.Conditions {
		if condition.Type == corev1.PodReady {
			return condition.Status == corev1.ConditionTrue
		}
	}
	return false
}

func withinSkew(counts map[string]int, maxSkew int) bool {
	if len(counts) == 0 {
		return false
	}
	minimum, maximum := int(^uint(0)>>1), 0
	for _, count := range counts {
		if count < minimum {
			minimum = count
		}
		if count > maximum {
			maximum = count
		}
	}
	return maximum-minimum <= maxSkew
}

func databaseIdentityHash(clusterUID, connectionString string) string {
	databaseName, coordinators, found := strings.Cut(connectionString, ":")
	if clusterUID == "" || !found || databaseName == "" || !strings.Contains(coordinators, "@") {
		return ""
	}
	sum := sha256.Sum256([]byte("foundationdb-kubernetes-v1\x00" + clusterUID + "\x00" + databaseName))
	return "sha256:" + hex.EncodeToString(sum[:])
}

func digestSpec(value *unstructured.Unstructured) (string, error) {
	spec, found, err := unstructured.NestedMap(value.Object, "spec")
	if err != nil || !found {
		return "", fmt.Errorf("read profile spec: found=%t: %w", found, err)
	}
	canonical, err := json.Marshal(spec)
	if err != nil {
		return "", fmt.Errorf("marshal profile spec: %w", err)
	}
	sum := sha256.Sum256(canonical)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

func validDigest(value string) bool {
	if len(value) != 71 || !strings.HasPrefix(value, "sha256:") {
		return false
	}
	_, err := hex.DecodeString(value[7:])
	return err == nil
}

func nestedString(value map[string]any, fields ...string) string {
	result, _, _ := unstructured.NestedString(value, fields...)
	return result
}

func nestedBool(value map[string]any, fields ...string) bool {
	result, _, _ := unstructured.NestedBool(value, fields...)
	return result
}

func nestedInt64(value map[string]any, fields ...string) int64 {
	result, _, _ := unstructured.NestedInt64(value, fields...)
	return result
}
