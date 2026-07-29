package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	auto "github.com/pulumi/pulumi/sdk/v3/go/auto"
	"github.com/pulumi/pulumi/sdk/v3/go/auto/optpreview"
	"github.com/pulumi/pulumi/sdk/v3/go/auto/optup"
	"github.com/skipzhang/mono/infra_pulumi/pkg/tencenttke"
)

const defaultStack = "beijing-sandbox"

type reconcileFile struct {
	TKEClusterID string            `json:"tkeClusterId,omitempty"`
	SNATImports  map[string]string `json:"snatImports"`
}

type deploymentState struct {
	Resources []exportResource `json:"resources"`
}

type exportResource struct {
	URN  string `json:"urn"`
	Type string `json:"type"`
	ID   string `json:"id"`
}

type stackSecrets struct {
	NodePassword  string
	DBPassword    string
	RedisPassword string
}

func main() {
	if len(os.Args) < 2 {
		fatalf("usage: infractl <preview|up|sync|reconcile|validate|import|set-secrets> [--stack <name>]")
	}

	projectRoot, err := findProjectRoot()
	if err != nil {
		fatalf("resolve project root: %v", err)
	}
	applyRuntimeDefaults(projectRoot)

	cmd := os.Args[1]
	args := os.Args[2:]

	switch cmd {
	case "preview":
		stack, err := parseStackArg(args)
		if err != nil {
			fatalf("%v", err)
		}
		if err := preview(projectRoot, stack); err != nil {
			fatalf("%v", err)
		}
	case "up":
		stack, err := parseStackArg(args)
		if err != nil {
			fatalf("%v", err)
		}
		if err := up(projectRoot, stack); err != nil {
			fatalf("%v", err)
		}
	case "sync":
		stack, err := parseStackArg(args)
		if err != nil {
			fatalf("%v", err)
		}
		if err := sync(projectRoot, stack); err != nil {
			fatalf("%v", err)
		}
	case "reconcile":
		stack, err := parseStackArg(args)
		if err != nil {
			fatalf("%v", err)
		}
		path, err := writeReconcileFile(projectRoot, stack)
		if err != nil {
			fatalf("%v", err)
		}
		fmt.Println(path)
	case "validate":
		stack, err := parseStackArg(args)
		if err != nil {
			fatalf("%v", err)
		}
		if err := validate(projectRoot, stack); err != nil {
			fatalf("%v", err)
		}
	case "import":
		stack, err := parseStackArg(args)
		if err != nil {
			fatalf("%v", err)
		}
		if err := enableImport(projectRoot, stack); err != nil {
			fatalf("%v", err)
		}
	case "set-secrets":
		stack, err := parseStackArg(args)
		if err != nil {
			fatalf("%v", err)
		}
		if err := setSecrets(projectRoot, stack); err != nil {
			fatalf("%v", err)
		}
	default:
		fatalf("unknown command %q", cmd)
	}
}

func preview(projectRoot, stack string) error {
	ctx := context.Background()
	reconcilePath, err := writeReconcileFile(projectRoot, stack)
	if err != nil {
		return err
	}
	s, err := openStack(ctx, projectRoot, stack, reconcilePath)
	if err != nil {
		return err
	}
	_, err = s.Preview(
		ctx,
		optpreview.ProgressStreams(os.Stdout),
		optpreview.ErrorProgressStreams(os.Stderr),
	)
	return err
}

func up(projectRoot, stack string) error {
	ctx := context.Background()
	reconcilePath, err := writeReconcileFile(projectRoot, stack)
	if err != nil {
		return err
	}
	s, err := openStack(ctx, projectRoot, stack, reconcilePath)
	if err != nil {
		return err
	}
	if _, err := s.Up(
		ctx,
		optup.ProgressStreams(os.Stdout),
		optup.ErrorProgressStreams(os.Stderr),
	); err != nil {
		return err
	}
	if !shouldSyncAfterUp(os.Getenv("INFRA_COMPONENT_SCOPE")) {
		return nil
	}
	return sync(projectRoot, stack)
}

