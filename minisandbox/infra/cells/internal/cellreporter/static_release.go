package cellreporter

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const staticReleaseLedgerSchema = "actor-fleet-static-release-ledger/v1"

var pinnedReleaseImage = regexp.MustCompile(`^.+@(sha256:[0-9a-f]{64})$`)

// StaticReleaseEvidence is intentionally low-cardinality. Detailed findings
// stay in logs and the autonomy receipt; Prometheus receives only Cell-level
// convergence, finding count, and drift age.
type StaticReleaseEvidence struct {
	Ready         bool
	DriftCount    int
	ReleaseID     string
	PayloadDigest string
	Reasons       []string
}

func (r *Reporter) observeStaticRelease(ctx context.Context) StaticReleaseEvidence {
	cfg := r.Config
	ledgerName := releaseLedgerName(cfg)
	ledgerConfig, err := r.Core.CoreV1().ConfigMaps(cfg.Namespace).Get(ctx, ledgerName, metav1.GetOptions{})
	if err != nil {
		return staticReleaseFailure("release_ledger_configmap_unavailable")
	}
	payload := ledgerConfig.Data["ledger.json"]
	if payload == "" {
		return staticReleaseFailure("release_ledger_payload_missing")
	}
	payloadSum := sha256.Sum256([]byte(payload))
	payloadDigest := "sha256:" + hex.EncodeToString(payloadSum[:])
	if ledgerConfig.Annotations["fleet.actor.dev/release-receipt-sha256"] != payloadDigest {
		evidence := staticReleaseFailure("release_ledger_payload_digest_mismatch")
		evidence.PayloadDigest = payloadDigest
		return evidence
	}

	var ledger map[string]any
	if err := json.Unmarshal([]byte(payload), &ledger); err != nil {
		return staticReleaseFailure("release_ledger_payload_malformed")
	}
	evidence := StaticReleaseEvidence{
		ReleaseID:     stringValue(ledger["releaseId"]),
		PayloadDigest: payloadDigest,
	}
	if stringValue(ledger["schemaVersion"]) != staticReleaseLedgerSchema ||
		stringValue(ledger["cell"]) != cfg.CellName || stringValue(ledger["namespace"]) != cfg.Namespace {
		evidence.addDrift("release_ledger_identity_mismatch")
		return evidence
	}
	identity := map[string]any{
		"schemaVersion": ledger["schemaVersion"],
		"cell":          ledger["cell"],
		"namespace":     ledger["namespace"],
		"source":        ledger["source"],
		"workloads":     ledger["workloads"],
		"configMaps":    ledger["configMaps"],
		"preflight":     ledger["preflight"],
	}
	if evidence.ReleaseID == "" || evidence.ReleaseID != hashJSON(identity) {
		evidence.addDrift("release_ledger_identity_digest_mismatch")
		return evidence
	}

	pods, err := r.Core.CoreV1().Pods(cfg.Namespace).List(ctx, metav1.ListOptions{
		LabelSelector: "fleet.actor.dev/cell-name=" + cfg.CellName,
	})
	if err != nil {
		evidence.addDrift("release_pod_inventory_unavailable")
		return evidence
	}

	workloads, ok := ledger["workloads"].([]any)
	if !ok || len(workloads) < 4 || len(workloads) > 5 {
		evidence.addDrift("release_ledger_workload_inventory_invalid")
		return evidence
	}
	seen := map[string]bool{}
	for _, raw := range workloads {
		item, ok := raw.(map[string]any)
		if !ok {
			evidence.addDrift("release_ledger_workload_entry_invalid")
			continue
		}
		kind, name := stringValue(item["kind"]), stringValue(item["name"])
		component := kind + "/" + name
		if item["namespace"] != cfg.Namespace || seen[component] || !allowedReleaseWorkload(cfg.CellName, kind, name) {
			evidence.addDrift(component + ":inventory_invalid")
			continue
		}
		seen[component] = true
		var observed map[string]any
		switch kind {
		case "Deployment":
			value, getErr := r.Core.AppsV1().Deployments(cfg.Namespace).Get(ctx, name, metav1.GetOptions{})
			if getErr == nil {
				observed, getErr = objectMap(value)
			}
			err = getErr
		case "StatefulSet":
			value, getErr := r.Core.AppsV1().StatefulSets(cfg.Namespace).Get(ctx, name, metav1.GetOptions{})
			if getErr == nil {
				observed, getErr = objectMap(value)
			}
			err = getErr
		default:
			err = fmt.Errorf("unsupported kind")
		}
		if err != nil {
			evidence.addDrift(component + ":workload_unavailable")
			continue
		}
		spec, _ := observed["spec"].(map[string]any)
		staticSpec := cloneMap(spec)
		delete(staticSpec, "replicas")
		if kind == "Deployment" && name == cfg.CellName+"-cell-reporter" {
			removeDynamicReporterEnvironment(staticSpec)
		}
		if hashJSON(staticSpec) != stringValue(item["staticSpecDigest"]) {
			evidence.addDrift(component + ":static_spec_digest_mismatch")
		}
		templateSpec := nestedMap(observed, "spec", "template", "spec")
		containers, containerErr := namedReleaseImages(templateSpec, "containers")
		initContainers, initErr := namedReleaseImages(templateSpec, "initContainers")
		if containerErr != nil || initErr != nil || !sameStringMap(containers, stringMap(item["containers"])) ||
			!sameStringMap(initContainers, stringMap(item["initContainers"])) {
			evidence.addDrift(component + ":container_images_mismatch")
		}
		selector := stringMap(nestedAny(item, "selector"))
		readyPods := matchingReadyPods(pods.Items, selector)
		if len(readyPods) == 0 {
			evidence.addDrift(component + ":no_ready_pod_for_release")
			continue
		}
		expectedImages := map[string]string{}
		for key, value := range stringMap(item["containers"]) {
			expectedImages[key] = value
		}
		for key, value := range stringMap(item["initContainers"]) {
			expectedImages[key] = value
		}
		for i := range readyPods {
			if !podRunsImages(&readyPods[i], expectedImages) {
				evidence.addDrift(component + ":pod_image_id_mismatch")
				break
			}
		}
	}
	for _, required := range requiredReleaseWorkloads(cfg.CellName) {
		if !seen[required] {
			evidence.addDrift(required + ":workload_missing_from_ledger")
		}
	}

	configMaps, ok := ledger["configMaps"].([]any)
	if !ok || len(configMaps) != 2 {
		evidence.addDrift("release_ledger_configmap_inventory_invalid")
	} else {
		seenConfig := map[string]bool{}
		for _, raw := range configMaps {
			item, itemOK := raw.(map[string]any)
			if !itemOK {
				evidence.addDrift("release_ledger_configmap_entry_invalid")
				continue
			}
			name := stringValue(item["name"])
			if item["namespace"] != cfg.Namespace || seenConfig[name] ||
				(name != cfg.CellName+"-runtime-config" && name != cfg.CellName+"-nats-config") {
				evidence.addDrift("ConfigMap/" + name + ":inventory_invalid")
				continue
			}
			seenConfig[name] = true
			value, getErr := r.Core.CoreV1().ConfigMaps(cfg.Namespace).Get(ctx, name, metav1.GetOptions{})
			if getErr != nil {
				evidence.addDrift("ConfigMap/" + name + ":configmap_unavailable")
				continue
			}
			data := value.Data
			if data == nil {
				data = map[string]string{}
			}
			binaryData := value.BinaryData
			if binaryData == nil {
				binaryData = map[string][]byte{}
			}
			content := map[string]any{
				"data":       data,
				"binaryData": binaryData,
				"immutable":  value.Immutable != nil && *value.Immutable,
			}
			if hashJSON(content) != stringValue(item["contentDigest"]) {
				evidence.addDrift("ConfigMap/" + name + ":content_digest_mismatch")
			}
		}
		for _, name := range []string{cfg.CellName + "-runtime-config", cfg.CellName + "-nats-config"} {
			if !seenConfig[name] {
				evidence.addDrift("ConfigMap/" + name + ":missing_from_ledger")
			}
		}
	}
	sort.Strings(evidence.Reasons)
	evidence.DriftCount = len(evidence.Reasons)
	evidence.Ready = evidence.DriftCount == 0
	return evidence
}

