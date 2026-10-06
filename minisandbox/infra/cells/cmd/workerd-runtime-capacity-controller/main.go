package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/rivet-dev/rivet/infra/cells/internal/runtimecapacity"
	"github.com/rivet-dev/rivet/infra/cells/internal/runtimecapacity/admission"
)

func main() {
	if helpRequested(os.Args[1:]) {
		fmt.Println("Usage: workerd-runtime-capacity-controller [--oidc-credential-self-check]")
		return
	}
	selfChecked, err := runOIDCCredentialSelfCheck(os.Args[1:], func() (runtimecapacity.TencentCredentialProvider, error) {
		return runtimecapacity.NewTencentTKEOIDCCredentialProvider()
	})
	if err != nil {
		log.Fatalf("Tencent TKE OIDC credential self-check: %v", err)
	}
	if selfChecked {
		log.Print("Tencent TKE OIDC credential self-check passed")
		return
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	config, err := rest.InClusterConfig()
	if err != nil {
		log.Fatalf("load in-cluster config: %v", err)
	}
	kube, err := kubernetes.NewForConfig(config)
	if err != nil {
		log.Fatalf("create Kubernetes client: %v", err)
	}
	dynamicClient, err := dynamic.NewForConfig(config)
	if err != nil {
		log.Fatalf("create dynamic Kubernetes client: %v", err)
	}
	cell := required("CELL_NAME")
	namespace := required("CELL_NAMESPACE")
	statefulSet := value("RUNTIME_STATEFULSET", cell+"-runtime-hosts")
	machineSet := required("RUNTIME_MACHINESET")
	capacityControllerEnabled := boolean("RUNTIME_CAPACITY_CONTROLLER_ENABLED", true)
	exactScaleDownEnabled := boolean("RUNTIME_EXACT_SCALE_DOWN_ENABLED", false)
	providerClusterID := value("RUNTIME_TKE_CLUSTER_ID", "")
	var exactScaleDown runtimecapacity.ExactScaleDownProvider
	if exactScaleDownEnabled {
		if providerClusterID == "" {
			log.Fatal("RUNTIME_TKE_CLUSTER_ID is required when exact scale-down is enabled")
		}
		credentials, err := runtimecapacity.NewTencentTKEOIDCCredentialProvider()
		if err != nil {
			log.Fatalf("initialize exact scale-down workload identity: %v", err)
		}
		exactScaleDown = &runtimecapacity.TencentExactScaleDownClient{
			Credentials: credentials, Region: value("TENCENTCLOUD_REGION", "ap-beijing"),
			ClusterID: providerClusterID,
		}
	}
	controller := &runtimecapacity.Controller{
		Kubernetes:     kube,
		Dynamic:        dynamicClient,
		ExactScaleDown: exactScaleDown,
		Config: runtimecapacity.ControllerConfig{
			Namespace:              namespace,
			CellName:               cell,
			StatefulSetName:        statefulSet,
			MachineSetName:         machineSet,
			ProviderClusterID:      providerClusterID,
			MinReplicas:            int64(integer("RUNTIME_CAPACITY_MIN_REPLICAS", 3)),
			MaxReplicas:            int64(integer("RUNTIME_CAPACITY_MAX_REPLICAS", 30)),
			MaxRepairSurge:         int64(nonNegativeInteger("RUNTIME_CAPACITY_MAX_REPAIR_SURGE", 1)),
			RequiredZones:          nonNegativeInteger("RUNTIME_CAPACITY_REQUIRED_ZONES", 0),
			TargetedRepairEnabled:  boolean("RUNTIME_CAPACITY_TARGETED_REPAIR_ENABLED", false),
			RuntimeAuthToken:       os.Getenv("RUNTIME_AUTH_TOKEN"),
			ManagementPort:         integer("RUNTIME_MANAGEMENT_PORT", 19083),
			RepairDrainTimeout:     duration("RUNTIME_REPAIR_DRAIN_TIMEOUT", 10*time.Minute),
			ScaleDownStabilization: duration("RUNTIME_CAPACITY_SCALE_DOWN_STABILIZATION", 30*time.Second),
			ReconcileInterval:      duration("RUNTIME_CAPACITY_RECONCILE_INTERVAL", 5*time.Second),
		},
		Now:  time.Now,
		Logf: log.Printf,
	}
	admissionController := &admission.Controller{
		Kubernetes: kube,
		Dynamic:    dynamicClient,
		Config: admission.ControllerConfig{
			Namespace:                namespace,
			CellName:                 cell,
			StatefulSetName:          statefulSet,
			WorkloadKind:             value("RUNTIME_ADMISSION_WORKLOAD_KIND", ""),
			WorkloadName:             value("RUNTIME_ADMISSION_WORKLOAD_NAME", ""),
			WorkloadContainer:        value("RUNTIME_ADMISSION_WORKLOAD_CONTAINER", ""),
			MachineSetName:           machineSet,
			PoolLabelKey:             value("RUNTIME_ADMISSION_POOL_LABEL_KEY", ""),
			PoolTaintKey:             value("RUNTIME_ADMISSION_POOL_TAINT_KEY", ""),
			PoolTaintValue:           value("RUNTIME_ADMISSION_POOL_TAINT_VALUE", ""),
			PendingTaintKey:          value("RUNTIME_ADMISSION_PENDING_TAINT_KEY", ""),
			AdmittedLabel:            value("RUNTIME_ADMISSION_ADMITTED_LABEL", ""),
			PhaseLabel:               value("RUNTIME_ADMISSION_PHASE_LABEL", ""),
			StateAnnotation:          value("RUNTIME_ADMISSION_STATE_ANNOTATION", ""),
			DrainAnnotation:          value("RUNTIME_ADMISSION_DRAIN_ANNOTATION", ""),
			ProfileVersion:           value("RUNTIME_ADMISSION_PROFILE_VERSION", ""),
			ProbeComponent:           value("RUNTIME_ADMISSION_PROBE_COMPONENT", ""),
			BootstrapImage:           value("RUNTIME_ADMISSION_BOOTSTRAP_IMAGE", ""),
			ImagePullSecret:          value("RUNTIME_ADMISSION_IMAGE_PULL_SECRET", "actor-fleet-tcr"),
			InjectedImagePullSecrets: strings.FieldsFunc(os.Getenv("RUNTIME_ADMISSION_INJECTED_IMAGE_PULL_SECRETS"), func(r rune) bool { return r == ',' }),
			ProbeTimeout:             duration("RUNTIME_ADMISSION_PROBE_TIMEOUT", 5*time.Minute),
			RetryBackoff:             duration("RUNTIME_ADMISSION_RETRY_BACKOFF", time.Minute),
			ReconcileInterval:        duration("RUNTIME_ADMISSION_RECONCILE_INTERVAL", 5*time.Second),
			RequiredZones:            nonNegativeInteger("RUNTIME_CAPACITY_REQUIRED_ZONES", 0),
		},
		Now:  time.Now,
		Logf: log.Printf,
	}
	if capacityControllerEnabled {
		go controller.Run(ctx)
	}
	admissionController.Run(ctx)
}

func helpRequested(args []string) bool {
	return len(args) == 1 && (args[0] == "--help" || args[0] == "-h")
}

func runOIDCCredentialSelfCheck(
	args []string,
	providerFactory func() (runtimecapacity.TencentCredentialProvider, error),
) (bool, error) {
	if len(args) == 0 {
		return false, nil
	}
	if len(args) != 1 || args[0] != "--oidc-credential-self-check" {
		return false, fmt.Errorf("unsupported arguments")
	}
	provider, err := providerFactory()
	if err != nil {
		return true, err
	}
	if provider == nil {
		return true, fmt.Errorf("credential provider is unavailable")
	}
	if _, err := provider.GetCredential(); err != nil {
		return true, err
	}
	return true, nil
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

func nonNegativeInteger(name string, fallback int) int {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	result, err := strconv.Atoi(raw)
	if err != nil || result < 0 {
		log.Fatalf("%s must be a non-negative integer", name)
	}
	return result
}

func boolean(name string, fallback bool) bool {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	result, err := strconv.ParseBool(raw)
	if err != nil {
		log.Fatalf("%s must be a boolean", name)
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
