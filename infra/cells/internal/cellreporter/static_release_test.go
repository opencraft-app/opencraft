package cellreporter

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
)

const (
	staticTestCell      = "actor-bj-q01"
	staticTestNamespace = "actor-fdb-cell-system"
)

var (
	staticRuntimeImage  = "registry.invalid/runtime@sha256:" + strings.Repeat("a", 64)
	staticReporterImage = "registry.invalid/reporter@sha256:" + strings.Repeat("b", 64)
	staticNATSImage     = "registry.invalid/nats@sha256:" + strings.Repeat("c", 64)
	staticMetricsImage  = "registry.invalid/metrics@sha256:" + strings.Repeat("d", 64)
)

func staticDeployment(name, component string, replicas int32, images map[string]string) *appsv1.Deployment {
	containers := []corev1.Container{}
	for containerName, image := range images {
		containers = append(containers, corev1.Container{Name: containerName, Image: image, Args: []string{"serve"}})
	}
	return &appsv1.Deployment{
		TypeMeta:   metav1.TypeMeta{APIVersion: "apps/v1", Kind: "Deployment"},
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: staticTestNamespace},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"fleet.actor.dev/component": component}},
			Strategy: appsv1.DeploymentStrategy{Type: appsv1.RollingUpdateDeploymentStrategyType},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels:      map[string]string{"fleet.actor.dev/component": component},
					Annotations: map[string]string{"fleet.actor.dev/manifest-sha256": strings.Repeat("e", 64)},
				},
				Spec: corev1.PodSpec{Containers: containers},
			},
		},
	}
}

func staticStatefulSet(name, component string, replicas int32, images, initImages map[string]string) *appsv1.StatefulSet {
	containers := []corev1.Container{}
	for containerName, image := range images {
		containers = append(containers, corev1.Container{Name: containerName, Image: image, Args: []string{"serve"}})
	}
	initContainers := []corev1.Container{}
	for containerName, image := range initImages {
		initContainers = append(initContainers, corev1.Container{Name: containerName, Image: image})
	}
	return &appsv1.StatefulSet{
		TypeMeta:   metav1.TypeMeta{APIVersion: "apps/v1", Kind: "StatefulSet"},
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: staticTestNamespace},
		Spec: appsv1.StatefulSetSpec{
			Replicas:       &replicas,
			ServiceName:    name,
			Selector:       &metav1.LabelSelector{MatchLabels: map[string]string{"fleet.actor.dev/component": component}},
			UpdateStrategy: appsv1.StatefulSetUpdateStrategy{Type: appsv1.RollingUpdateStatefulSetStrategyType},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels:      map[string]string{"fleet.actor.dev/component": component},
					Annotations: map[string]string{"fleet.actor.dev/manifest-sha256": strings.Repeat("e", 64)},
				},
				Spec: corev1.PodSpec{Containers: containers, InitContainers: initContainers},
			},
		},
	}
}

func staticPod(name, component string, images, initImages map[string]string) *corev1.Pod {
	statuses := []corev1.ContainerStatus{}
	for containerName, image := range images {
		statuses = append(statuses, corev1.ContainerStatus{Name: containerName, Ready: true, ImageID: "containerd://" + strings.Split(image, "@")[1]})
	}
	initStatuses := []corev1.ContainerStatus{}
	for containerName, image := range initImages {
		initStatuses = append(initStatuses, corev1.ContainerStatus{Name: containerName, Ready: true, ImageID: "containerd://" + strings.Split(image, "@")[1]})
	}
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: name, Namespace: staticTestNamespace,
			Labels: map[string]string{"fleet.actor.dev/cell-name": staticTestCell, "fleet.actor.dev/component": component},
		},
		Status: corev1.PodStatus{
			Phase:             corev1.PodRunning,
			Conditions:        []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}},
			ContainerStatuses: statuses, InitContainerStatuses: initStatuses,
		},
	}
}

func staticWorkloadLedgerEntry(t *testing.T, value runtime.Object, kind, name, component string, images, initImages map[string]string) map[string]any {
	t.Helper()
	document, err := objectMap(value)
	if err != nil {
		t.Fatal(err)
	}
	spec := cloneMap(document["spec"].(map[string]any))
	delete(spec, "replicas")
	return map[string]any{
		"kind": kind, "name": name, "namespace": staticTestNamespace,
		"selector":   map[string]any{"fleet.actor.dev/component": component},
		"containers": toAnyMap(images), "initContainers": toAnyMap(initImages),
		"staticSpecDigest": hashJSON(spec),
	}
}

func toAnyMap(values map[string]string) map[string]any {
	result := map[string]any{}
	for key, value := range values {
		result[key] = value
	}
	return result
}

func staticConfigLedgerEntry(config *corev1.ConfigMap) map[string]any {
	data := config.Data
	if data == nil {
		data = map[string]string{}
	}
	binaryData := config.BinaryData
	if binaryData == nil {
		binaryData = map[string][]byte{}
	}
	return map[string]any{
		"name": config.Name, "namespace": staticTestNamespace,
		"contentDigest": hashJSON(map[string]any{
			"data": data, "binaryData": binaryData, "immutable": false,
		}),
	}
}

