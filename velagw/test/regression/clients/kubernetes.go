package clients

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/framework"
)

const (
	RegressionRunAnnotation = "llmgateway.io/regression-run"
	RegressionRolloutLease  = "llmgateway-regression-traffic-rollout"
	ReportHashAnnotation    = "llmgateway.io/report-sha256"
	ReportStatusAnnotation  = "llmgateway.io/report-status"
	MaxReportConfigMapBytes = 900 << 10
)

type OwnerReference struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Name       string `json:"name"`
	UID        string `json:"uid"`
}

type ObjectMeta struct {
	Name                       string            `json:"name,omitempty"`
	Namespace                  string            `json:"namespace,omitempty"`
	UID                        string            `json:"uid,omitempty"`
	ResourceVersion            string            `json:"resourceVersion,omitempty"`
	Generation                 int64             `json:"generation,omitempty"`
	Labels                     map[string]string `json:"labels,omitempty"`
	Annotations                map[string]string `json:"annotations,omitempty"`
	DeletionTimestamp          *time.Time        `json:"deletionTimestamp,omitempty"`
	DeletionGracePeriodSeconds *int64            `json:"deletionGracePeriodSeconds,omitempty"`
	OwnerReferences            []OwnerReference  `json:"ownerReferences,omitempty"`
}

type Deployment struct {
	Metadata ObjectMeta `json:"metadata"`
	Spec     struct {
		Replicas                int `json:"replicas"`
		ProgressDeadlineSeconds int `json:"progressDeadlineSeconds"`
		Strategy                struct {
			Type          string `json:"type"`
			RollingUpdate struct {
				MaxSurge       any `json:"maxSurge"`
				MaxUnavailable any `json:"maxUnavailable"`
			} `json:"rollingUpdate"`
		} `json:"strategy"`
		Template PodTemplate `json:"template"`
	} `json:"spec"`
	Status struct {
		ObservedGeneration  int64 `json:"observedGeneration"`
		ReadyReplicas       int   `json:"readyReplicas"`
		UpdatedReplicas     int   `json:"updatedReplicas"`
		AvailableReplicas   int   `json:"availableReplicas"`
		UnavailableReplicas int   `json:"unavailableReplicas"`
	} `json:"status"`
}

type ReplicaSet struct {
	Metadata ObjectMeta `json:"metadata"`
	Spec     struct {
		Replicas int         `json:"replicas"`
		Template PodTemplate `json:"template"`
	} `json:"spec"`
	Status struct {
		ReadyReplicas     int `json:"readyReplicas"`
		AvailableReplicas int `json:"availableReplicas"`
	} `json:"status"`
}

type PodTemplate struct {
	Metadata ObjectMeta `json:"metadata"`
	Spec     struct {
		TerminationGracePeriodSeconds int64       `json:"terminationGracePeriodSeconds"`
		Containers                    []Container `json:"containers"`
	} `json:"spec"`
}

type Container struct {
	Name           string          `json:"name"`
	Image          string          `json:"image"`
	Ports          []ContainerPort `json:"ports"`
	Env            []EnvVar        `json:"env"`
	ReadinessProbe struct {
		FailureThreshold int `json:"failureThreshold"`
	} `json:"readinessProbe"`
}

type ContainerPort struct {
	Name          string `json:"name"`
	ContainerPort int    `json:"containerPort"`
}

type EnvVar struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type Pod struct {
	Metadata ObjectMeta `json:"metadata"`
	Status   PodStatus  `json:"status"`
}

type PodStatus struct {
	Phase             string            `json:"phase"`
	PodIP             string            `json:"podIP"`
	Ready             bool              `json:"-"`
	ContainerStatuses []ContainerStatus `json:"containerStatuses"`
}

type CronJob struct {
	Spec struct {
		Suspend     *bool `json:"suspend,omitempty"`
		JobTemplate struct {
			Spec map[string]any `json:"spec"`
		} `json:"jobTemplate"`
	} `json:"spec"`
	Status struct {
		Active []OwnerReference `json:"active"`
	} `json:"status"`
}

