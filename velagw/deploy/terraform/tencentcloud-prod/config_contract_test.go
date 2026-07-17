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

	beijing := parseRegionalExample(t, filepath.Join("environments", "beijing.tfvars.example"))
	shanghai := parseRegionalExample(t, filepath.Join("environments", "shanghai.tfvars.example"))

	assertRegionalExample(t, beijing)
	assertRegionalExample(t, shanghai)
	if beijing.region == shanghai.region {
		t.Fatalf("regional examples share region %q", beijing.region)
	}
	if beijing.controlSubdomain == shanghai.controlSubdomain {
		t.Errorf("regional examples share control subdomain %q", beijing.controlSubdomain)
	}
	if beijing.trafficSubdomain == shanghai.trafficSubdomain {
		t.Errorf("regional examples share traffic subdomain %q", beijing.trafficSubdomain)
	}
}

func TestRegionalBackendsUseIndependentState(t *testing.T) {
	t.Parallel()

	beijing := parseBackendExample(t, filepath.Join("backend", "beijing.hcl.example"))
	shanghai := parseBackendExample(t, filepath.Join("backend", "shanghai.hcl.example"))
	if beijing.region == "" || shanghai.region == "" {
		t.Error("backend region must identify the COS bucket location")
	}
	if beijing.prefix == shanghai.prefix {
		t.Errorf("regional backends share state prefix %q", beijing.prefix)
	}
	if beijing.prefix != "llmgateway/prod" {
		t.Fatalf("Beijing must preserve the existing production state prefix, got %q", beijing.prefix)
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
