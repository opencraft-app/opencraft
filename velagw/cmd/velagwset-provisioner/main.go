package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	velagwv1alpha1 "git.woa.com/wisp/mono2/llmgateway/internal/velagwset/api/v1alpha1"
	"git.woa.com/wisp/mono2/llmgateway/internal/velagwset/provisioner"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	namespace := envOr("POD_NAMESPACE", "llmgateway")
	controlURL := os.Getenv("LLMGATEWAY_CONTROL_URL")
	internalToken := os.Getenv("INTERNAL_SERVICE_TOKEN")
	fleet := envOr("LLMGATEWAY_FLEET", "prod")
	owner := envOr("POD_NAME", fmt.Sprintf("velagwset-provisioner-%d", os.Getpid()))
	bootstrapImage := os.Getenv("LLMGATEWAY_IMAGE")
	if controlURL == "" || internalToken == "" || bootstrapImage == "" {
		log.Fatal("LLMGATEWAY_CONTROL_URL, INTERNAL_SERVICE_TOKEN, and LLMGATEWAY_IMAGE are required")
	}

	scheme := clientgoscheme.Scheme
	if err := velagwv1alpha1.AddToScheme(scheme); err != nil {
		log.Fatalf("register VelaGWSet API: %v", err)
	}
	kubeClient, err := client.New(ctrl.GetConfigOrDie(), client.Options{Scheme: scheme})
	if err != nil {
		log.Fatalf("create Kubernetes client: %v", err)
	}
	httpClient := &http.Client{Timeout: 30 * time.Second}
	control := provisioner.NewHTTPControlClient(controlURL, internalToken, httpClient)
	reconciler := &provisioner.Reconciler{
		Client: kubeClient, Scheme: scheme, Control: control, BootstrapImage: bootstrapImage,
		ImagePullSecret:   os.Getenv("LLMGATEWAY_VELAGWSET_IMAGE_PULL_SECRET"),
		ServerlessTraffic: boolEnv("LLMGATEWAY_VELAGWSET_SERVERLESS_TRAFFIC", false),
	}
	runner := provisioner.Runner{
		Control: control, Reconciler: reconciler, Source: envOr("LLMGATEWAY_SET_SOURCE", "kro"),
		Namespace: namespace, Fleet: fleet, Owner: owner,
		LeaseTTL: durationEnv("LLMGATEWAY_VELAGWSET_PROVISION_LEASE", time.Minute),
		Limit:    intEnv("LLMGATEWAY_VELAGWSET_PROVISION_LIMIT", 50),
	}
	interval := durationEnv("LLMGATEWAY_VELAGWSET_PROVISION_INTERVAL", 5*time.Second)
	for {
		if err := runner.RunOnce(ctx); err != nil && ctx.Err() == nil {
			log.Printf("velagwset provision cycle: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func durationEnv(key string, fallback time.Duration) time.Duration {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil || parsed <= 0 {
		log.Fatalf("invalid %s=%q", key, value)
	}
	return parsed
}

func intEnv(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		log.Fatalf("invalid %s=%q", key, value)
	}
	return parsed
}

func boolEnv(key string, fallback bool) bool {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		log.Fatalf("invalid %s=%q", key, value)
	}
	return parsed
}