type Job struct {
	Metadata ObjectMeta `json:"metadata"`
	Status   struct {
		Active    int `json:"active"`
		Succeeded int `json:"succeeded"`
		Failed    int `json:"failed"`
	} `json:"status"`
}

type JobList struct {
	Items []Job `json:"items"`
}

type ContainerStatus struct {
	Name         string `json:"name"`
	Ready        bool   `json:"ready"`
	RestartCount int    `json:"restartCount"`
}

func (p Pod) IsReady() bool {
	if p.Status.Ready {
		return true
	}
	if p.Status.Phase != "Running" || len(p.Status.ContainerStatuses) == 0 {
		return false
	}
	for _, status := range p.Status.ContainerStatuses {
		if !status.Ready {
			return false
		}
	}
	return true
}

func (p Pod) RestartCount() int {
	total := 0
	for _, status := range p.Status.ContainerStatuses {
		total += status.RestartCount
	}
	return total
}

type PodDisruptionBudget struct {
	Metadata ObjectMeta `json:"metadata"`
	Spec     struct {
		MinAvailable any `json:"minAvailable"`
	} `json:"spec"`
	Status PDBStatus `json:"status"`
}

type PDBStatus struct {
	CurrentHealthy     int `json:"currentHealthy"`
	DesiredHealthy     int `json:"desiredHealthy"`
	DisruptionsAllowed int `json:"disruptionsAllowed"`
	ExpectedPods       int `json:"expectedPods"`
}

func (d Deployment) TemplateAnnotation(name string) string {
	return d.Spec.Template.Metadata.Annotations[name]
}

func (d Deployment) TemplateFingerprint() (string, error) {
	raw, err := json.Marshal(d.Spec.Template)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

type Lease struct {
	APIVersion string     `json:"apiVersion,omitempty"`
	Kind       string     `json:"kind,omitempty"`
	Metadata   ObjectMeta `json:"metadata"`
	Spec       LeaseSpec  `json:"spec"`
}

type LeaseSpec struct {
	HolderIdentity       string              `json:"holderIdentity,omitempty"`
	LeaseDurationSeconds int32               `json:"leaseDurationSeconds,omitempty"`
	AcquireTime          KubernetesMicroTime `json:"acquireTime,omitempty"`
	RenewTime            KubernetesMicroTime `json:"renewTime,omitempty"`
}

type KubernetesMicroTime struct{ time.Time }

func (value KubernetesMicroTime) MarshalJSON() ([]byte, error) {
	return json.Marshal(value.UTC().Format("2006-01-02T15:04:05.000000Z07:00"))
}

func (value *KubernetesMicroTime) UnmarshalJSON(raw []byte) error {
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return err
	}
	parsed, err := time.Parse(time.RFC3339Nano, text)
	if err != nil {
		return err
	}
	value.Time = parsed.UTC()
	return nil
}

type KubernetesClient struct {
	baseURL   string
	token     framework.Secret
	http      *http.Client
	sanitizer *framework.Sanitizer
	now       func() time.Time
}

func NewKubernetesClient(baseURL string, token framework.Secret, client *http.Client, sanitizer *framework.Sanitizer) *KubernetesClient {
	if client == nil {
		client = &http.Client{Timeout: 45 * time.Second}
	}
	sanitizer = ensureSanitizer(sanitizer)
	return &KubernetesClient{
		baseURL: strings.TrimRight(baseURL, "/"), token: token, http: client, sanitizer: sanitizer,
		now: func() time.Time { return time.Now().UTC() },
	}
}

