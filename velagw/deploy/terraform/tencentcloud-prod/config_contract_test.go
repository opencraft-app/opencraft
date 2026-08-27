package terraformprod

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestRegionalVariablesRequireExplicitValues(t *testing.T) {
	t.Parallel()

	raw := mustReadFile(t, "variables.tf")
	for _, name := range []string{
		"region",
		"region_alias",
		"availability_zones",
		"control_dns_subdomain",
		"traffic_dns_subdomain",
		"control_clb_domain",
		"traffic_clb_domain",
		"control_cert_id",
		"traffic_cert_id",
		"tcr_instance_id",
		"tcr_public_domain",
	} {
		block := terraformVariableBlock(t, raw, name)
		if regexp.MustCompile(`(?m)^\s*default\s*=`).MatchString(block) {
			t.Errorf("variable %q must not have a production default", name)
		}
	}
}

func TestTerraformGuardsRegionalConsistency(t *testing.T) {
	t.Parallel()

	variables := mustReadFile(t, "variables.tf")
	locals := mustReadFile(t, "locals.tf")
	network := mustReadFile(t, "network.tf")
	edgeDNS := mustReadFile(t, "edge_dns.tf")
	tke := mustReadFile(t, "tke.tf")

	if strings.Contains(locals, `environment}-bj`) {
		t.Fatal("resource name prefix must not hard-code Beijing alias")
	}
	if !strings.Contains(locals, "var.region_alias") {
		t.Fatal("resource name prefix must include explicit region_alias")
	}
	if !strings.Contains(network, `startswith(zone, "${var.region}-")`) {
		t.Fatal("network precondition must reject zones outside the selected region")
	}
	if !strings.Contains(edgeDNS, "var.control_dns_subdomain != var.traffic_dns_subdomain") {
		t.Fatal("DNS precondition must reject identical control and traffic subdomains")
	}
	if strings.Contains(tke, `cluster_desc               = "LLMGateway production TKE cluster in Beijing."`) ||
		!strings.Contains(tke, "var.tke_cluster_description") || !strings.Contains(tke, "var.region") {
		t.Fatal("TKE metadata must describe the selected region")
	}
	for _, name := range []string{"region", "region_alias", "control_dns_subdomain", "traffic_dns_subdomain", "control_clb_domain", "traffic_clb_domain", "control_cert_id", "traffic_cert_id", "tcr_instance_id", "tcr_public_domain"} {
		block := terraformVariableBlock(t, variables, name)
		if !strings.Contains(block, "validation {") {
			t.Errorf("variable %q must reject empty or malformed values", name)
		}
	}
}

func TestRegionalExamplesAreIndependent(t *testing.T) {
	t.Parallel()

	examples := []regionalExample{
		parseRegionalExample(t, filepath.Join("environments", "beijing.tfvars.example")),
		parseRegionalExample(t, filepath.Join("environments", "shanghai.tfvars.example")),
		parseRegionalExample(t, filepath.Join("environments", "johorbahru-sgprod.tfvars.example")),
	}
	regions := map[string]struct{}{}
	controlSubdomains := map[string]struct{}{}
	trafficSubdomains := map[string]struct{}{}
	for _, example := range examples {
		assertRegionalExample(t, example)
		if _, exists := regions[example.region]; exists {
			t.Errorf("regional examples share region %q", example.region)
		}
		if _, exists := controlSubdomains[example.controlSubdomain]; exists {
			t.Errorf("regional examples share control subdomain %q", example.controlSubdomain)
		}
		if _, exists := trafficSubdomains[example.trafficSubdomain]; exists {
			t.Errorf("regional examples share traffic subdomain %q", example.trafficSubdomain)
		}
		regions[example.region] = struct{}{}
		controlSubdomains[example.controlSubdomain] = struct{}{}
		trafficSubdomains[example.trafficSubdomain] = struct{}{}
	}
}

