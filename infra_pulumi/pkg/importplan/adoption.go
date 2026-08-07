package importplan

import (
	"fmt"
	"sort"
	"strings"
)

var infrastructureComponents = []string{
	"clb",
	"compute",
	"connectivity",
	"cynosdb",
	"monitoring",
	"networking",
	"notify",
	"redis",
	"security",
	"storage",
	"tcr",
	"tke",
}

type adoptionMetadata struct {
	adoptable []string
	external  []string
}

func (p *Plan) AdoptionComponents() (adoptable []string, external []string) {
	if p == nil {
		return nil, nil
	}
	adoptable = append([]string(nil), p.adoption.adoptable...)
	external = append([]string(nil), p.adoption.external...)
	sort.Strings(adoptable)
	sort.Strings(external)
	return adoptable, external
}

func (p *Plan) ValidateAdoption() error {
	if p == nil {
		return fmt.Errorf("adoption plan is nil")
	}

	adoptable, external := p.AdoptionComponents()
	classified := make(map[string]string, len(adoptable)+len(external))
	for _, entry := range []struct {
		class      string
		components []string
	}{
		{class: "adoptable", components: adoptable},
		{class: "external", components: external},
	} {
		for _, component := range entry.components {
			if previous, ok := classified[component]; ok {
				return fmt.Errorf("component %q is classified as both %s and %s", component, previous, entry.class)
			}
			classified[component] = entry.class
		}
	}

	for _, component := range infrastructureComponents {
		if _, ok := classified[component]; !ok {
			return fmt.Errorf("component %q has no adoption classification", component)
		}
	}
	for component := range classified {
		if !contains(infrastructureComponents, component) {
			return fmt.Errorf("unknown adoption component %q", component)
		}
	}

	for _, component := range adoptable {
		for field, value := range p.requiredImportIDs(component) {
			if strings.TrimSpace(value) == "" {
				return fmt.Errorf("%s import field %s is empty", component, field)
			}
		}
	}
	return nil
}

func (p *Plan) requiredImportIDs(component string) map[string]string {
	switch component {
	case "cynosdb":
		return map[string]string{
			"ClusterID": p.Cynosdb.ClusterID,
		}
	case "redis":
		return map[string]string{
			"CtlMQID":        p.Redis.CtlMQID,
			"SandboxRouteID": p.Redis.SandboxRouteID,
		}
	case "security":
		return map[string]string{
			"CynosdbSecurityGroupID":  p.Cynosdb.SecurityGroupID,
			"NodePoolSecurityGroupID": p.TKE.NodePoolSecurityGroupID,
			"SandboxSecurityGroupID":  p.Security.SandboxSecurityGroupID,
		}
	case "tcr":
		return map[string]string{
			"InstanceID":       p.TCR.InstanceID,
			"NamespaceID":      p.TCR.NamespaceID,
			"ServiceAccountID": p.TCR.ServiceAccountID,
		}
	case "tke":
		return map[string]string{
			"ClusterID":  p.TKE.ClusterID,
			"NodePoolID": p.TKE.NodePoolID,
		}
	default:
		return nil
	}
}

func contains(values []string, candidate string) bool {
	for _, value := range values {
		if value == candidate {
			return true
		}
	}
	return false
}