func NewInClusterKubernetesClient(sanitizer *framework.Sanitizer) (*KubernetesClient, error) {
	sanitizer = ensureSanitizer(sanitizer)
	host := strings.TrimSpace(os.Getenv("KUBERNETES_SERVICE_HOST"))
	port := strings.TrimSpace(os.Getenv("KUBERNETES_SERVICE_PORT"))
	if host == "" {
		host = "kubernetes.default.svc"
	}
	if port == "" {
		port = "443"
	}
	tokenRaw, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/token")
	if err != nil {
		return nil, err
	}
	caRaw, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt")
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caRaw) {
		return nil, errors.New("load Kubernetes service account CA")
	}
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}
	token := sanitizer.Secret(strings.TrimSpace(string(tokenRaw)))
	return NewKubernetesClient("https://"+host+":"+port, token, &http.Client{Timeout: 45 * time.Second, Transport: transport}, sanitizer), nil
}

func (c *KubernetesClient) SetCronJobSuspended(ctx context.Context, namespace, name string, suspended bool) error {
	return c.do(ctx, http.MethodPatch, batchPath(namespace, "cronjobs/"+url.PathEscape(name)), "application/merge-patch+json", map[string]any{
		"spec": map[string]any{"suspend": suspended},
	}, nil)
}

func (c *KubernetesClient) GetCronJob(ctx context.Context, namespace, name string) (CronJob, error) {
	var result CronJob
	err := c.do(ctx, http.MethodGet, batchPath(namespace, "cronjobs/"+url.PathEscape(name)), "", nil, &result)
	return result, err
}

func (c *KubernetesClient) CreateSetManagerJob(ctx context.Context, namespace, cronJobName, jobName, managerImage, probeModel, holdStatus, runID string) error {
	cron, err := c.GetCronJob(ctx, namespace, cronJobName)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(cron.Spec.JobTemplate.Spec)
	if err != nil {
		return err
	}
	var spec map[string]any
	if err := json.Unmarshal(raw, &spec); err != nil {
		return err
	}
	if err := configureSetManagerJob(spec, managerImage, map[string]string{
		"LLMGATEWAY_SET_UPGRADE_PROBE_MODEL":            probeModel,
		"LLMGATEWAY_SET_UPGRADE_PROBE_INTERVAL_SECONDS": "1",
		"LLMGATEWAY_SET_UPGRADE_LEASE_SECONDS":          "10",
		"LLMGATEWAY_REGRESSION_HOLD_UPGRADE_STATUS":     holdStatus,
		"LLMGATEWAY_REGRESSION_UPGRADE_OWNER":           jobName,
	}); err != nil {
		return err
	}
	spec["backoffLimit"] = 0
	body := map[string]any{
		"apiVersion": "batch/v1", "kind": "Job",
		"metadata": map[string]any{
			"name": jobName,
			"labels": map[string]string{
				"app.kubernetes.io/name": "llmgateway-regression-set-manager",
				RegressionRunAnnotation:  runID,
			},
		},
		"spec": spec,
	}
	return c.do(ctx, http.MethodPost, batchPath(namespace, "jobs"), "application/json", body, nil)
}

func configureSetManagerJob(spec map[string]any, managerImage string, values map[string]string) error {
	template, ok := spec["template"].(map[string]any)
	if !ok {
		return fmt.Errorf("set-manager CronJob template is missing")
	}
	podSpec, ok := template["spec"].(map[string]any)
	if !ok {
		return fmt.Errorf("set-manager CronJob pod spec is missing")
	}
	containers, ok := podSpec["containers"].([]any)
	if !ok {
		return fmt.Errorf("set-manager CronJob containers are missing")
	}
	for _, item := range containers {
		container, ok := item.(map[string]any)
		if !ok || container["name"] != "set-manager" {
			continue
		}
		if strings.TrimSpace(managerImage) != "" {
			container["image"] = managerImage
		}
		env, _ := container["env"].([]any)
		kept := make([]any, 0, len(env)+len(values))
		for _, raw := range env {
			entry, _ := raw.(map[string]any)
			name, _ := entry["name"].(string)
			if _, replace := values[name]; !replace {
				kept = append(kept, raw)
			}
		}
		for name, value := range values {
			if strings.TrimSpace(value) == "" {
				continue
			}
			kept = append(kept, map[string]any{"name": name, "value": value})
		}
		container["env"] = kept
		return nil
	}
	return fmt.Errorf("set-manager CronJob does not contain set-manager container")
}

