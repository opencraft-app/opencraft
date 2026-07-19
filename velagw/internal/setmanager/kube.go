package setmanager

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

type KubeClient struct {
	BaseURL    string
	Token      string
	HTTPClient *http.Client
}

type kubeStatus struct {
	Code    int    `json:"code"`
	Reason  string `json:"reason"`
	Message string `json:"message"`
}

type LLMFleet struct {
	Metadata struct {
		Name            string `json:"name"`
		Namespace       string `json:"namespace"`
		Generation      int64  `json:"generation"`
		ResourceVersion string `json:"resourceVersion"`
	} `json:"metadata"`
	Spec struct {
		Availability    LLMFleetAvailability     `json:"availability,omitempty"`
		NewAPI          LLMFleetNewAPI           `json:"newapi"`
		NewAPIImage     string                   `json:"newapiImage"`
		Shards          []LLMFleetShard          `json:"shards"`
		Sets            []LLMFleetSet            `json:"sets"`
		TrafficRuntimes []LLMFleetTrafficRuntime `json:"trafficRuntimes,omitempty"`
		Cleanups        []LLMFleetCleanup        `json:"cleanups,omitempty"`
	} `json:"spec"`
	Status struct {
		Conditions                  []LLMFleetCondition               `json:"conditions"`
		Cleanups                    []LLMFleetCleanupStatus           `json:"cleanups,omitempty"`
		TrafficDeployments          []LLMFleetTrafficDeploymentStatus `json:"trafficDeployments,omitempty"`
		TrafficPodDisruptionBudgets []LLMFleetTrafficPDBStatus        `json:"trafficPodDisruptionBudgets,omitempty"`
	} `json:"status"`
}

type LLMFleetAvailability struct {
	Traffic LLMFleetTrafficAvailability `json:"traffic,omitempty"`
}

type LLMFleetTrafficAvailability struct {
	MinReplicas     int    `json:"minReplicas,omitempty"`
	TopologyKey     string `json:"topologyKey,omitempty"`
	PDBMinAvailable int    `json:"pdbMinAvailable,omitempty"`
}

type LLMFleetTrafficDeploymentStatus struct {
	SetID              string `json:"setID"`
	Generation         int64  `json:"generation"`
	Name               string `json:"name"`
	ObjectGeneration   int64  `json:"objectGeneration"`
	ObservedGeneration int64  `json:"observedGeneration"`
	DesiredReplicas    int    `json:"desiredReplicas"`
	ReadyReplicas      int    `json:"readyReplicas"`
	AvailableReplicas  int    `json:"availableReplicas"`
}

type LLMFleetTrafficPDBStatus struct {
	SetID              string `json:"setID"`
	Generation         int64  `json:"generation"`
	Name               string `json:"name"`
	MinAvailable       int    `json:"minAvailable"`
	ExpectedPods       int    `json:"expectedPods"`
	CurrentHealthy     int    `json:"currentHealthy"`
	DisruptionsAllowed int    `json:"disruptionsAllowed"`
}

type LLMFleetDatabasePool struct {
	MaxOpenConns       int `json:"maxOpenConns,omitempty"`
	MaxIdleConns       int `json:"maxIdleConns,omitempty"`
	MaxLifetimeSeconds int `json:"maxLifetimeSeconds,omitempty"`
}

type LLMFleetDatabasePools struct {
	Admin   LLMFleetDatabasePool `json:"admin,omitempty"`
	Traffic LLMFleetDatabasePool `json:"traffic,omitempty"`
}

type LLMFleetNewAPI struct {
	DatabasePool                 LLMFleetDatabasePools `json:"databasePool,omitempty"`
	SubscriptionWriteConcurrency int                   `json:"subscriptionWriteConcurrency,omitempty"`
}

type LLMFleetShard struct {
	Name         string                `json:"name"`
	MySQLHost    string                `json:"mysqlHost,omitempty"`
	MySQLPort    string                `json:"mysqlPort,omitempty"`
	RedisHost    string                `json:"redisHost,omitempty"`
	RedisPort    string                `json:"redisPort,omitempty"`
	SecretName   string                `json:"secretName,omitempty"`
	Status       string                `json:"status,omitempty"`
	MaxSets      int                   `json:"maxSets,omitempty"`
	RedisDBStart int                   `json:"redisDBStart,omitempty"`
	RedisDBLimit int                   `json:"redisDBLimit,omitempty"`
	DatabasePool LLMFleetDatabasePools `json:"databasePool,omitempty"`
}