func staticReporterFixture(t *testing.T) *Reporter {
	t.Helper()
	engine := staticDeployment(staticTestCell+"-engine", "engine", 3, map[string]string{"engine": staticRuntimeImage})
	runtimeHosts := staticStatefulSet(
		staticTestCell+"-runtime-hosts", "workerd-host", 3,
		map[string]string{"workerd": staticRuntimeImage, "workerd-host": staticRuntimeImage, "workerd-metrics": staticMetricsImage},
		map[string]string{"prepare-workerd-config": staticRuntimeImage},
	)
	capacity := staticDeployment(staticTestCell+"-runtime-capacity", "runtime-capacity-controller", 1, map[string]string{"controller": staticReporterImage})
	nats := staticStatefulSet(staticTestCell+"-nats", "nats", 3, map[string]string{"nats": staticNATSImage}, nil)
	reporterDeploy := staticDeployment(staticTestCell+"-cell-reporter", "cell-reporter", 1, map[string]string{"reporter": staticReporterImage})
	runtimeConfig := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: staticTestCell + "-runtime-config", Namespace: staticTestNamespace}, Data: map[string]string{"config": "runtime"}}
	natsConfig := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: staticTestCell + "-nats-config", Namespace: staticTestNamespace}, Data: map[string]string{"config": "nats"}}

	workloads := []any{
		staticWorkloadLedgerEntry(t, engine, "Deployment", engine.Name, "engine", map[string]string{"engine": staticRuntimeImage}, nil),
		staticWorkloadLedgerEntry(t, runtimeHosts, "StatefulSet", runtimeHosts.Name, "workerd-host", map[string]string{"workerd": staticRuntimeImage, "workerd-host": staticRuntimeImage, "workerd-metrics": staticMetricsImage}, map[string]string{"prepare-workerd-config": staticRuntimeImage}),
		staticWorkloadLedgerEntry(t, capacity, "Deployment", capacity.Name, "runtime-capacity-controller", map[string]string{"controller": staticReporterImage}, nil),
		staticWorkloadLedgerEntry(t, nats, "StatefulSet", nats.Name, "nats", map[string]string{"nats": staticNATSImage}, nil),
		staticWorkloadLedgerEntry(t, reporterDeploy, "Deployment", reporterDeploy.Name, "cell-reporter", map[string]string{"reporter": staticReporterImage}, nil),
	}
	ledger := map[string]any{
		"schemaVersion": staticReleaseLedgerSchema,
		"cell":          staticTestCell, "namespace": staticTestNamespace,
		"releasedAt": "2026-09-05T00:00:00Z",
		"source": map[string]any{
			"runtime": map[string]any{"revision": strings.Repeat("f", 40), "manifestSha256": strings.Repeat("1", 64)},
			"control": map[string]any{"revision": strings.Repeat("2", 40), "manifestSha256": strings.Repeat("3", 64)},
		},
		"workloads":  workloads,
		"configMaps": []any{staticConfigLedgerEntry(runtimeConfig), staticConfigLedgerEntry(natsConfig)},
		"preflight":  []any{map[string]any{"image": staticRuntimeImage, "contract": "validate-runtime-image.sh"}},
	}
	ledger["releaseId"] = hashJSON(map[string]any{
		"schemaVersion": ledger["schemaVersion"], "cell": ledger["cell"], "namespace": ledger["namespace"],
		"source": ledger["source"], "workloads": ledger["workloads"], "configMaps": ledger["configMaps"], "preflight": ledger["preflight"],
	})
	payload, err := json.Marshal(ledger)
	if err != nil {
		t.Fatal(err)
	}
	payloadSum := sha256.Sum256(payload)
	ledgerConfig := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name: staticTestCell + "-release-ledger", Namespace: staticTestNamespace,
			Annotations: map[string]string{"fleet.actor.dev/release-receipt-sha256": "sha256:" + hex.EncodeToString(payloadSum[:])},
		},
		Data: map[string]string{"ledger.json": string(payload)},
	}
	objects := []runtime.Object{
		engine, runtimeHosts, capacity, nats, reporterDeploy, runtimeConfig, natsConfig, ledgerConfig,
		staticPod("engine-0", "engine", map[string]string{"engine": staticRuntimeImage}, nil),
		staticPod("runtime-0", "workerd-host", map[string]string{"workerd": staticRuntimeImage, "workerd-host": staticRuntimeImage, "workerd-metrics": staticMetricsImage}, map[string]string{"prepare-workerd-config": staticRuntimeImage}),
		staticPod("capacity-0", "runtime-capacity-controller", map[string]string{"controller": staticReporterImage}, nil),
		staticPod("nats-0", "nats", map[string]string{"nats": staticNATSImage}, nil),
		staticPod("reporter-0", "cell-reporter", map[string]string{"reporter": staticReporterImage}, nil),
	}
	return &Reporter{
		Core:   fake.NewSimpleClientset(objects...),
		Config: Config{Namespace: staticTestNamespace, CellName: staticTestCell},
	}
}