func (c *KubernetesClient) GetJob(ctx context.Context, namespace, name string) (Job, error) {
	var result Job
	err := c.do(ctx, http.MethodGet, batchPath(namespace, "jobs/"+url.PathEscape(name)), "", nil, &result)
	return result, err
}

func (c *KubernetesClient) ListActiveCronJobJobs(ctx context.Context, namespace, cronJobName string) ([]Job, error) {
	var result JobList
	if err := c.do(ctx, http.MethodGet, batchPath(namespace, "jobs"), "", nil, &result); err != nil {
		return nil, err
	}
	active := make([]Job, 0)
	for _, job := range result.Items {
		if job.Metadata.DeletionTimestamp != nil || job.Status.Active <= 0 {
			continue
		}
		for _, owner := range job.Metadata.OwnerReferences {
			if owner.Kind == "CronJob" && owner.Name == cronJobName {
				active = append(active, job)
				break
			}
		}
	}
	return active, nil
}

func (c *KubernetesClient) DeleteControlledJob(ctx context.Context, namespace, name string) error {
	err := c.do(ctx, http.MethodDelete, batchPath(namespace, "jobs/"+url.PathEscape(name)), "application/json", map[string]any{
		"apiVersion": "v1", "kind": "DeleteOptions", "propagationPolicy": "Background",
	}, nil)
	var httpErr *HTTPError
	if errors.As(err, &httpErr) && httpErr.Status == http.StatusNotFound {
		return nil
	}
	return err
}

func ensureSanitizer(sanitizer *framework.Sanitizer) *framework.Sanitizer {
	if sanitizer == nil {
		return framework.NewSanitizer()
	}
	return sanitizer
}

func (c *KubernetesClient) PatchTrafficRollout(ctx context.Context, namespace, name, resourceVersion string, annotationsExist bool, runID string) (Deployment, error) {
	annotationPath := "/spec/template/metadata/annotations/llmgateway.io~1regression-run"
	annotationOp := map[string]any{"op": "add", "path": annotationPath, "value": runID}
	if !annotationsExist {
		annotationOp = map[string]any{"op": "add", "path": "/spec/template/metadata/annotations", "value": map[string]string{RegressionRunAnnotation: runID}}
	}
	operations := []map[string]any{
		{"op": "test", "path": "/metadata/resourceVersion", "value": resourceVersion},
		annotationOp,
	}
	var result Deployment
	err := c.do(ctx, http.MethodPatch, appsPath(namespace, "deployments/"+name), "application/json-patch+json", operations, &result)
	return result, err
}

func (c *KubernetesClient) GetDeployment(ctx context.Context, namespace, name string) (Deployment, error) {
	var result Deployment
	err := c.do(ctx, http.MethodGet, appsPath(namespace, "deployments/"+name), "", nil, &result)
	return result, err
}

func (c *KubernetesClient) ScaleDeployment(ctx context.Context, namespace, name string, replicas int) (Deployment, Deployment, error) {
	if replicas < 0 {
		return Deployment{}, Deployment{}, fmt.Errorf("deployment replicas must not be negative")
	}
	before, err := c.GetDeployment(ctx, namespace, name)
	if err != nil {
		return Deployment{}, Deployment{}, err
	}
	operations := []map[string]any{
		{"op": "test", "path": "/metadata/resourceVersion", "value": before.Metadata.ResourceVersion},
		{"op": "replace", "path": "/spec/replicas", "value": replicas},
	}
	var after Deployment
	err = c.do(ctx, http.MethodPatch, appsPath(namespace, "deployments/"+url.PathEscape(name)), "application/json-patch+json", operations, &after)
	return before, after, err
}

