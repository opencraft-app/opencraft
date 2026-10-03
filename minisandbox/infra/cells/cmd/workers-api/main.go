package main

import (
	"context"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/rivet-dev/rivet/infra/cells/internal/workersapi"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

type stringList []string

func (values *stringList) String() string { return strings.Join(*values, ",") }

func (values *stringList) Set(value string) error {
	*values = append(*values, value)
	return nil
}

func main() {
	var listenAddress string
	var internalListenAddress string
	var registryURL string
	var engineURLs stringList
	var engineCells stringList
	var engineCellUIDs stringList
	var enginePoolUIDs stringList
	var datacenters stringList
	var engineTokens stringList
	var namespace string
	var runnerNameSelector string
	var internalToken string
	var objectRouterTokens stringList
	var statelessExecutorURLs stringList
	var statelessExecutorTokens stringList
	var maxRequestBytes int64
	var requestTimeout time.Duration
	var prepareTimeout time.Duration
	var maxConcurrentPrepares int
	var actorReadyTimeout time.Duration
	var fetchResponseHeaderTimeout time.Duration
	var actorCacheCapacity int
	var actorCacheIdleTTL time.Duration
	var objectMissCapacity int
	var deploymentCacheCapacity int
	var placementNamespace string
	var placementPool string
	var placementRouteNamespace string
	var placementMaxReportAge time.Duration
	var placementRefreshInterval time.Duration
	var servingRouteRefreshInterval time.Duration
	var servingRouteSource string
	var qualificationCell string
	var qualificationCellUID string
	var qualificationDatacenter string
	flag.StringVar(&listenAddress, "listen-address", ":8080", "HTTP listen address")
	flag.StringVar(&internalListenAddress, "internal-listen-address", "", "private Object Router listen address; disabled when empty")
	flag.StringVar(&registryURL, "registry-url", "", "private Worker Registry base URL")
	flag.Var(&engineURLs, "engine-url", "private Engine/Guard base URL; repeat for multiple Cells")
	flag.Var(&engineCells, "engine-cell", "Cell name paired with each Engine URL; repeat in the same order")
	flag.Var(&engineCellUIDs, "engine-cell-uid", "immutable Cell UID paired with each Engine URL")
	flag.Var(&enginePoolUIDs, "engine-pool-uid", "immutable ShardPool UID paired with each Engine URL")
	flag.Var(&datacenters, "datacenter", "private datacenter name paired with each Engine URL")
	flag.Var(&engineTokens, "engine-token", "private bearer token paired with each Engine URL; repeat in the same order")
	flag.StringVar(&namespace, "namespace", "default", "private Rivet namespace")
	flag.StringVar(&runnerNameSelector, "runner-name-selector", "workerd", "private workerd runner selector")
	flag.StringVar(&internalToken, "internal-token", "", "private Registry/Engine bearer token")
	flag.Var(&objectRouterTokens, "object-router-token", "private stateless Worker to Object Router capability token; repeat for multiple Cells")
	flag.Var(&statelessExecutorURLs, "stateless-executor-url", "private stateless executor base URL; repeat for multiple executors")
	flag.Var(&statelessExecutorTokens, "stateless-executor-token", "private capability token paired with each stateless executor URL; repeat in the same order")
	flag.Int64Var(&maxRequestBytes, "max-request-bytes", 16<<20, "maximum JSON control request size")
	flag.DurationVar(&requestTimeout, "request-timeout", 60*time.Second, "internal control request timeout")
	flag.DurationVar(&prepareTimeout, "prepare-timeout", 30*time.Second, "inactive Version validation timeout")
	flag.IntVar(&maxConcurrentPrepares, "max-concurrent-prepares", 4, "maximum synchronous inactive Version validations per API process")
	flag.DurationVar(&actorReadyTimeout, "actor-ready-timeout", 3*time.Second, "maximum time for a new Agent to become executable")
	flag.DurationVar(&fetchResponseHeaderTimeout, "fetch-response-header-timeout", 25*time.Second, "maximum wait for Engine to begin a Worker response; response streaming remains unbounded")
	flag.IntVar(&actorCacheCapacity, "actor-cache-capacity", 32_768, "maximum cached Durable Object Actor placements")
	flag.DurationVar(&actorCacheIdleTTL, "actor-cache-idle-ttl", 10*time.Minute, "idle lifetime of a cached Durable Object Actor placement")
	flag.IntVar(&objectMissCapacity, "object-miss-capacity", 4_096, "maximum distinct concurrent Durable Object cache misses")
	flag.IntVar(&deploymentCacheCapacity, "deployment-cache-capacity", 4_096, "maximum cached Worker Deployments, shared Deployment reads, and read waiters")
	flag.StringVar(&placementNamespace, "placement-namespace", "actor-fleet-system", "namespace containing the production ShardPool and RivetCells")
	flag.StringVar(&placementPool, "placement-pool", "", "ShardPool used for new Agent placement")
	flag.StringVar(&placementRouteNamespace, "placement-route-namespace", "workers-api-system", "namespace containing immutable Cell route records")
	flag.DurationVar(&placementMaxReportAge, "placement-max-report-age", 5*time.Minute, "maximum accepted Cell report age")
	flag.DurationVar(&placementRefreshInterval, "placement-refresh-interval", time.Second, "minimum interval between Kubernetes placement snapshot reads")
	flag.DurationVar(&servingRouteRefreshInterval, "serving-route-refresh-interval", time.Second, "minimum interval between Kubernetes serving route snapshot reads")
	flag.StringVar(&servingRouteSource, "serving-route-source", "kubernetes", "serving route source: kubernetes or static")
	flag.StringVar(&qualificationCell, "qualification-cell", "", "qualification-only fixed Cell name; requires UID and datacenter")
	flag.StringVar(&qualificationCellUID, "qualification-cell-uid", "", "qualification-only fixed Cell UID")
	flag.StringVar(&qualificationDatacenter, "qualification-datacenter", "", "qualification-only fixed Engine datacenter")
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)
	shutdownSignal, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	var err error
	var placementResolver workersapi.PlacementResolver
	var servingRouteResolver workersapi.ServingRouteResolver
	qualificationFields := 0
	for _, value := range []string{qualificationCell, qualificationCellUID, qualificationDatacenter} {
		if value != "" {
			qualificationFields++
		}
	}
	if qualificationFields != 0 {
		if qualificationFields != 3 || placementPool != "" || len(engineURLs) != 1 ||
			len(engineCells) != 1 || engineCells[0] != qualificationCell ||
			len(datacenters) != 1 || datacenters[0] != qualificationDatacenter {
			logger.Error("qualification placement requires one exact Engine/Cell/UID/datacenter and no ShardPool")
			os.Exit(2)
		}
		placementResolver, err = workersapi.NewQualificationPlacementResolver(
			qualificationCell, qualificationCellUID, qualificationDatacenter,
		)
		// Qualification runs before the Cell joins a production ShardPool. Bind
		// the serving route to the same explicit Cell UID and the resolver's
		// fixed qualification Pool identity without adding another user-supplied
		// identity that could disagree with the qualification flags.
		if len(engineCellUIDs) == 0 && len(enginePoolUIDs) == 0 {
			engineCellUIDs = append(engineCellUIDs, qualificationCellUID)
			enginePoolUIDs = append(enginePoolUIDs, "qualification")
		}
	} else {
		if servingRouteSource != "kubernetes" && servingRouteSource != "static" {
			logger.Error("serving route source must be kubernetes or static")
			os.Exit(2)
		}
		var kubeConfig *rest.Config
		kubeConfig, err = rest.InClusterConfig()
		if err == nil {
			var dynamicClient dynamic.Interface
			dynamicClient, err = dynamic.NewForConfig(kubeConfig)
			if err == nil {
				var kubeClient kubernetes.Interface
				kubeClient, err = kubernetes.NewForConfig(kubeConfig)
				if err == nil {
					placementResolver, err = workersapi.NewKubernetesPlacementResolver(
						dynamicClient, kubeClient, placementNamespace, placementPool,
						placementRouteNamespace, placementMaxReportAge, placementRefreshInterval,
					)
					if err == nil && servingRouteSource == "kubernetes" {
						servingRouteResolver, err = workersapi.NewKubernetesServingRouteResolver(
							kubeClient, placementRouteNamespace, servingRouteRefreshInterval,
						)
					}
				}
			}
		}
	}
	if err != nil {
		logger.Error("configure Agent placement resolver", "error", err)
		os.Exit(2)
	}
	if internalListenAddress != "" && len(objectRouterTokens) == 0 {
		logger.Error("internal Object Router listener requires an explicit capability token")
		os.Exit(2)
	}
	if internalListenAddress == listenAddress && internalListenAddress != "" {
		logger.Error("public and internal listeners must use different addresses")
		os.Exit(2)
	}
	api, err := workersapi.NewAPI(workersapi.Config{
		RegistryURL:                registryURL,
		EngineURLs:                 engineURLs,
		EngineCells:                engineCells,
		EngineCellUIDs:             engineCellUIDs,
		EnginePoolUIDs:             enginePoolUIDs,
		Datacenters:                datacenters,
		EngineTokens:               engineTokens,
		Namespace:                  namespace,
		RunnerNameSelector:         runnerNameSelector,
		InternalToken:              internalToken,
		ObjectRouterTokens:         objectRouterTokens,
		StatelessExecutorURLs:      statelessExecutorURLs,
		StatelessExecutorTokens:    statelessExecutorTokens,
		MaxRequestBytes:            maxRequestBytes,
		RequestTimeout:             requestTimeout,
		PrepareTimeout:             prepareTimeout,
		MaxConcurrentPrepares:      maxConcurrentPrepares,
		ActorReadyTimeout:          actorReadyTimeout,
		FetchResponseHeaderTimeout: fetchResponseHeaderTimeout,
		ActorCacheCapacity:         actorCacheCapacity,
		ActorCacheIdleTTL:          actorCacheIdleTTL,
		ObjectMissCapacity:         objectMissCapacity,
		DeploymentCacheCapacity:    deploymentCacheCapacity,
		PlacementResolver:          placementResolver,
		ServingRouteResolver:       servingRouteResolver,
	})
	if err != nil {
		logger.Error("configure Workers API", "error", err)
		os.Exit(2)
	}
	defer api.Close()

	server := &http.Server{
		Addr:              listenAddress,
		Handler:           api,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		// Conversational responses may stream for much longer than control
		// operations. Caller cancellation and Agent execution policy own this
		// lifetime; an absolute HTTP write deadline would truncate valid chats.
		WriteTimeout:   0,
		IdleTimeout:    60 * time.Second,
		MaxHeaderBytes: 32 << 10,
	}
	servers := []*http.Server{server}
	if internalListenAddress != "" {
		servers = append(servers, &http.Server{
			Addr:              internalListenAddress,
			Handler:           api.InternalHandler(),
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       30 * time.Second,
			WriteTimeout:      0,
			IdleTimeout:       60 * time.Second,
			MaxHeaderBytes:    32 << 10,
		})
	}
	endpoints, err := bindHTTPServers(servers)
	if err == nil {
		err = runHTTPServers(shutdownSignal, logger, len(engineURLs), endpoints, 10*time.Second)
	}
	if err != nil {
		stop()
		api.Close()
		logger.Error("Workers API listener stopped", "error", err)
		os.Exit(1)
	}
}
