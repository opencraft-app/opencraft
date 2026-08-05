package importplan

import (
	"reflect"
	"strings"
	"testing"
)

type adoptionPlan interface {
	AdoptionComponents() (adoptable []string, external []string)
	ValidateAdoption() error
}

func TestTokyoPlanUsesVerifiedProviderImportIDs(t *testing.T) {
	plan := ForEnvironment("tokyo-sandbox")

	if plan.TKE.ClusterID != "cls-kqn1an4m" {
		t.Fatalf("TKE cluster import ID = %q", plan.TKE.ClusterID)
	}
	if plan.TKE.NodePoolID != "cls-kqn1an4m#np-dpmaf61m" {
		t.Fatalf("TKE node pool import ID = %q", plan.TKE.NodePoolID)
	}
	if plan.TKE.NodePoolSecurityGroupID != "sg-84hqfbsc" {
		t.Fatalf("TKE node security group import ID = %q", plan.TKE.NodePoolSecurityGroupID)
	}
	if plan.Cynosdb.ClusterID != "cynosdbmysql-r1wrylc5" {
		t.Fatalf("CynosDB cluster import ID = %q", plan.Cynosdb.ClusterID)
	}
	if plan.Cynosdb.SecurityGroupID != "sg-qgy09tew" {
		t.Fatalf("CynosDB security group import ID = %q", plan.Cynosdb.SecurityGroupID)
	}
	if plan.Security.SandboxSecurityGroupID != "sg-14cou8p0" {
		t.Fatalf("sandbox security group import ID = %q", plan.Security.SandboxSecurityGroupID)
	}
	if plan.Redis.CtlMQID != "crs-4yqfur9y" || plan.Redis.SandboxRouteID != "crs-r831lh3s" {
		t.Fatalf("Redis import IDs = %+v", plan.Redis)
	}
	if plan.TCR.InstanceID != "tcr-f7emx0nt" ||
		plan.TCR.NamespaceID != "tcr-f7emx0nt#lightclaw" ||
		plan.TCR.ServiceAccountID != "tcr-f7emx0nt#lightclaw-pull" {
		t.Fatalf("TCR import IDs = %+v", plan.TCR)
	}
}

func TestTokyoPlanClassifiesEveryComponent(t *testing.T) {
	plan := ForEnvironment("tokyo-sandbox")
	candidate, ok := any(plan).(adoptionPlan)
	if !ok {
		t.Fatal("Tokyo plan does not expose static adoption metadata")
	}

	adoptable, external := candidate.AdoptionComponents()
	if want := []string{"cynosdb", "redis", "security", "tcr", "tke"}; !reflect.DeepEqual(adoptable, want) {
		t.Fatalf("adoptable components = %v, want %v", adoptable, want)
	}
	if want := []string{"clb", "compute", "connectivity", "monitoring", "networking", "notify", "storage"}; !reflect.DeepEqual(external, want) {
		t.Fatalf("external components = %v, want %v", external, want)
	}
	if err := candidate.ValidateAdoption(); err != nil {
		t.Fatalf("ValidateAdoption(tokyo-sandbox): %v", err)
	}
}

func TestTokyoPlanRejectsMissingAdoptableID(t *testing.T) {
	plan := ForEnvironment("tokyo-sandbox")
	plan.Redis.CtlMQID = ""
	candidate, ok := any(plan).(adoptionPlan)
	if !ok {
		t.Fatal("Tokyo plan does not expose static adoption metadata")
	}

	err := candidate.ValidateAdoption()
	if err == nil || !strings.Contains(err.Error(), "redis") || !strings.Contains(err.Error(), "CtlMQID") {
		t.Fatalf("ValidateAdoption() error = %v", err)
	}
}