func (c *KubernetesClient) ListPods(ctx context.Context, namespace, labelSelector string) ([]Pod, error) {
	var result struct {
		Items []Pod `json:"items"`
	}
	path := corePath(namespace, "pods")
	if strings.TrimSpace(labelSelector) != "" {
		path += "?labelSelector=" + url.QueryEscape(labelSelector)
	}
	err := c.do(ctx, http.MethodGet, path, "", nil, &result)
	return result.Items, err
}

func (c *KubernetesClient) ListReplicaSets(ctx context.Context, namespace, labelSelector string) ([]ReplicaSet, error) {
	var result struct {
		Items []ReplicaSet `json:"items"`
	}
	path := appsPath(namespace, "replicasets")
	if strings.TrimSpace(labelSelector) != "" {
		path += "?labelSelector=" + url.QueryEscape(labelSelector)
	}
	err := c.do(ctx, http.MethodGet, path, "", nil, &result)
	return result.Items, err
}

func (c *KubernetesClient) GetPDB(ctx context.Context, namespace, name string) (PodDisruptionBudget, error) {
	var result PodDisruptionBudget
	err := c.do(ctx, http.MethodGet, policyPath(namespace, "poddisruptionbudgets/"+name), "", nil, &result)
	return result, err
}

func (c *KubernetesClient) AcquireLease(ctx context.Context, namespace, name, holder string, ttl time.Duration) (Lease, error) {
	if name != RegressionRolloutLease {
		return Lease{}, fmt.Errorf("regression runner may only acquire Lease %q", RegressionRolloutLease)
	}
	path := coordinationPath(namespace, "leases/"+name)
	var current Lease
	err := c.do(ctx, http.MethodGet, path, "", nil, &current)
	var httpErr *HTTPError
	if errors.As(err, &httpErr) && httpErr.Status == http.StatusNotFound {
		now := kubernetesMicroTime(c.now())
		created := Lease{APIVersion: "coordination.k8s.io/v1", Kind: "Lease", Metadata: ObjectMeta{Name: name, Namespace: namespace}, Spec: LeaseSpec{
			HolderIdentity: holder, LeaseDurationSeconds: int32(ttl.Seconds()), AcquireTime: now, RenewTime: now,
		}}
		var result Lease
		if err := c.do(ctx, http.MethodPost, coordinationPath(namespace, "leases"), "application/json", created, &result); err != nil {
			return Lease{}, err
		}
		return result, nil
	}
	if err != nil {
		return Lease{}, err
	}
	now := kubernetesMicroTime(c.now())
	expiresAt := current.Spec.RenewTime.Add(time.Duration(current.Spec.LeaseDurationSeconds) * time.Second)
	if current.Spec.HolderIdentity != "" && current.Spec.HolderIdentity != holder && now.Before(expiresAt) {
		return Lease{}, fmt.Errorf("lease %q is held by another regression run", name)
	}
	current.Spec.HolderIdentity = holder
	current.Spec.LeaseDurationSeconds = int32(ttl.Seconds())
	current.Spec.AcquireTime = now
	current.Spec.RenewTime = now
	var result Lease
	if err := c.do(ctx, http.MethodPut, path, "application/json", current, &result); err != nil {
		return Lease{}, err
	}
	return result, nil
}

func (c *KubernetesClient) RenewLease(ctx context.Context, namespace, name, holder string, ttl time.Duration) (Lease, error) {
	if name != RegressionRolloutLease {
		return Lease{}, fmt.Errorf("regression runner may only renew Lease %q", RegressionRolloutLease)
	}
	path := coordinationPath(namespace, "leases/"+name)
	var lease Lease
	if err := c.do(ctx, http.MethodGet, path, "", nil, &lease); err != nil {
		return Lease{}, err
	}
	if lease.Spec.HolderIdentity != holder {
		return Lease{}, fmt.Errorf("lease %q holder changed", name)
	}
	lease.Spec.LeaseDurationSeconds = int32(ttl.Seconds())
	lease.Spec.RenewTime = kubernetesMicroTime(c.now())
	var result Lease
	if err := c.do(ctx, http.MethodPut, path, "application/json", lease, &result); err != nil {
		return Lease{}, err
	}
	return result, nil
}

