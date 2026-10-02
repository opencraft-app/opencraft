package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/rivet-dev/rivet/infra/cells/internal/cellreporter"
	"github.com/rivet-dev/rivet/infra/cells/internal/hostdrain"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	config, err := rest.InClusterConfig()
	if err != nil {
		log.Fatalf("load in-cluster config: %v", err)
	}
	dynamicClient, err := dynamic.NewForConfig(config)
	if err != nil {
		log.Fatalf("create dynamic client: %v", err)
	}
	coreClient, err := kubernetes.NewForConfig(config)
	if err != nil {
		log.Fatalf("create core client: %v", err)
	}

	interval := durationEnv("REPORT_INTERVAL", 30*time.Second)
	cfg := cellreporter.Config{
		Namespace:                  requiredEnv("CELL_NAMESPACE"),
		CellName:                   requiredEnv("CELL_NAME"),
		BackupName:                 env("BACKUP_NAME", requiredEnv("CELL_NAME")+"-continuous"),
		RuntimeSelector:            env("RUNTIME_SELECTOR", "fleet.actor.dev/cell-name="+requiredEnv("CELL_NAME")+",fleet.actor.dev/component=workerd-host"),
		BackupSelector:             env("BACKUP_SELECTOR", "fleet.actor.dev/cell-name="+requiredEnv("CELL_NAME")+",fleet.actor.dev/purpose=continuous-backup"),
		RuntimeCOSSecret:           env("RUNTIME_COS_SECRET", requiredEnv("CELL_NAME")+"-runtime-cos"),
		RuntimeAuthSecret:          env("RUNTIME_AUTH_SECRET", requiredEnv("CELL_NAME")+"-runtime-auth"),
		FDBTLSSecret:               env("FDB_TLS_SECRET", requiredEnv("CELL_NAME")+"-backup-tls"),
		ReleaseDigest:              os.Getenv("RELEASE_DIGEST"),
		ReleaseLedgerConfigMap:     env("RELEASE_LEDGER_CONFIGMAP", requiredEnv("CELL_NAME")+"-release-ledger"),
		CapacityRisk:               env("CAPACITY_RISK", "AdmissionClosed"),
		QualificationReady:         strings.EqualFold(os.Getenv("QUALIFICATION_READY"), "true"),
		QualificationReceipt:       os.Getenv("QUALIFICATION_RECEIPT"),
		QualificationDigest:        os.Getenv("QUALIFICATION_DIGEST"),
		QualificationReleaseDigest: os.Getenv("QUALIFICATION_RELEASE_DIGEST"),
		Interval:                   interval,
		PrometheusURL:              env("PROMETHEUS_URL", "http://actor-observability-prometheus.observability.svc:9090"),
		WorkerRegistryURL:          requiredEnv("RIVET_WORKER_REGISTRY_URL"),
	}
	metrics := &reporterMetrics{cell: cfg.CellName}
	reporter := &cellreporter.Reporter{
		Dynamic: dynamicClient, Core: coreClient, Config: cfg, Now: time.Now,
		AfterReport: metrics.observe,
	}
	if mode := env("HOST_DRAIN_MODE", "Disabled"); mode == "Automatic" {
		authSecret, err := coreClient.CoreV1().Secrets(cfg.Namespace).Get(
			ctx, cfg.RuntimeAuthSecret, metav1.GetOptions{},
		)
		if err != nil {
			log.Fatalf("read Host drain authentication secret: %v", err)
		}
		token := string(authSecret.Data["token"])
		drainController := &hostdrain.Controller{
			Kubernetes: coreClient,
			Config: hostdrain.ControllerConfig{
				Namespace: cfg.Namespace, CellName: cfg.CellName,
				StatefulSetName: env("HOST_DRAIN_STATEFULSET", cfg.CellName+"-runtime-hosts"),
				HPAName:         env("HOST_DRAIN_HPA", cfg.CellName+"-runtime-hosts-actor-capacity"),
				PodSelector:     cfg.RuntimeSelector, Token: token,
				ManagementPort:         intEnv("HOST_DRAIN_MANAGEMENT_PORT", 19083),
				MinReplicas:            int32(intEnv("HOST_DRAIN_MIN_REPLICAS", 2)),
				MaxRemainingUsagePct:   int64(intEnv("HOST_DRAIN_MAX_REMAINING_USAGE_PERCENT", 70)),
				MetricsFreshness:       durationEnv("HOST_DRAIN_METRICS_FRESHNESS", 45*time.Second),
				ScaleDownStabilization: durationEnv("HOST_DRAIN_STABILIZATION", 5*time.Minute),
				DrainTimeout:           durationEnv("HOST_DRAIN_TIMEOUT", 10*time.Minute),
				ReconcileInterval:      durationEnv("HOST_DRAIN_RECONCILE_INTERVAL", 5*time.Second),
			},
			Now:  time.Now,
			Logf: log.Printf,
		}
		go drainController.Run(ctx)
	} else if mode != "Disabled" {
		log.Fatalf("HOST_DRAIN_MODE must be Disabled or Automatic")
	}
	go serveHealth(ctx, metrics, 2*interval)

	for {
		if err := reporter.ReportOnce(ctx); err != nil {
			log.Printf("report failed: %v", err)
		} else {
			metrics.lastSuccess.Store(time.Now().UnixNano())
			log.Printf("published fresh RivetCellReport for %s/%s", cfg.Namespace, cfg.CellName)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}

type reporterMetrics struct {
	cell        string
	lastSuccess atomic.Int64
	mu          sync.RWMutex
	static      cellreporter.StaticReleaseEvidence
	driftSince  time.Time
}

func (m *reporterMetrics) observe(observation cellreporter.Observation) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.static = observation.StaticRelease
	if observation.StaticRelease.Ready {
		m.driftSince = time.Time{}
	} else if m.driftSince.IsZero() {
		m.driftSince = time.Now()
	}
}