func TestRegionalBackendsUseIndependentState(t *testing.T) {
	t.Parallel()

	beijing := parseBackendExample(t, filepath.Join("backend", "beijing.hcl.example"))
	backends := []backendExample{
		beijing,
		parseBackendExample(t, filepath.Join("backend", "shanghai.hcl.example")),
		parseBackendExample(t, filepath.Join("backend", "johorbahru-sgprod.hcl.example")),
	}
	prefixes := map[string]struct{}{}
	for _, backend := range backends {
		if backend.region == "" {
			t.Error("backend region must identify the COS bucket location")
		}
		if _, exists := prefixes[backend.prefix]; exists {
			t.Errorf("regional backends share state prefix %q", backend.prefix)
		}
		prefixes[backend.prefix] = struct{}{}
	}
	if beijing.prefix != "llmgateway/prod" {
		t.Fatalf("Beijing must preserve the existing production state prefix, got %q", beijing.prefix)
	}
}

func TestJohorBahruUsesStandardNodePoolsAndSingaporeRegistry(t *testing.T) {
	t.Parallel()

	variables := mustReadFile(t, "variables.tf")
	tke := mustReadFile(t, "tke.tf")
	tcr := mustReadFile(t, "tcr.tf")
	johor := mustReadFile(t, filepath.Join("environments", "johorbahru-sgprod.tfvars.example"))

	if !strings.Contains(terraformVariableBlock(t, variables, "tke_node_pool_type"), `default     = "serverless"`) {
		t.Fatal("existing regions must retain serverless as the default node pool type")
	}
	if !strings.Contains(tke, `resource "tencentcloud_kubernetes_node_pool" "standard"`) {
		t.Fatal("standard CVM node pools must be managed explicitly")
	}
	if !strings.Contains(tke, `for_each = var.tke_node_pool_type == "standard"`) {
		t.Fatal("standard node pools must only be created for standard-mode regions")
	}
	if !strings.Contains(tke, `"topology.kubernetes.io/zone" = each.value.zone`) {
		t.Fatal("each standard node pool must expose its availability zone")
	}
	for _, expected := range []string{
		`(?m)^\s*region\s*=\s*"ap-johorbahru"\s*$`,
		`(?m)^\s*availability_zones\s*=\s*\["ap-johorbahru-1",\s*"ap-johorbahru-2"\]\s*$`,
		`(?m)^\s*tke_node_pool_type\s*=\s*"standard"\s*$`,
		`(?m)^\s*tke_internet_endpoint_enabled\s*=\s*true\s*$`,
		`(?m)^\s*tke_internet_endpoint_domain\s*=\s*"k8s-jhb\.lightvela\.com"\s*$`,
		`(?m)^\s*control_dns_subdomain\s*=\s*"token-admin"\s*$`,
		`(?m)^\s*traffic_dns_subdomain\s*=\s*"token"\s*$`,
		`(?m)^\s*control_clb_domain\s*=\s*"lb-l28uw79t-rmcbp2j0x5lnhtyv\.clb\.jb-tencentclb\.com\."\s*$`,
		`(?m)^\s*traffic_clb_domain\s*=\s*"lb-7worxaih-te8dr61mj4ug3i07\.clb\.jb-tencentclb\.com\."\s*$`,
		`(?m)^\s*egress_gateway_mode\s*=\s*"nat_instance"\s*$`,
		`(?m)^\s*nat_instance_image_id\s*=\s*"img-mmytdhbn"\s*$`,
		`(?m)^\s*nat_instance_type\s*=\s*"SA9\.MEDIUM2"\s*$`,
		`(?m)^\s*instance_type\s*=\s*"SA9\.LARGE8"\s*$`,
		`(?m)^\s*backup_instance_types\s*=\s*\["SA5\.LARGE8"\]\s*$`,
		`(?m)^\s*public_ip_assigned\s*=\s*false\s*$`,
		`(?m)^\s*internet_max_bandwidth_out\s*=\s*0\s*$`,
		`(?m)^\s*system_disk_type\s*=\s*"CLOUD_BSSD"\s*$`,
		`(?m)^\s*standard_node_pool_password\s*=\s*"Replace-Aa1!1234"\s*$`,
		`(?m)^\s*ap-johorbahru-1\s*=\s*106001\s*$`,
		`(?m)^\s*ap-johorbahru-2\s*=\s*106002\s*$`,
		`(?m)^\s*replica_zone_indexes\s*=\s*\[1\]\s*$`,
		`(?m)^\s*redis_replica_zone_indexes\s*=\s*\[0\]\s*$`,
		`(?m)^\s*manage_tcr_repository\s*=\s*false\s*$`,
		`(?m)^\s*tcr_public_domain\s*=\s*"lightclaw-sgprod\.tencentcloudcr\.com"\s*$`,
	} {
		if !regexp.MustCompile(expected).MatchString(johor) {
			t.Errorf("Johor Bahru sgprod example must contain %q", expected)
		}
	}
	for _, resource := range []string{"tencentcloud_tcr_namespace", "tencentcloud_tcr_repository"} {
		if !strings.Contains(tcr, resource) || !strings.Contains(tcr, "var.manage_tcr_repository ? 1 : 0") {
			t.Fatalf("%s must be conditional for cross-region registry reuse", resource)
		}
	}
}

