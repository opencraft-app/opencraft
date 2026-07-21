package main

import (
	"flag"
	"log"
	"os"
	"time"

	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	velagwv1alpha1 "git.woa.com/wisp/mono2/llmgateway/internal/velagwset/api/v1alpha1"
	velagwsetcontroller "git.woa.com/wisp/mono2/llmgateway/internal/velagwset/controller"
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

	scheme := clientgoscheme.Scheme
	if err := velagwv1alpha1.AddToScheme(scheme); err != nil {
		log.Fatalf("register VelaGWSet API: %v", err)
	}
	resync := 10 * time.Minute
	options := ctrl.Options{
		Scheme:                        scheme,
		LeaderElection:                leaderElect,
		LeaderElectionID:              "velagwset-controller.gateway.lightvela.com",
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
		log.Fatalf("create VelaGWSet manager: %v", err)
	}
	reconciler := &velagwsetcontroller.VelaGWSetReconciler{Client: manager.GetClient(), Scheme: manager.GetScheme()}
	if err := reconciler.SetupWithManager(manager); err != nil {
		log.Fatalf("register VelaGWSet controller: %v", err)
	}
	if err := manager.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		log.Fatalf("register health check: %v", err)
	}
	if err := manager.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		log.Fatalf("register readiness check: %v", err)
	}
	if err := manager.Start(ctrl.SetupSignalHandler()); err != nil {
		log.Fatalf("run VelaGWSet controller: %v", err)
	}
}