func removeDynamicReporterEnvironment(spec map[string]any) {
	dynamic := map[string]bool{
		"CAPACITY_RISK": true, "QUALIFICATION_READY": true,
		"QUALIFICATION_RECEIPT": true, "QUALIFICATION_DIGEST": true,
		"QUALIFICATION_RELEASE_DIGEST": true,
	}
	templateSpec := nestedMap(spec, "template", "spec")
	containers, _ := templateSpec["containers"].([]any)
	for _, raw := range containers {
		container, ok := raw.(map[string]any)
		if !ok || stringValue(container["name"]) != "reporter" {
			continue
		}
		rawEnvironment, exists := container["env"]
		if !exists {
			return
		}
		environment, _ := rawEnvironment.([]any)
		filtered := make([]any, 0, len(environment))
		for _, value := range environment {
			item, ok := value.(map[string]any)
			if ok && dynamic[stringValue(item["name"])] {
				continue
			}
			filtered = append(filtered, value)
		}
		if len(filtered) == 0 {
			delete(container, "env")
		} else {
			container["env"] = filtered
		}
		return
	}
}

func releaseLedgerName(cfg Config) string {
	if cfg.ReleaseLedgerConfigMap != "" {
		return cfg.ReleaseLedgerConfigMap
	}
	return cfg.CellName + "-release-ledger"
}