func (c *KubernetesClient) ReleaseLease(ctx context.Context, namespace, name, holder string) error {
	if name != RegressionRolloutLease {
		return fmt.Errorf("regression runner may only release Lease %q", RegressionRolloutLease)
	}
	path := coordinationPath(namespace, "leases/"+name)
	var lease Lease
	if err := c.do(ctx, http.MethodGet, path, "", nil, &lease); err != nil {
		return err
	}
	if lease.Spec.HolderIdentity != holder {
		return fmt.Errorf("lease %q holder changed", name)
	}
	lease.Spec.HolderIdentity = ""
	lease.Spec.RenewTime = kubernetesMicroTime(c.now())
	return c.do(ctx, http.MethodPut, path, "application/json", lease, nil)
}

func kubernetesMicroTime(value time.Time) KubernetesMicroTime {
	return KubernetesMicroTime{Time: value.UTC().Truncate(time.Microsecond)}
}

func (c *KubernetesClient) CreateReportConfigMap(ctx context.Context, namespace, runID string, reportJSON, junitXML []byte) (string, error) {
	if len(reportJSON)+len(junitXML) > MaxReportConfigMapBytes {
		return "", fmt.Errorf("regression report is %d bytes, maximum is %d", len(reportJSON)+len(junitXML), MaxReportConfigMapBytes)
	}
	hash := sha256.New()
	_, _ = hash.Write(reportJSON)
	_, _ = hash.Write([]byte{0})
	_, _ = hash.Write(junitXML)
	digest := hex.EncodeToString(hash.Sum(nil))
	name := "llmgateway-regression-report-" + runID
	body := map[string]any{
		"apiVersion": "v1", "kind": "ConfigMap",
		"metadata": map[string]any{
			"name": name, "namespace": namespace,
			"labels":      map[string]string{"llmgateway.io/regression-run": runID},
			"annotations": map[string]string{ReportHashAnnotation: digest, ReportStatusAnnotation: "complete"},
		},
		"data": map[string]string{"report.json": string(reportJSON), "junit.xml": string(junitXML)},
	}
	if err := c.do(ctx, http.MethodPost, corePath(namespace, "configmaps"), "application/json", body, nil); err != nil {
		return "", err
	}
	return digest, nil
}

func (c *KubernetesClient) do(ctx context.Context, method, path, contentType string, body, out any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if !c.token.Empty() {
		req.Header.Set("Authorization", "Bearer "+c.token.Reveal())
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("%s %s request failed: %w", method, path, c.sanitizer.Error(err))
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message := http.StatusText(resp.StatusCode)
		var status struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(raw, &status) == nil && strings.TrimSpace(status.Message) != "" {
			message = c.sanitizer.String(status.Message)
		}
		return &HTTPError{Method: method, Path: path, Status: resp.StatusCode, Message: message}
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("decode %s %s response: %w", method, path, err)
		}
	}
	return nil
}

func appsPath(namespace, suffix string) string {
	return "/apis/apps/v1/namespaces/" + namespace + "/" + suffix
}

func coordinationPath(namespace, suffix string) string {
	return "/apis/coordination.k8s.io/v1/namespaces/" + namespace + "/" + suffix
}

func corePath(namespace, suffix string) string {
	return "/api/v1/namespaces/" + namespace + "/" + suffix
}

func policyPath(namespace, suffix string) string {
	return "/apis/policy/v1/namespaces/" + namespace + "/" + suffix
}

func batchPath(namespace, suffix string) string {
	return "/apis/batch/v1/namespaces/" + namespace + "/" + suffix
}
