package main

import (
	"flag"
	"os"
	"time"

	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	clusterv1 "open-cluster-management.io/api/cluster/v1"
	workv1 "open-cluster-management.io/api/work/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	"github.com/rivet-dev/rivet/infra/cells/internal/fleetcontroller"
)

func main() {
	var metricsAddress string
	var healthAddress string
	var watchNamespace string
	var leaderElectionNamespace string
	var leaderElection bool
	var reportFreshness time.Duration
	var maxClaimsPerReconcile int64
	var enableFDBKubernetesProvider bool
	var enableOCMProvider bool
	var enableExternalProvider bool

	flag.StringVar(&metricsAddress, "metrics-bind-address", ":8080", "address for controller metrics; set to 0 to disable")
	flag.StringVar(&healthAddress, "health-probe-bind-address", ":8081", "address for health and readiness probes")
	flag.StringVar(&watchNamespace, "watch-namespace", os.Getenv("WATCH_NAMESPACE"), "limit namespaced watches to one namespace")
	flag.StringVar(&leaderElectionNamespace, "leader-election-namespace", os.Getenv("POD_NAMESPACE"), "namespace that stores the leader-election Lease")
	flag.BoolVar(&leaderElection, "leader-elect", true, "use Lease leader election")
	flag.DurationVar(&reportFreshness, "report-freshness", fleetcontroller.DefaultReportFreshness, "maximum age of a Cell report")
	flag.Int64Var(&maxClaimsPerReconcile, "max-claims-per-reconcile", 1, "maximum Cell claims created in one reconcile")
	flag.BoolVar(&enableFDBKubernetesProvider, "enable-fdb-kubernetes-provider", false, "reconcile operator-backed RivetCells into FoundationDBCluster resources")
	flag.BoolVar(&enableOCMProvider, "enable-ocm-provider", false, "reconcile RivetCellClaims through OCM ManifestWork resources")
	flag.BoolVar(&enableExternalProvider, "enable-external-provider", false, "adopt Terraform/Argo provisioned Cells through identity-fenced RivetCellRegistrations")
	zapOptions := zap.Options{Development: false}
	zapOptions.BindFlags(flag.CommandLine)
	flag.Parse()
	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&zapOptions)))
	logger := ctrl.Log.WithName("setup")
	if leaderElectionNamespace == "" {
		leaderElectionNamespace = watchNamespace
	}

	if err := fleetcontroller.ValidateConfiguration(reportFreshness, maxClaimsPerReconcile); err != nil {
		logger.Error(err, "invalid configuration")
		os.Exit(2)
	}
	if leaderElection && leaderElectionNamespace == "" {
		logger.Error(nil, "leader-election-namespace or POD_NAMESPACE is required when leader election is enabled")
		os.Exit(2)
	}
	if enableOCMProvider && enableExternalProvider {
		logger.Error(nil, "OCM and external Claim providers are mutually exclusive")
		os.Exit(2)
	}

	scheme := runtime.NewScheme()
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(clusterv1.AddToScheme(scheme))
	utilruntime.Must(workv1.AddToScheme(scheme))
	options := ctrl.Options{
		Scheme:                  scheme,
		Metrics:                 metricsserver.Options{BindAddress: metricsAddress},
		HealthProbeBindAddress:  healthAddress,
		LeaderElection:          leaderElection,
		LeaderElectionID:        "actor-fleet-controller.fleet.actor.dev",
		LeaderElectionNamespace: leaderElectionNamespace,
	}
	if watchNamespace != "" {
		options.Cache = cache.Options{DefaultNamespaces: map[string]cache.Config{watchNamespace: {}}}
	}

	manager, err := ctrl.NewManager(ctrl.GetConfigOrDie(), options)
	if err != nil {
		logger.Error(err, "create manager")
		os.Exit(1)
	}
	if err := (&fleetcontroller.CellReconciler{
		Client: manager.GetClient(), ReportFreshness: reportFreshness, WatchFDBClusters: enableFDBKubernetesProvider,
	}).SetupWithManager(manager); err != nil {
		logger.Error(err, "create RivetCell controller")
		os.Exit(1)
	}
	if err := (&fleetcontroller.PoolReconciler{
		Client: manager.GetClient(), Reader: manager.GetAPIReader(), MaxClaimsPerReconcile: maxClaimsPerReconcile,
		ReportFreshness: reportFreshness,
	}).SetupWithManager(manager); err != nil {
		logger.Error(err, "create ShardPool controller")
		os.Exit(1)
	}
	if enableOCMProvider {
		if err := (&fleetcontroller.ClaimReconciler{
			Client: manager.GetClient(), EnvironmentFreshness: reportFreshness,
		}).SetupWithManager(manager); err != nil {
			logger.Error(err, "create RivetCellClaim OCM controller")
			os.Exit(1)
		}
	}
	if enableExternalProvider {
		if err := (&fleetcontroller.ExternalClaimReconciler{
			Client: manager.GetClient(), Reader: manager.GetAPIReader(), ReportFreshness: reportFreshness,
			CredentialNamespace: leaderElectionNamespace,
		}).SetupWithManager(manager); err != nil {
			logger.Error(err, "create RivetCellClaim Terraform/Argo adoption controller")
			os.Exit(1)
		}
	}
	if enableFDBKubernetesProvider {
		if err := (&fleetcontroller.FDBKubernetesReconciler{Client: manager.GetClient()}).SetupWithManager(manager); err != nil {
			logger.Error(err, "create FoundationDBCluster provider controller")
			os.Exit(1)
		}
		if err := (&fleetcontroller.FDBVolumeRetirementReconciler{Client: manager.GetClient()}).SetupWithManager(manager); err != nil {
			logger.Error(err, "create FDB volume retirement controller")
			os.Exit(1)
		}
	}
	if err := manager.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		logger.Error(err, "add health check")
		os.Exit(1)
	}
	if err := manager.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		logger.Error(err, "add readiness check")
		os.Exit(1)
	}

	logger.Info("starting actor fleet controller", "watchNamespace", displayNamespace(watchNamespace), "reportFreshness", reportFreshness.String(), "fdbKubernetesProvider", enableFDBKubernetesProvider, "ocmProvider", enableOCMProvider, "externalProvider", enableExternalProvider)
	if err := manager.Start(ctrl.SetupSignalHandler()); err != nil {
		logger.Error(err, "manager stopped")
		os.Exit(1)
	}
}

func displayNamespace(namespace string) string {
	if namespace == "" {
		return "all"
	}
	return namespace
}
