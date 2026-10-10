package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rivet-dev/rivet/infra/cells/internal/workerregistry"
)

func main() {
	var listenAddress string
	var backend string
	var dataDirectory string
	var maxRequestBytes int64
	var maxCompatibilityDate string
	var fdbClusterFile string
	var fdbConnectionString string
	var fdbKeyPrefix string
	var cosBucketURL string
	var cosObjectPrefix string
	var versionRetention int
	flag.StringVar(&listenAddress, "listen-address", ":8080", "HTTP listen address")
	flag.StringVar(&backend, "backend", "filesystem", "storage backend: filesystem or fdb-cos")
	flag.StringVar(&dataDirectory, "data-dir", "/data", "durable Worker registry data directory")
	flag.Int64Var(&maxRequestBytes, "max-request-bytes", workerregistry.DefaultMaxRequestBytes, "maximum Worker upload request size")
	flag.StringVar(&maxCompatibilityDate, "max-compatibility-date", "", "maximum compatibility date supported by the deployed workerd release")
	flag.StringVar(&fdbClusterFile, "fdb-cluster-file", "", "FoundationDB cluster file (empty uses the FDB default)")
	flag.StringVar(&fdbConnectionString, "fdb-connection-string", "", "FoundationDB connection string")
	flag.StringVar(&fdbKeyPrefix, "fdb-key-prefix", "worker-registry", "logical key prefix inside FoundationDB")
	flag.StringVar(&cosBucketURL, "cos-bucket-url", "", "Tencent COS bucket URL")
	flag.StringVar(&cosObjectPrefix, "cos-object-prefix", "worker-registry/v5", "COS object key prefix")
	flag.IntVar(&versionRetention, "version-retention", workerregistry.DefaultVersionRetention, "number of newest Worker versions eligible for deployment and rollback")
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)
	if maxCompatibilityDate != "" {
		if parsed, err := time.Parse("2006-01-02", maxCompatibilityDate); err != nil || parsed.Format("2006-01-02") != maxCompatibilityDate {
			logger.Error("invalid maximum compatibility date", "value", maxCompatibilityDate)
			os.Exit(2)
		}
	}
	store, err := makeStore(backendConfig{
		backend:             backend,
		dataDirectory:       dataDirectory,
		fdbClusterFile:      fdbClusterFile,
		fdbConnectionString: fdbConnectionString,
		fdbKeyPrefix:        fdbKeyPrefix,
		cosBucketURL:        cosBucketURL,
		cosObjectPrefix:     cosObjectPrefix,
		versionRetention:    versionRetention,
	})
	if err != nil {
		logger.Error("initialize Worker registry", "error", err)
		os.Exit(1)
	}

	server := &http.Server{
		Addr:              listenAddress,
		Handler:           workerregistry.NewAPIWithMaxCompatibilityDate(store, maxRequestBytes, maxCompatibilityDate),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	shutdownSignal, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-shutdownSignal.Done()
		shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownContext); err != nil {
			logger.Error("shut down Worker registry", "error", err)
		}
	}()

	logger.Info("starting Worker registry", "listenAddress", listenAddress, "backend", backend, "maxCompatibilityDate", maxCompatibilityDate, "versionRetention", versionRetention)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Error("Worker registry stopped", "error", err)
		os.Exit(1)
	}
}

type backendConfig struct {
	backend             string
	dataDirectory       string
	fdbClusterFile      string
	fdbConnectionString string
	fdbKeyPrefix        string
	cosBucketURL        string
	cosObjectPrefix     string
	versionRetention    int
}

func makeStore(config backendConfig) (workerregistry.RegistryStore, error) {
	switch config.backend {
	case "filesystem":
		return workerregistry.NewStoreWithRetention(config.dataDirectory, config.versionRetention)
	case "fdb-cos":
		if config.cosBucketURL == "" {
			return nil, fmt.Errorf("--cos-bucket-url is required for fdb-cos backend")
		}
		metadata, err := newFDBMetadataStore(config)
		if err != nil {
			return nil, err
		}
		objects, err := workerregistry.NewCOSObjectStore(workerregistry.COSConfig{
			BucketURL:       config.cosBucketURL,
			SecretID:        os.Getenv("TENCENTCLOUD_SECRET_ID"),
			SecretKey:       os.Getenv("TENCENTCLOUD_SECRET_KEY"),
			SessionToken:    os.Getenv("TENCENTCLOUD_SESSION_TOKEN"),
			CredentialsFile: os.Getenv("ACTOR_CODE_STORAGE_SESSION_FILE"),
		})
		if err != nil {
			return nil, err
		}
		return workerregistry.NewDurableStoreWithRetention(metadata, objects, config.cosObjectPrefix, config.versionRetention)
	default:
		return nil, fmt.Errorf("unsupported Worker registry backend %q", config.backend)
	}
}