func TestNewRegionCanBootstrapBeforeCLBExists(t *testing.T) {
	t.Parallel()

	variables := mustReadFile(t, "variables.tf")
	edgeDNS := mustReadFile(t, "edge_dns.tf")
	shanghai := mustReadFile(t, filepath.Join("environments", "shanghai.tfvars.example"))

	if !strings.Contains(terraformVariableBlock(t, variables, "edge_dns_enabled"), "default     = true") {
		t.Fatal("existing regions must keep DNS management enabled by default")
	}
	if !strings.Contains(edgeDNS, "var.edge_dns_enabled ? 1 : 0") {
		t.Fatal("DNS records must support a disabled bootstrap phase")
	}
	if !strings.Contains(edgeDNS, "moved {") {
		t.Fatal("DNS address migration must preserve existing Beijing state")
	}
	if !strings.Contains(edgeDNS, `!startswith(lower(trimspace(var.control_clb_domain)), "replace")`) ||
		!strings.Contains(edgeDNS, `!startswith(lower(trimspace(var.traffic_clb_domain)), "replace")`) {
		t.Fatal("enabled DNS records must reject placeholder CLB domains")
	}
	if !regexp.MustCompile(`(?m)^\s*edge_dns_enabled\s*=\s*false\s*$`).MatchString(shanghai) {
		t.Fatal("new-region example must bootstrap without unknown CLB domains")
	}
}

func TestDataStoresAllowTKEPodCIDR(t *testing.T) {
	t.Parallel()

	securityGroups := mustReadFile(t, "security_groups.tf")
	const podAndNodeCIDRs = "distinct(concat(var.app_subnet_cidrs, [var.tke_cluster_cidr]))"
	if count := strings.Count(securityGroups, podAndNodeCIDRs); count != 2 {
		t.Fatalf("MySQL and Redis security groups must both allow TKE Pod and node CIDRs, found %d rules", count)
	}
}

func TestControlRouteRedisUsesThreeShardThreeReplicaMultiAZCluster(t *testing.T) {
	t.Parallel()

	variables := mustReadFile(t, "variables.tf")
	dataStores := mustReadFile(t, "data_stores.tf")
	controlRedis := terraformVariableBlock(t, variables, "control_redis")

	for _, expected := range []string{
		`(?m)^\s*type_id\s*=\s*18\s*$`,
		`(?m)^\s*redis_shard_num\s*=\s*3\s*$`,
		`(?m)^\s*redis_replicas_num\s*=\s*3\s*$`,
		`(?m)^\s*replica_zone_indexes\s*=\s*\[0, 1, 1\]\s*$`,
	} {
		if !regexp.MustCompile(expected).MatchString(controlRedis) {
			t.Errorf("control_redis production default must contain %q", expected)
		}
	}
	if !strings.Contains(dataStores, `data "tencentcloud_availability_zones_by_product" "redis"`) {
		t.Fatal("Redis topology must resolve current TencentCloud zone IDs instead of hard-coding them")
	}
	if !strings.Contains(dataStores, "? local.control_redis_replica_zone_ids") {
		t.Fatal("control Redis must support explicit replica placement in established regions")
	}
	if !regexp.MustCompile(`(?m)^\s*replicas_read_only\s*=\s*false\s*$`).MatchString(dataStores) {
		t.Fatal("route Redis must keep strongly consistent primary reads")
	}
	if !strings.Contains(dataStores, "distinct(concat([0], var.control_redis.replica_zone_indexes))") {
		t.Fatal("multi-AZ validation must count the primary zone as well as replica zones")
	}
	if !strings.Contains(dataStores, "length(var.redis_zone_ids) == 0") {
		t.Fatal("new regions must be able to provide Redis zone IDs without the legacy zone data source")
	}

	for _, path := range []string{
		filepath.Join("environments", "beijing.tfvars.example"),
		filepath.Join("environments", "shanghai.tfvars.example"),
	} {
		raw := mustReadFile(t, path)
		for _, expected := range []string{
			`(?m)^\s*type_id\s*=\s*18\s*$`,
			`(?m)^\s*redis_shard_num\s*=\s*3\s*$`,
			`(?m)^\s*redis_replicas_num\s*=\s*3\s*$`,
			`(?m)^\s*replica_zone_indexes\s*=\s*\[0, 1, 1\]\s*$`,
		} {
			if !regexp.MustCompile(expected).MatchString(raw) {
				t.Errorf("%s must contain %q", path, expected)
			}
		}
	}
}