func (m *reporterMetrics) render(now time.Time, maximumAge time.Duration) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	last := m.lastSuccess.Load()
	collectionSuccess := 0
	if last != 0 && now.Sub(time.Unix(0, last)) <= maximumAge {
		collectionSuccess = 1
	}
	converged := 0
	if m.static.Ready {
		converged = 1
	}
	driftAge := 0.0
	if !m.driftSince.IsZero() {
		driftAge = now.Sub(m.driftSince).Seconds()
		if driftAge < 0 {
			driftAge = 0
		}
	}
	cell := metricLabel(m.cell)
	return fmt.Sprintf(
		"# HELP actor_static_release_collection_success Whether the Cell static release auditor produced a fresh sample.\n"+
			"# TYPE actor_static_release_collection_success gauge\n"+
			"actor_static_release_collection_success{cell=\"%s\"} %d\n"+
			"# HELP actor_static_release_converged Whether every release-owned field and running image matches the active ledger.\n"+
			"# TYPE actor_static_release_converged gauge\n"+
			"actor_static_release_converged{cell=\"%s\"} %d\n"+
			"# HELP actor_static_release_drift_findings Number of distinct static release drift findings.\n"+
			"# TYPE actor_static_release_drift_findings gauge\n"+
			"actor_static_release_drift_findings{cell=\"%s\"} %d\n"+
			"# HELP actor_static_release_drift_age_seconds Age of the current continuous static drift interval.\n"+
			"# TYPE actor_static_release_drift_age_seconds gauge\n"+
			"actor_static_release_drift_age_seconds{cell=\"%s\"} %.0f\n",
		cell, collectionSuccess, cell, converged, cell, m.static.DriftCount,
		cell, driftAge,
	)
}

func metricLabel(value string) string {
	value = strings.ReplaceAll(value, "\\", "\\\\")
	value = strings.ReplaceAll(value, "\n", "\\n")
	return strings.ReplaceAll(value, "\"", "\\\"")
}

func serveHealth(ctx context.Context, metrics *reporterMetrics, maximumAge time.Duration) {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		last := metrics.lastSuccess.Load()
		if last == 0 || time.Since(time.Unix(0, last)) > maximumAge {
			http.Error(w, "no recent successful report", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_, _ = w.Write([]byte(metrics.render(time.Now(), maximumAge)))
	})
	server := &http.Server{Addr: ":8081", Handler: mux, ReadHeaderTimeout: 2 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Printf("health server: %v", err)
	}
}

func requiredEnv(name string) string {
	value := os.Getenv(name)
	if value == "" {
		log.Fatalf("%s is required", name)
	}
	return value
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func durationEnv(name string, fallback time.Duration) time.Duration {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil || parsed <= 0 {
		log.Fatalf("%s must be a positive duration: %v", name, err)
	}
	return parsed
}

func intEnv(name string, fallback int) int {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		log.Fatalf("%s must be a positive integer: %v", name, err)
	}
	return parsed
}
