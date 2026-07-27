package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"time"

	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	"git.woa.com/wisp/mono2/llmgateway/internal/shardmanager"
)

func main() {
	var leaderElect bool
	var metricsAddress string
	var probeAddress string
	flag.BoolVar(&leaderElect, "leader-elect", false, "enable leader election")
	flag.StringVar(&metricsAddress, "metrics-bind-address", ":8080", "metrics listen address")
	flag.StringVar(&probeAddress, "health-probe-bind-address", ":8081", "health probe listen address")
	flag.Parse()
	ctrl.SetLogger(zap.New(zap.UseDevMode(true)))

	controlURL := os.Getenv("LLMGATEWAY_CONTROL_URL")
	internalToken := os.Getenv("INTERNAL_SERVICE_TOKEN")
	if controlURL == "" || internalToken == "" {
		log.Fatal("LLMGATEWAY_CONTROL_URL and INTERNAL_SERVICE_TOKEN are required")
	}
	resync := 10 * time.Minute
	options := ctrl.Options{
		Scheme:                        clientgoscheme.Scheme,
		LeaderElection:                leaderElect,
		LeaderElectionID:              "llmgateway-shard-manager.gateway.lightvela.com",
		LeaderElectionReleaseOnCancel: true,
		Metrics:                       metricsserver.Options{BindAddress: metricsAddress},
		HealthProbeBindAddress:        probeAddress,
		Cache:                         cache.Options{SyncPeriod: &resync},
	}
	if namespace := os.Getenv("POD_NAMESPACE"); namespace != "" {
		options.LeaderElectionNamespace = namespace
		options.Cache.DefaultNamespaces = map[string]cache.Config{namespace: {}}
	}
	manager, err := ctrl.NewManager(ctrl.GetConfigOrDie(), options)
	if err != nil {
		log.Fatalf("create Shard manager: %v", err)
	}
	reconciler := &shardmanager.Reconciler{
		Client: manager.GetClient(),
		Control: shardmanager.HTTPControlClient{
			BaseURL: controlURL, Token: internalToken, HTTPClient: &http.Client{Timeout: 30 * time.Second},
		},
		Fleet: envOr("LLMGATEWAY_FLEET", "prod"),
	}
	if err := reconciler.SetupWithManager(manager); err != nil {
		log.Fatalf("register Shard manager: %v", err)
	}
	if err := manager.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		log.Fatalf("register health check: %v", err)
	}
	if err := manager.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		log.Fatalf("register readiness check: %v", err)
	}
	if err := manager.Start(ctrl.SetupSignalHandler()); err != nil {
		log.Fatalf("run Shard manager: %v", err)
	}
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