func shouldSyncAfterUp(scope string) bool {
	return strings.TrimSpace(scope) == ""
}

func sync(projectRoot, stack string) error {
	ctx := context.Background()
	s, err := openStack(ctx, projectRoot, stack, "")
	if err != nil {
		return err
	}
	outputMap, err := s.Outputs(ctx)
	if err != nil {
		return err
	}
	outputs := flattenOutputs(outputMap)
	secrets, err := getStackSecrets(ctx, s)
	if err != nil {
		return err
	}

	clusterID := getString(outputs, "tkeClusterId")
	region := getString(outputs, "region")
	if clusterID == "" || region == "" {
		return fmt.Errorf("missing tkeClusterId or region in Pulumi outputs")
	}

	repoRoot := filepath.Dir(projectRoot)
	kubeconfigRel := filepath.Join(".secret", clusterID+"-config")
	kubeconfigAbs := filepath.Join(repoRoot, kubeconfigRel)

	kubeconfig, err := tencenttke.GetClusterKubeconfig(
		os.Getenv("TENCENTCLOUD_SECRET_ID"),
		os.Getenv("TENCENTCLOUD_SECRET_KEY"),
		region,
		clusterID,
		true,
	)
	if err != nil {
		return fmt.Errorf("fetch kubeconfig: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(kubeconfigAbs), 0o755); err != nil {
		return fmt.Errorf("create kubeconfig dir: %w", err)
	}
	if err := os.WriteFile(kubeconfigAbs, []byte(kubeconfig), 0o600); err != nil {
		return fmt.Errorf("write kubeconfig: %w", err)
	}
	if err := os.Chmod(kubeconfigAbs, 0o600); err != nil {
		return fmt.Errorf("chmod kubeconfig: %w", err)
	}

	platformEnvPath := filepath.Join(repoRoot, "deploy", "envs", stack, "platform.env")
	if err := writePlatformEnv(platformEnvPath, outputs, secrets, filepath.ToSlash(kubeconfigRel)); err != nil {
		return err
	}

	fmt.Printf("synced deploy env for %s -> %s\n", stack, platformEnvPath)
	fmt.Printf("wrote kubeconfig -> %s\n", kubeconfigAbs)
	return nil
}

func validate(projectRoot, stack string) error {
	if err := runCommand(projectRoot, nil, "go", "fmt", "./..."); err != nil {
		return err
	}
	if err := runCommand(projectRoot, nil, "go", "build", "./..."); err != nil {
		return err
	}
	return preview(projectRoot, stack)
}

func enableImport(projectRoot, stack string) error {
	ctx := context.Background()
	s, err := openStack(ctx, projectRoot, stack, "")
	if err != nil {
		return err
	}
	if err := s.SetConfig(ctx, "infra-pulumi:enableImport", auto.ConfigValue{Value: "true"}); err != nil {
		return err
	}
	fmt.Printf("Import mode enabled for %s.\n", stack)
	fmt.Printf("Set any required secret import IDs first, then run:\n")
	fmt.Printf("  GOWORK=off go run ./cmd/infractl preview --stack %s\n", stack)
	fmt.Printf("  GOWORK=off go run ./cmd/infractl up --stack %s\n", stack)
	return nil
}

func setSecrets(projectRoot, stack string) error {
	nodePassword := firstEnv("NODE_PASSWORD", "TF_VAR_node_password")
	dbPassword := firstEnv("DB_PASSWORD", "TF_VAR_db_password")
	redisPassword := firstEnv("REDIS_PASSWORD", "TF_VAR_password")
	if nodePassword == "" || dbPassword == "" || redisPassword == "" {
		return fmt.Errorf("NODE_PASSWORD, DB_PASSWORD, and REDIS_PASSWORD are required")
	}
	ctx := context.Background()
	s, err := openStack(ctx, projectRoot, stack, "")
	if err != nil {
		return err
	}
	if err := s.SetConfig(ctx, "infra-pulumi:nodePassword", auto.ConfigValue{Value: nodePassword, Secret: true}); err != nil {
		return err
	}
	if err := s.SetConfig(ctx, "infra-pulumi:dbPassword", auto.ConfigValue{Value: dbPassword, Secret: true}); err != nil {
		return err
	}
	if err := s.SetConfig(ctx, "infra-pulumi:redisPassword", auto.ConfigValue{Value: redisPassword, Secret: true}); err != nil {
		return err
	}
	if err := s.SetConfig(ctx, "infra-pulumi:registryPullServer", auto.ConfigValue{Value: "ccr.ccs.tencentyun.com"}); err != nil {
		return err
	}

	fmt.Printf("Updated Pulumi secret config for stack %s\n", stack)
	return nil
}

func getStackSecrets(ctx context.Context, s auto.Stack) (stackSecrets, error) {
	nodePassword, err := getPulumiConfigValue(ctx, s, "infra-pulumi:nodePassword")
	if err != nil {
		return stackSecrets{}, fmt.Errorf("read node password from Pulumi config: %w", err)
	}
	dbPassword, err := getPulumiConfigValue(ctx, s, "infra-pulumi:dbPassword")
	if err != nil {
		return stackSecrets{}, fmt.Errorf("read db password from Pulumi config: %w", err)
	}
	redisPassword, err := getPulumiConfigValue(ctx, s, "infra-pulumi:redisPassword")
	if err != nil {
		return stackSecrets{}, fmt.Errorf("read redis password from Pulumi config: %w", err)
	}
	return stackSecrets{
		NodePassword:  nodePassword,
		DBPassword:    dbPassword,
		RedisPassword: redisPassword,
	}, nil
}

func getPulumiConfigValue(ctx context.Context, s auto.Stack, key string) (string, error) {
	value, err := s.GetConfig(ctx, key)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(value.Value), nil
}

func ensurePulumiStateDir(projectRoot string) error {
	if err := os.MkdirAll(filepath.Join(projectRoot, ".pulumi-state"), 0o755); err != nil {
		return fmt.Errorf("create pulumi state dir: %w", err)
	}
	return nil
}

func writeReconcileFile(projectRoot, stack string) (string, error) {
	if err := os.MkdirAll(filepath.Join(projectRoot, ".reconcile"), 0o755); err != nil {
		return "", fmt.Errorf("create reconcile dir: %w", err)
	}

	reconcilePath := filepath.Join(projectRoot, ".reconcile", stack+".json")
	ctx := context.Background()
	s, err := openStack(ctx, projectRoot, stack, "")
	if err != nil {
		return "", err
	}
	exported, err := s.Export(ctx)
	if err != nil {
		data, _ := json.MarshalIndent(reconcileFile{SNATImports: map[string]string{}}, "", "  ")
		if writeErr := os.WriteFile(reconcilePath, append(data, '\n'), 0o644); writeErr != nil {
			return "", writeErr
		}
		return reconcilePath, nil
	}
	var deployment deploymentState
	if len(exported.Deployment) > 0 {
		if err := json.Unmarshal(exported.Deployment, &deployment); err != nil {
			return "", fmt.Errorf("parse stack export deployment: %w", err)
		}
	}

	reconcile := reconcileFile{SNATImports: map[string]string{}}
	for _, resource := range deployment.Resources {
		if resource.Type == "tencentcloud:Kubernetes/cluster:Cluster" && strings.HasSuffix(resource.URN, "::lc-tke-cluster") {
			reconcile.TKEClusterID = resource.ID
			break
		}
	}

	data, err := json.MarshalIndent(reconcile, "", "  ")
	if err != nil {
		return "", fmt.Errorf("marshal reconcile file: %w", err)
	}
	if err := os.WriteFile(reconcilePath, append(data, '\n'), 0o644); err != nil {
		return "", fmt.Errorf("write reconcile file: %w", err)
	}
	return reconcilePath, nil
}

func writePlatformEnv(path string, outputs map[string]any, secrets stackSecrets, kubeconfigRel string) error {
	requiredOutputs := []string{
		"environmentName",
		"envShort",
		"region",
		"registryPublicDomain",
		"vpcCidr",
		"tkeClusterId",
		"tkeClusterName",
		"tkeNodePoolId",
		"tkeNodePoolName",
		"vpcId",
		"supportSubnetId",
		"sandboxSecurityGroupId",
		"sandboxRouteRedisHost",
		"sandboxRouteRedisPort",
		"sandboxRouteRedisAddr",
		"ctlMqRedisHost",
		"ctlMqRedisPort",
		"ctlMqRedisAddr",
		"cynosdbPrimaryHost",
		"cynosdbPrimaryPort",
		"cynosdbPrimaryAddr",
	}
	for _, key := range requiredOutputs {
		if strings.TrimSpace(getString(outputs, key)) == "" {
			return fmt.Errorf("missing %s in Pulumi outputs", key)
		}
	}

	subnetIDs := getObject(outputs, "networkSubnetIds")
	subnetZones := getObject(outputs, "networkSubnetZones")
	subnetCIDRs := getObject(outputs, "networkSubnetCidrs")
	requiredSubnetKeys := []string{"support", "pool-a", "pool-b", "pool-c", "pool-d", "pool-e", "pool-f"}
	for _, key := range requiredSubnetKeys {
		if getObjectString(subnetIDs, key) == "" || getObjectString(subnetZones, key) == "" || getObjectString(subnetCIDRs, key) == "" {
			return fmt.Errorf("missing subnet output for %s", key)
		}
	}

	legacyPoolAliases := map[string]string{
		"support": "BJ8",
		"pool-a":  "C0",
		"pool-b":  "C1",
		"pool-c":  "C2",
		"pool-d":  "C3",
		"pool-e":  "C4",
		"pool-f":  "C5",
	}

	lines := []string{
		"# Generated by go run ./cmd/infractl sync. Do not edit by hand.",
		"# Sensitive file: contains runtime passwords for deploy workflows.",
		fmt.Sprintf("PULUMI_ENV_NAME=%s", shellQuote(getString(outputs, "environmentName"))),
		fmt.Sprintf("INFRA_ENV_SHORT=%s", shellQuote(getString(outputs, "envShort"))),
		fmt.Sprintf("DEPLOY_KUBECONFIG=%s", shellQuote(kubeconfigRel)),
		"DEPLOY_SANDBOX_TEST_SECRET_ENV=.secret/sandbox/test.env",
		"DEPLOY_CTL_TEST_SECRET_ENV=.secret/ctl/test.env",
		"",
		fmt.Sprintf("NODE_PASSWORD=%s", shellQuote(secrets.NodePassword)),
		fmt.Sprintf("DB_PASSWORD=%s", shellQuote(secrets.DBPassword)),
		fmt.Sprintf("REDIS_PASSWORD=%s", shellQuote(secrets.RedisPassword)),
		fmt.Sprintf("MYSQL_PASSWORD=%s", shellQuote(secrets.DBPassword)),
		fmt.Sprintf("CTL_TEST_MYSQL_PASSWORD=%s", shellQuote(secrets.DBPassword)),
		fmt.Sprintf("CTL_TEST_DB_PASSWORD_ENC=%s", shellQuote(encryptCTLString(secrets.DBPassword))),
		fmt.Sprintf("CTL_TEST_REDIS_PASSWORD_ENC=%s", shellQuote(encryptCTLString(secrets.RedisPassword))),
		fmt.Sprintf("SANDBOX_MYSQL_PASSWORD=%s", shellQuote(secrets.DBPassword)),
		fmt.Sprintf("SANDBOX_REDIS_PASSWORD=%s", shellQuote(secrets.RedisPassword)),
		"",
		fmt.Sprintf("TENCENT_REGION=%s", shellQuote(getString(outputs, "region"))),
		fmt.Sprintf("REGISTRY_SERVER=%s", shellQuote(getString(outputs, "registryPublicDomain"))),
		fmt.Sprintf("DOMAIN_PUBLIC_API=%s", shellQuote(getString(outputs, "domainPublicAPI"))),
		fmt.Sprintf("DOMAIN_ADMIN=%s", shellQuote(getString(outputs, "domainAdmin"))),
		fmt.Sprintf("DOMAIN_FRONTEND_STATIC=%s", shellQuote(getString(outputs, "domainFrontendStatic"))),
		fmt.Sprintf("AI_GATEWAY_MODEL_INTERNAL_LB_ID=%s", shellQuote(getString(outputs, "aiGatewayModelInternalLbId"))),
		fmt.Sprintf("AI_GATEWAY_MODEL_INTERNAL_VIP=%s", shellQuote(getString(outputs, "aiGatewayModelInternalVip"))),
		fmt.Sprintf("AI_GATEWAY_MODEL_INTERNAL_BASE_URL=%s", shellQuote(getString(outputs, "aiGatewayModelInternalBaseUrl"))),
		fmt.Sprintf("SERVICE_GATEWAY_CLS_TOPIC_ID=%s", shellQuote(getString(outputs, "serviceGatewayCLSTopicId"))),
		fmt.Sprintf("SERVICE_GATEWAY_CLS_LOGSET_ID=%s", shellQuote(getString(outputs, "serviceGatewayCLSLogsetId"))),
		fmt.Sprintf("CTL_CLS_TOPIC_ID=%s", shellQuote(getString(outputs, "ctlRuntimeCLSTopicId"))),
		fmt.Sprintf("SANDBOX_CLS_TOPIC_ID=%s", shellQuote(getString(outputs, "sandboxRuntimeCLSTopicId"))),
		"",
		fmt.Sprintf("TKE_CLUSTER_ID=%s", shellQuote(getString(outputs, "tkeClusterId"))),
		fmt.Sprintf("TKE_CLUSTER_NAME=%s", shellQuote(getString(outputs, "tkeClusterName"))),
		fmt.Sprintf("TKE_NODE_POOL_ID=%s", shellQuote(getString(outputs, "tkeNodePoolId"))),
		fmt.Sprintf("TKE_NODE_POOL_NAME=%s", shellQuote(getString(outputs, "tkeNodePoolName"))),
		"",
		fmt.Sprintf("NETWORK_VPC_ID=%s", shellQuote(getString(outputs, "vpcId"))),
		fmt.Sprintf("NETWORK_VPC_CIDR=%s", shellQuote(getString(outputs, "vpcCidr"))),
		fmt.Sprintf("NETWORK_SUPPORT_SUBNET_ID=%s", shellQuote(getString(outputs, "supportSubnetId"))),
		fmt.Sprintf("NETWORK_SUPPORT_SUBNET_ZONE=%s", shellQuote(getObjectString(subnetZones, "support"))),
	}

	for _, key := range requiredSubnetKeys {
		envKey := strings.ToUpper(strings.ReplaceAll(key, "-", "_"))
		lines = append(lines,
			fmt.Sprintf("NETWORK_SUBNET_%s_ID=%s", envKey, shellQuote(getObjectString(subnetIDs, key))),
			fmt.Sprintf("NETWORK_SUBNET_%s_ZONE=%s", envKey, shellQuote(getObjectString(subnetZones, key))),
			fmt.Sprintf("NETWORK_SUBNET_%s_CIDR=%s", envKey, shellQuote(getObjectString(subnetCIDRs, key))),
		)
	}

	lines = append(lines,
		"",
		"SANDBOX_NAMESPACE=sandbox",
		fmt.Sprintf("SANDBOX_NODE_POOL=%s", shellQuote(getString(outputs, "tkeNodePoolName"))),
		fmt.Sprintf("SANDBOX_REDIS_HOST=%s", shellQuote(getString(outputs, "sandboxRouteRedisHost"))),
		fmt.Sprintf("SANDBOX_REDIS_PORT=%s", shellQuote(getString(outputs, "sandboxRouteRedisPort"))),
		fmt.Sprintf("SANDBOX_REDIS_ADDR=%s", shellQuote(getString(outputs, "sandboxRouteRedisAddr"))),
		fmt.Sprintf("SANDBOX_MYSQL_HOST=%s", shellQuote(getString(outputs, "cynosdbPrimaryHost"))),
		fmt.Sprintf("SANDBOX_MYSQL_PORT=%s", shellQuote(getString(outputs, "cynosdbPrimaryPort"))),
		fmt.Sprintf("SANDBOX_MYSQL_ADDR=%s", shellQuote(getString(outputs, "cynosdbPrimaryAddr"))),
		fmt.Sprintf("SANDBOX_SECURITY_GROUP_ID=%s", shellQuote(getString(outputs, "sandboxSecurityGroupId"))),
		fmt.Sprintf("SANDBOX_VPC_ID=%s", shellQuote(getString(outputs, "vpcId"))),
		fmt.Sprintf("SANDBOX_SUPPORT_SUBNET_ID=%s", shellQuote(getString(outputs, "supportSubnetId"))),
	)
	for _, key := range requiredSubnetKeys {
		alias := legacyPoolAliases[key]
		lines = append(lines,
			fmt.Sprintf("SANDBOX_POOL_%s_SUBNET_ID=%s", alias, shellQuote(getObjectString(subnetIDs, key))),
			fmt.Sprintf("SANDBOX_POOL_%s_ZONE=%s", alias, shellQuote(getObjectString(subnetZones, key))),
		)
	}

	lines = append(lines,
		"",
		"CTL_NAMESPACE=ctl",
		fmt.Sprintf("CTL_NODE_POOL=%s", shellQuote(getString(outputs, "tkeNodePoolName"))),
		fmt.Sprintf("CTL_INTERNAL_SUBNET_ID=%s", shellQuote(getString(outputs, "supportSubnetId"))),
		fmt.Sprintf("CTL_MQ_REDIS_HOST=%s", shellQuote(getString(outputs, "ctlMqRedisHost"))),
		fmt.Sprintf("CTL_MQ_REDIS_PORT=%s", shellQuote(getString(outputs, "ctlMqRedisPort"))),
		fmt.Sprintf("CTL_MQ_REDIS_ADDR=%s", shellQuote(getString(outputs, "ctlMqRedisAddr"))),
		"",
	)

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create deploy env dir: %w", err)
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o600); err != nil {
		return fmt.Errorf("write platform env: %w", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return fmt.Errorf("chmod platform env: %w", err)
	}
	return nil
}

func runCommand(projectRoot string, env map[string]string, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Dir = projectRoot
	cmd.Env = os.Environ()
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func openStack(ctx context.Context, projectRoot, stackName, reconcilePath string) (auto.Stack, error) {
	if err := ensurePulumiStateDir(projectRoot); err != nil {
		return auto.Stack{}, err
	}
	env := currentEnvMap()
	if reconcilePath != "" {
		env["PULUMI_RECONCILE_FILE"] = reconcilePath
	} else {
		delete(env, "PULUMI_RECONCILE_FILE")
	}
	return auto.UpsertStackLocalSource(
		ctx,
		stackName,
		projectRoot,
		auto.WorkDir(projectRoot),
		auto.EnvVars(env),
	)
}

func currentEnvMap() map[string]string {
	env := map[string]string{}
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || key == "" {
			continue
		}
		env[key] = value
	}
	return env
}

func flattenOutputs(values auto.OutputMap) map[string]any {
	out := make(map[string]any, len(values))
	for key, value := range values {
		out[key] = value.Value
	}
	return out
}

func parseStackArg(args []string) (string, error) {
	stack := defaultStack
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--stack", "-s":
			if i+1 >= len(args) {
				return "", fmt.Errorf("missing value for %s", args[i])
			}
			stack = args[i+1]
			i++
		default:
			if strings.HasPrefix(args[i], "-") {
				return "", fmt.Errorf("unknown flag %s", args[i])
			}
			stack = args[i]
		}
	}
	return stack, nil
}