func TestStaticReleaseConvergesAndIgnoresReplicas(t *testing.T) {
	reporter := staticReporterFixture(t)
	evidence := reporter.observeStaticRelease(context.Background())
	if !evidence.Ready {
		t.Fatalf("expected matching release, got %#v", evidence)
	}
	stateful, err := reporter.Core.AppsV1().StatefulSets(staticTestNamespace).Get(context.Background(), staticTestCell+"-runtime-hosts", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	nineteen := int32(19)
	stateful.Spec.Replicas = &nineteen
	if _, err := reporter.Core.AppsV1().StatefulSets(staticTestNamespace).Update(context.Background(), stateful, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	evidence = reporter.observeStaticRelease(context.Background())
	if !evidence.Ready {
		t.Fatalf("dynamic replica change became static drift: %#v", evidence)
	}
}

func TestStaticReleaseIgnoresQualificationOwnedReporterEnvironment(t *testing.T) {
	reporter := staticReporterFixture(t)
	deployment, err := reporter.Core.AppsV1().Deployments(staticTestNamespace).Get(
		context.Background(), staticTestCell+"-cell-reporter", metav1.GetOptions{},
	)
	if err != nil {
		t.Fatal(err)
	}
	deployment.Spec.Template.Spec.Containers[0].Env = []corev1.EnvVar{
		{Name: "CAPACITY_RISK", Value: "Normal"},
		{Name: "QUALIFICATION_READY", Value: "true"},
		{Name: "QUALIFICATION_RECEIPT", Value: "kubernetes://receipt"},
		{Name: "QUALIFICATION_DIGEST", Value: "sha256:" + strings.Repeat("1", 64)},
		{Name: "QUALIFICATION_RELEASE_DIGEST", Value: "sha256:" + strings.Repeat("2", 64)},
	}
	if _, err := reporter.Core.AppsV1().Deployments(staticTestNamespace).Update(
		context.Background(), deployment, metav1.UpdateOptions{},
	); err != nil {
		t.Fatal(err)
	}
	evidence := reporter.observeStaticRelease(context.Background())
	if !evidence.Ready {
		t.Fatalf("qualification-owned reporter inputs became static drift: %#v", evidence)
	}
}

func TestStaticReleaseDetectsOtherReporterEnvironmentDrift(t *testing.T) {
	reporter := staticReporterFixture(t)
	deployment, err := reporter.Core.AppsV1().Deployments(staticTestNamespace).Get(
		context.Background(), staticTestCell+"-cell-reporter", metav1.GetOptions{},
	)
	if err != nil {
		t.Fatal(err)
	}
	deployment.Spec.Template.Spec.Containers[0].Env = []corev1.EnvVar{{Name: "REPORT_INTERVAL", Value: "1s"}}
	if _, err := reporter.Core.AppsV1().Deployments(staticTestNamespace).Update(
		context.Background(), deployment, metav1.UpdateOptions{},
	); err != nil {
		t.Fatal(err)
	}
	evidence := reporter.observeStaticRelease(context.Background())
	if evidence.Ready {
		t.Fatalf("release-owned reporter environment drift passed: %#v", evidence)
	}
}

func TestStaticReleaseDetectsTemplateDrift(t *testing.T) {
	reporter := staticReporterFixture(t)
	engine, err := reporter.Core.AppsV1().Deployments(staticTestNamespace).Get(context.Background(), staticTestCell+"-engine", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	engine.Spec.Template.Spec.Containers[0].Command = []string{"wrong"}
	if _, err := reporter.Core.AppsV1().Deployments(staticTestNamespace).Update(context.Background(), engine, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	evidence := reporter.observeStaticRelease(context.Background())
	if evidence.Ready || evidence.DriftCount == 0 {
		t.Fatalf("template drift passed: %#v", evidence)
	}
}

func TestStaticReleaseMissingLedgerFailsClosed(t *testing.T) {
	reporter := &Reporter{Core: fake.NewSimpleClientset(), Config: Config{Namespace: staticTestNamespace, CellName: staticTestCell}}
	evidence := reporter.observeStaticRelease(context.Background())
	if evidence.Ready || evidence.DriftCount != 1 {
		t.Fatalf("missing ledger did not fail closed: %#v", evidence)
	}
}

func TestHashJSONMatchesReleaseLedgerCanonicalEncoding(t *testing.T) {
	value := map[string]any{"command": "a && b < c", "unicode": "中文"}
	want := "sha256:aeac6d31e2fd68f35869322c3e0bff5e442e88f7be5b290c6bb172402ad1263f"
	if got := hashJSON(value); got != want {
		t.Fatalf("cross-language canonical digest mismatch: got %s want %s", got, want)
	}
}