type LLMFleetCleanup struct {
	CleanupID         string `json:"cleanupID"`
	JobName           string `json:"jobName"`
	SetID             string `json:"setID"`
	Attempt           int    `json:"attempt"`
	Source            string `json:"source"`
	Namespace         string `json:"namespace"`
	Fleet             string `json:"fleet"`
	ShardRef          string `json:"shardRef"`
	DatabaseName      string `json:"databaseName"`
	RedisDB           string `json:"redisDB"`
	RedisDBStart      int    `json:"redisDBStart"`
	RedisDBLimit      int    `json:"redisDBLimit"`
	LeaseFingerprint  string `json:"leaseFingerprint"`
	ClaimToken        string `json:"claimToken"`
	CleanupCapability string `json:"cleanupCapability"`
}

func runtimeCleanupJobName(cleanupID string, attempt int) string {
	digest := sha256.Sum256([]byte(cleanupID))
	return fmt.Sprintf("llmgw-cleanup-%x-%d", digest[:16], attempt)
}

type LLMFleetCleanupStatus struct {
	CleanupID string `json:"cleanupID"`
	Attempt   int    `json:"attempt"`
	JobUID    string `json:"jobUID,omitempty"`
	Active    int    `json:"active,omitempty"`
	Succeeded int    `json:"succeeded,omitempty"`
	Failed    int    `json:"failed,omitempty"`
	Message   string `json:"message,omitempty"`
}

type LLMFleetSetRuntimeConfig struct {
	Admin                        LLMFleetDatabasePool
	Traffic                      LLMFleetDatabasePool
	SubscriptionWriteConcurrency int
}

type LLMFleetSet struct {
	Name                         string `json:"name"`
	DisplayName                  string `json:"displayName,omitempty"`
	ShardRef                     string `json:"shardRef"`
	Replicas                     int    `json:"replicas"`
	DatabaseName                 string `json:"databaseName"`
	RedisDB                      string `json:"redisDB"`
	SessionSecret                string `json:"sessionSecret"`
	AdminSQLMaxOpenConns         int    `json:"adminSQLMaxOpenConns"`
	AdminSQLMaxIdleConns         int    `json:"adminSQLMaxIdleConns"`
	AdminSQLMaxLifetimeSeconds   int    `json:"adminSQLMaxLifetimeSeconds"`
	TrafficSQLMaxOpenConns       int    `json:"trafficSQLMaxOpenConns"`
	TrafficSQLMaxIdleConns       int    `json:"trafficSQLMaxIdleConns"`
	TrafficSQLMaxLifetimeSeconds int    `json:"trafficSQLMaxLifetimeSeconds"`
	SubscriptionWriteConcurrency int    `json:"subscriptionWriteConcurrency"`
	AdminImage                   string `json:"adminImage,omitempty"`
	LegacyTrafficImage           string `json:"legacyTrafficImage,omitempty"`
	LegacyTrafficEnabled         *bool  `json:"legacyTrafficEnabled,omitempty"`
}

type LLMFleetTrafficRuntime struct {
	SetID      string `json:"setID"`
	Generation int64  `json:"generation"`
	Image      string `json:"image"`
	Replicas   int    `json:"replicas"`
}

type LLMFleetCondition struct {
	Type               string `json:"type"`
	Status             string `json:"status"`
	ObservedGeneration int64  `json:"observedGeneration"`
	Reason             string `json:"reason,omitempty"`
	Message            string `json:"message,omitempty"`
}

func NewInClusterKubeClient() (KubeClient, error) {
	host := os.Getenv("KUBERNETES_SERVICE_HOST")
	port := os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" {
		host = "kubernetes.default.svc"
	}
	if port == "" {
		port = "443"
	}
	token, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/token")
	if err != nil {
		return KubeClient{}, err
	}
	ca, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt")
	if err != nil {
		return KubeClient{}, err
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(ca)
	return KubeClient{
		BaseURL: "https://" + host + ":" + port,
		Token:   strings.TrimSpace(string(token)),
		HTTPClient: &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{
			TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
		}},
	}, nil
}