func findProjectRoot() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	root := wd
	for {
		if _, err := os.Stat(filepath.Join(root, "Pulumi.yaml")); err == nil {
			return root, nil
		}
		parent := filepath.Dir(root)
		if parent == root {
			return "", fmt.Errorf("could not find Pulumi.yaml from %s", wd)
		}
		root = parent
	}
}

func applyRuntimeDefaults(projectRoot string) {
	if os.Getenv("GOWORK") == "" {
		_ = os.Setenv("GOWORK", "off")
	}
	loadRepoLocalEnv(projectRoot)
	if os.Getenv("PULUMI_BACKEND_URL") == "" {
		_ = os.Setenv("PULUMI_BACKEND_URL", "file://"+filepath.Join(projectRoot, ".pulumi-state"))
	}
	if os.Getenv("PULUMI_CONFIG_PASSPHRASE") == "" {
		_ = os.Setenv("PULUMI_CONFIG_PASSPHRASE", "local-dev-passphrase")
	}
	home, err := os.UserHomeDir()
	if err == nil {
		pulumiBin := filepath.Join(home, ".pulumi", "bin")
		pathValue := os.Getenv("PATH")
		if !strings.Contains(pathValue, pulumiBin) {
			_ = os.Setenv("PATH", pulumiBin+string(os.PathListSeparator)+pathValue)
		}
	}
}