type regionalExample struct {
	region           string
	regionAlias      string
	zones            []string
	controlSubdomain string
	trafficSubdomain string
}

func parseRegionalExample(t *testing.T, path string) regionalExample {
	t.Helper()
	raw := mustReadFile(t, path)
	return regionalExample{
		region:           stringAssignment(t, raw, "region"),
		regionAlias:      stringAssignment(t, raw, "region_alias"),
		zones:            stringListAssignment(t, raw, "availability_zones"),
		controlSubdomain: stringAssignment(t, raw, "control_dns_subdomain"),
		trafficSubdomain: stringAssignment(t, raw, "traffic_dns_subdomain"),
	}
}

func assertRegionalExample(t *testing.T, example regionalExample) {
	t.Helper()
	if example.region == "" {
		t.Fatal("region must not be empty")
	}
	if example.regionAlias == "" {
		t.Fatal("region_alias must not be empty")
	}
	if len(example.zones) < 2 {
		t.Fatalf("region %q must define at least two availability zones", example.region)
	}
	for _, zone := range example.zones {
		if !strings.HasPrefix(zone, example.region+"-") {
			t.Errorf("zone %q does not belong to region %q", zone, example.region)
		}
	}
	if example.controlSubdomain == "" || example.trafficSubdomain == "" {
		t.Fatal("control and traffic subdomains must not be empty")
	}
	if example.controlSubdomain == example.trafficSubdomain {
		t.Errorf("control and traffic subdomains both use %q", example.controlSubdomain)
	}
}

type backendExample struct {
	region string
	prefix string
}

func parseBackendExample(t *testing.T, path string) backendExample {
	t.Helper()
	raw := mustReadFile(t, path)
	return backendExample{
		region: stringAssignment(t, raw, "region"),
		prefix: stringAssignment(t, raw, "prefix"),
	}
}

func terraformVariableBlock(t *testing.T, raw, name string) string {
	t.Helper()
	start := strings.Index(raw, `variable "`+name+`" {`)
	if start < 0 {
		t.Fatalf("variable %q not found", name)
	}
	rest := raw[start:]
	depth := 0
	for i, char := range rest {
		switch char {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return rest[:i+1]
			}
		}
	}
	t.Fatalf("variable %q block is not closed", name)
	return ""
}

func stringAssignment(t *testing.T, raw, name string) string {
	t.Helper()
	re := regexp.MustCompile(`(?m)^\s*` + regexp.QuoteMeta(name) + `\s*=\s*"([^"]*)"`)
	match := re.FindStringSubmatch(raw)
	if len(match) != 2 {
		t.Fatalf("string assignment %q not found", name)
	}
	return match[1]
}

func stringListAssignment(t *testing.T, raw, name string) []string {
	t.Helper()
	re := regexp.MustCompile(`(?ms)^\s*` + regexp.QuoteMeta(name) + `\s*=\s*\[(.*?)\]`)
	match := re.FindStringSubmatch(raw)
	if len(match) != 2 {
		t.Fatalf("list assignment %q not found", name)
	}
	items := regexp.MustCompile(`"([^"]+)"`).FindAllStringSubmatch(match[1], -1)
	result := make([]string, 0, len(items))
	for _, item := range items {
		result = append(result, item[1])
	}
	return result
}

func mustReadFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(raw)
}