func (c KubeClient) GetLLMFleet(ctx context.Context, namespace string, name string) (LLMFleet, error) {
	var fleet LLMFleet
	err := c.do(ctx, http.MethodGet, llmFleetPath(namespace, name), nil, nil, &fleet)
	return fleet, err
}

func (c KubeClient) PatchLLMFleetSets(ctx context.Context, namespace string, name string, resourceVersion string, sets []LLMFleetSet) error {
	return c.PatchLLMFleetRuntime(ctx, namespace, name, resourceVersion, sets, nil)
}

func (c KubeClient) PatchLLMFleetRuntime(ctx context.Context, namespace string, name string, resourceVersion string, sets []LLMFleetSet, cleanups []LLMFleetCleanup) error {
	patch := []map[string]any{
		{"op": "test", "path": "/metadata/resourceVersion", "value": resourceVersion},
		{"op": "replace", "path": "/spec/sets", "value": sets},
	}
	if cleanups != nil {
		patch = append(patch, map[string]any{"op": "replace", "path": "/spec/cleanups", "value": cleanups})
	}
	return c.do(ctx, http.MethodPatch, llmFleetPath(namespace, name), patch, map[string]string{"Content-Type": "application/json-patch+json"}, nil)
}

func (c KubeClient) PatchLLMFleetDecommission(ctx context.Context, namespace string, name string, resourceVersion string, sets []LLMFleetSet, runtimes []LLMFleetTrafficRuntime, cleanups []LLMFleetCleanup) error {
	patch := []map[string]any{
		{"op": "test", "path": "/metadata/resourceVersion", "value": resourceVersion},
		{"op": "replace", "path": "/spec/sets", "value": sets},
		{"op": "add", "path": "/spec/trafficRuntimes", "value": runtimes},
		{"op": "replace", "path": "/spec/cleanups", "value": cleanups},
	}
	return c.do(ctx, http.MethodPatch, llmFleetPath(namespace, name), patch, map[string]string{"Content-Type": "application/json-patch+json"}, nil)
}

func (c KubeClient) PatchLLMFleetUpgradeRuntime(ctx context.Context, namespace string, name string, resourceVersion string, sets []LLMFleetSet, runtimes []LLMFleetTrafficRuntime) error {
	patch := []map[string]any{
		{"op": "test", "path": "/metadata/resourceVersion", "value": resourceVersion},
		{"op": "replace", "path": "/spec/sets", "value": sets},
		{"op": "add", "path": "/spec/trafficRuntimes", "value": runtimes},
	}
	return c.do(ctx, http.MethodPatch, llmFleetPath(namespace, name), patch, map[string]string{"Content-Type": "application/json-patch+json"}, nil)
}

func (c KubeClient) WaitLLMFleetReady(ctx context.Context, namespace string, name string, timeout time.Duration) (LLMFleet, error) {
	if timeout <= 0 {
		timeout = 5 * time.Minute
	}
	deadline := time.Now().Add(timeout)
	var fleet LLMFleet
	var lastStatus []LLMFleetCondition
	for {
		current, err := c.GetLLMFleet(ctx, namespace, name)
		if err != nil {
			return current, err
		}
		fleet = current
		lastStatus = current.Status.Conditions
		if llmFleetReady(current) {
			return current, nil
		}
		if time.Now().After(deadline) {
			return fleet, fmt.Errorf("llmfleet %s/%s not ready before timeout; conditions=%v", namespace, name, lastStatus)
		}
		select {
		case <-ctx.Done():
			return fleet, ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
}

func llmFleetReady(fleet LLMFleet) bool {
	for _, condition := range fleet.Status.Conditions {
		if condition.Type != "Ready" {
			continue
		}
		return condition.Status == "True" && condition.ObservedGeneration >= fleet.Metadata.Generation
	}
	return false
}

func (c KubeClient) do(ctx context.Context, method string, path string, body any, headers map[string]string, out any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.BaseURL, "/")+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	client := c.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var status kubeStatus
		if json.Unmarshal(raw, &status) == nil && status.Message != "" {
			return fmt.Errorf("%s %s status=%d reason=%s message=%s", method, path, resp.StatusCode, status.Reason, status.Message)
		}
		return fmt.Errorf("%s %s status=%d body=%s", method, path, resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}

func llmFleetPath(namespace string, name string) string {
	return "/apis/llmgateway.io/v1alpha1/namespaces/" + namespace + "/llmfleets/" + name
}