func loadRepoLocalEnv(projectRoot string) {
	repoRoot := filepath.Dir(projectRoot)
	data, err := os.ReadFile(filepath.Join(repoRoot, "secrets.local.sh"))
	if err != nil {
		return
	}

	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		if key == "" || os.Getenv(key) != "" {
			continue
		}
		value = strings.TrimSpace(value)
		value = strings.Trim(value, `"'`)
		_ = os.Setenv(key, value)
	}
}

func getString(values map[string]any, key string) string {
	value, ok := values[key]
	if !ok || value == nil {
		return ""
	}
	return stringify(value)
}

func getObject(values map[string]any, key string) map[string]any {
	value, ok := values[key]
	if !ok || value == nil {
		return map[string]any{}
	}
	out, ok := value.(map[string]any)
	if !ok {
		return map[string]any{}
	}
	return out
}

func getObjectString(values map[string]any, key string) string {
	value, ok := values[key]
	if !ok || value == nil {
		return ""
	}
	return stringify(value)
}

func stringify(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case float64:
		if v == float64(int64(v)) {
			return strconv.FormatInt(int64(v), 10)
		}
		return strconv.FormatFloat(v, 'f', -1, 64)
	case json.Number:
		return v.String()
	case bool:
		if v {
			return "true"
		}
		return "false"
	default:
		return fmt.Sprint(v)
	}
}

func firstEnv(keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

func encryptCTLString(value string) string {
	cipherKey := md5String([]byte("lighthouse"))
	cipherIV := md5String([]byte("lightglobal"))[:aes.BlockSize]
	encrypted := aesEncrypt([]byte(value), []byte(cipherKey), []byte(cipherIV))
	return base64.StdEncoding.EncodeToString(encrypted)
}

func md5String(data []byte) string {
	sum := md5.Sum(data)
	return hex.EncodeToString(sum[:])
}

func aesEncrypt(plaintext, key, iv []byte) []byte {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil
	}
	padding := aes.BlockSize - len(plaintext)%aes.BlockSize
	padded := make([]byte, len(plaintext)+padding)
	copy(padded, plaintext)
	for i := len(plaintext); i < len(padded); i++ {
		padded[i] = byte(padding)
	}
	ciphertext := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(ciphertext, padded)
	return ciphertext
}

func shellQuote(value string) string {
	return value
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
