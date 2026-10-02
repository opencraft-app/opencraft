package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/rivet-dev/rivet/infra/cells/internal/hostdrain"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	config, err := rest.InClusterConfig()
	if err != nil {
		log.Fatalf("load in-cluster config: %v", err)
	}
	client, err := kubernetes.NewForConfig(config)
	if err != nil {
		log.Fatalf("create Kubernetes client: %v", err)
	}
	namespace := required("CELL_NAMESPACE")
	cell := required("CELL_NAME")
	secretName := value("RUNTIME_AUTH_SECRET", cell+"-runtime-auth")
	secret, err := client.CoreV1().Secrets(namespace).Get(ctx, secretName, metav1.GetOptions{})
	if err != nil {
		log.Fatalf("read runtime authentication secret: %v", err)
	}
	controller := &hostdrain.Controller{
		Kubernetes: client,
		Config: hostdrain.ControllerConfig{
			Namespace: namespace, CellName: cell,
			StatefulSetName: value("HOST_DRAIN_STATEFULSET", cell+"-runtime-hosts"),
			HPAName:         value("HOST_DRAIN_HPA", cell+"-runtime-hosts-actor-capacity"),
			PodSelector:     value("RUNTIME_SELECTOR", "fleet.actor.dev/cell-name="+cell+",fleet.actor.dev/component=workerd-host"),
			Token:           string(secret.Data["token"]), ManagementPort: integer("HOST_DRAIN_MANAGEMENT_PORT", 19083),
			MinReplicas:            int32(integer("HOST_DRAIN_MIN_REPLICAS", 2)),
			MaxRemainingUsagePct:   int64(integer("HOST_DRAIN_MAX_REMAINING_USAGE_PERCENT", 70)),
			MetricsFreshness:       duration("HOST_DRAIN_METRICS_FRESHNESS", 45*time.Second),
			ScaleDownStabilization: duration("HOST_DRAIN_STABILIZATION", 5*time.Minute),
			DrainTimeout:           duration("HOST_DRAIN_TIMEOUT", 10*time.Minute),
			ReconcileInterval:      duration("HOST_DRAIN_RECONCILE_INTERVAL", 5*time.Second),
			TopologyKey:            value("HOST_DRAIN_TOPOLOGY_KEY", "topology.kubernetes.io/zone"),
			RequiredZones:          integer("HOST_DRAIN_REQUIRED_ZONES", 3),
			TopologyMaxSkew:        integer("HOST_DRAIN_TOPOLOGY_MAX_SKEW", 1),
		},
		Now: time.Now, Logf: log.Printf,
	}
	controller.Run(ctx)
}

func required(name string) string {
	if result := os.Getenv(name); result != "" {
		return result
	}
	log.Fatalf("%s is required", name)
	return ""
}

func value(name, fallback string) string {
	if result := os.Getenv(name); result != "" {
		return result
	}
	return fallback
}

func integer(name string, fallback int) int {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	result, err := strconv.Atoi(raw)
	if err != nil || result <= 0 {
		log.Fatalf("%s must be a positive integer", name)
	}
	return result
}

func duration(name string, fallback time.Duration) time.Duration {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	result, err := time.ParseDuration(raw)
	if err != nil || result <= 0 {
		log.Fatalf("%s must be a positive duration", name)
	}
	return result
}