func staticReleaseFailure(reason string) StaticReleaseEvidence {
	return StaticReleaseEvidence{Ready: false, DriftCount: 1, Reasons: []string{reason}}
}

func (e *StaticReleaseEvidence) addDrift(reason string) {
	for _, existing := range e.Reasons {
		if existing == reason {
			return
		}
	}
	e.Reasons = append(e.Reasons, reason)
	e.DriftCount = len(e.Reasons)
}

func requiredReleaseWorkloads(cell string) []string {
	return []string{
		"Deployment/" + cell + "-engine",
		"Deployment/" + cell + "-runtime-capacity",
		"StatefulSet/" + cell + "-nats",
		"StatefulSet/" + cell + "-runtime-hosts",
	}
}

func allowedReleaseWorkload(cell, kind, name string) bool {
	component := kind + "/" + name
	for _, required := range requiredReleaseWorkloads(cell) {
		if component == required {
			return true
		}
	}
	return component == "Deployment/"+cell+"-cell-reporter"
}

func objectMap(value any) (map[string]any, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	err = json.Unmarshal(payload, &result)
	return result, err
}

func cloneMap(value map[string]any) map[string]any {
	payload, _ := json.Marshal(value)
	var result map[string]any
	_ = json.Unmarshal(payload, &result)
	return result
}

func hashJSON(value any) string {
	var payload bytes.Buffer
	encoder := json.NewEncoder(&payload)
	// release_ledger.py defines the cross-language canonical representation.
	// Encoding &, <, and > as JSON unicode escapes changes the digest even
	// though the Kubernetes value is identical, so disable Go's HTML-only
	// escaping and remove Encoder's trailing newline.
	encoder.SetEscapeHTML(false)
	err := encoder.Encode(value)
	if err != nil {
		return ""
	}
	canonical := bytes.TrimSuffix(payload.Bytes(), []byte{'\n'})
	sum := sha256.Sum256(canonical)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func nestedAny(value map[string]any, path ...string) any {
	current := any(value)
	for _, key := range path {
		mapping, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current = mapping[key]
	}
	return current
}

func nestedMap(value map[string]any, path ...string) map[string]any {
	result, _ := nestedAny(value, path...).(map[string]any)
	return result
}

func stringValue(value any) string {
	result, _ := value.(string)
	return result
}

func stringMap(value any) map[string]string {
	result := map[string]string{}
	mapping, _ := value.(map[string]any)
	for key, raw := range mapping {
		if text, ok := raw.(string); ok {
			result[key] = text
		}
	}
	return result
}

func namedReleaseImages(spec map[string]any, field string) (map[string]string, error) {
	result := map[string]string{}
	items, _ := spec[field].([]any)
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("invalid container")
		}
		name, image := stringValue(item["name"]), stringValue(item["image"])
		if name == "" || result[name] != "" || !pinnedReleaseImage.MatchString(image) {
			return nil, fmt.Errorf("invalid immutable container image")
		}
		result[name] = image
	}
	return result, nil
}

func sameStringMap(left, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	for key, value := range left {
		if right[key] != value {
			return false
		}
	}
	return true
}

func matchingReadyPods(pods []corev1.Pod, selector map[string]string) []corev1.Pod {
	result := []corev1.Pod{}
	if len(selector) == 0 {
		return result
	}
	for i := range pods {
		pod := &pods[i]
		if !podReady(pod) {
			continue
		}
		matches := true
		for key, value := range selector {
			if pod.Labels[key] != value {
				matches = false
				break
			}
		}
		if matches {
			result = append(result, *pod)
		}
	}
	return result
}

func podRunsImages(pod *corev1.Pod, expected map[string]string) bool {
	statuses := map[string]string{}
	for _, status := range pod.Status.ContainerStatuses {
		statuses[status.Name] = status.ImageID
	}
	for _, status := range pod.Status.InitContainerStatuses {
		statuses[status.Name] = status.ImageID
	}
	for name, image := range expected {
		match := pinnedReleaseImage.FindStringSubmatch(image)
		if len(match) != 2 || !strings.Contains(statuses[name], match[1]) {
			return false
		}
	}
	return true
}
