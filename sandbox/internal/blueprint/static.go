package blueprint

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

const DefaultStaticBlueprintPath = "config/vpc-shard-blueprint.yaml"

type StaticSubnet struct {
	Name    string `yaml:"name" json:"name"`
	CIDR    string `yaml:"cidr" json:"cidr"`
	Zone    string `yaml:"zone" json:"zone"`
	Role    string `yaml:"role" json:"role"`
	Ordinal int    `yaml:"ordinal" json:"ordinal"`
}

type StaticNATGateway struct {
	Name   string `yaml:"name" json:"name"`
	Zone   string `yaml:"zone,omitempty" json:"zone,omitempty"`
	Subnet string `yaml:"subnet,omitempty" json:"subnet,omitempty"`
}

type StaticNATShape struct {
	Mode     string             `yaml:"mode" json:"mode"`
	Gateways []StaticNATGateway `yaml:"gateways,omitempty" json:"gateways,omitempty"`
}

type StaticRouteAssociation struct {
	Target string `yaml:"target" json:"target"`
}

type StaticRoute struct {
	Destination string `yaml:"destination" json:"destination"`
	NextHopType string `yaml:"next_hop_type" json:"next_hop_type"`
	NextHopRef  string `yaml:"next_hop_ref" json:"next_hop_ref"`
	Enabled     bool   `yaml:"enabled" json:"enabled"`
}

type StaticRouteTable struct {
	Name         string                   `yaml:"name" json:"name"`
	Main         bool                     `yaml:"main,omitempty" json:"main,omitempty"`
	Associations []StaticRouteAssociation `yaml:"associations,omitempty" json:"associations,omitempty"`
	Routes       []StaticRoute            `yaml:"routes" json:"routes"`
}

type StaticRouteShape struct {
	RouteTables []StaticRouteTable `yaml:"route_tables" json:"route_tables"`
}

type StaticVPCShardBlueprint struct {
	SchemaVersion     string           `yaml:"schema_version" json:"schema_version"`
	SourceRegion      string           `yaml:"source_region" json:"source_region"`
	NetworkTemplateID string           `yaml:"network_template_id" json:"network_template_id"`
	VPCCIDR           string           `yaml:"vpc_cidr" json:"vpc_cidr"`
	SupportSubnet     StaticSubnet     `yaml:"support_subnet" json:"support_subnet"`
	WorkloadSubnets   []StaticSubnet   `yaml:"workload_subnets" json:"workload_subnets"`
	NATShape          StaticNATShape   `yaml:"nat_shape" json:"nat_shape"`
	RouteShape        StaticRouteShape `yaml:"route_shape" json:"route_shape"`
}

func LoadStaticVPCShardBlueprint(path string) (StaticVPCShardBlueprint, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		path = DefaultStaticBlueprintPath
	}
	raw, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		return StaticVPCShardBlueprint{}, err
	}
	var bp StaticVPCShardBlueprint
	if err := yaml.Unmarshal(raw, &bp); err != nil {
		return StaticVPCShardBlueprint{}, err
	}
	if err := ValidateStaticVPCShardBlueprint(bp); err != nil {
		return StaticVPCShardBlueprint{}, err
	}
	return normalizeStaticBlueprint(bp), nil
}

func SaveStaticVPCShardBlueprint(path string, bp StaticVPCShardBlueprint) error {
	path = strings.TrimSpace(path)
	if path == "" {
		path = DefaultStaticBlueprintPath
	}
	bp = normalizeStaticBlueprint(bp)
	if err := ValidateStaticVPCShardBlueprint(bp); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(filepath.Clean(path)), 0o755); err != nil {
		return err
	}
	data, err := yaml.Marshal(bp)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Clean(path), data, 0o644)
}

func ValidateStaticVPCShardBlueprint(bp StaticVPCShardBlueprint) error {
	if strings.TrimSpace(bp.SchemaVersion) == "" {
		return fmt.Errorf("missing schema_version")
	}
	if strings.TrimSpace(bp.SourceRegion) == "" {
		return fmt.Errorf("missing source_region")
	}
	if strings.TrimSpace(bp.NetworkTemplateID) == "" {
		return fmt.Errorf("missing network_template_id")
	}
	if strings.TrimSpace(bp.VPCCIDR) == "" {
		return fmt.Errorf("missing vpc_cidr")
	}
	if strings.TrimSpace(bp.SupportSubnet.CIDR) == "" || strings.TrimSpace(bp.SupportSubnet.Zone) == "" {
		return fmt.Errorf("missing support_subnet cidr/zone")
	}
	if len(bp.WorkloadSubnets) == 0 {
		return fmt.Errorf("missing workload_subnets")
	}
	for _, subnet := range bp.WorkloadSubnets {
		if strings.TrimSpace(subnet.CIDR) == "" || strings.TrimSpace(subnet.Zone) == "" {
			return fmt.Errorf("workload subnet missing cidr/zone")
		}
	}
	if strings.TrimSpace(bp.NATShape.Mode) == "" {
		return fmt.Errorf("missing nat_shape")
	}
	if len(bp.RouteShape.RouteTables) == 0 {
		return fmt.Errorf("missing route_shape")
	}
	for _, gateway := range bp.NATShape.Gateways {
		if strings.TrimSpace(gateway.Name) == "" {
			return fmt.Errorf("nat gateway missing name")
		}
	}
	for _, table := range bp.RouteShape.RouteTables {
		if strings.TrimSpace(table.Name) == "" {
			return fmt.Errorf("route table missing name")
		}
		if len(table.Routes) == 0 {
			return fmt.Errorf("route table %q missing routes", table.Name)
		}
		for _, assoc := range table.Associations {
			if strings.TrimSpace(assoc.Target) == "" {
				return fmt.Errorf("route table %q association missing target", table.Name)
			}
		}
		for _, route := range table.Routes {
			if strings.TrimSpace(route.Destination) == "" || strings.TrimSpace(route.NextHopType) == "" || strings.TrimSpace(route.NextHopRef) == "" {
				return fmt.Errorf("route table %q has incomplete route semantics", table.Name)
			}
		}
	}
	return nil
}

func StaticBlueprintFingerprint(bp StaticVPCShardBlueprint) string {
	normalized := normalizeStaticBlueprint(bp)
	payload := struct {
		SchemaVersion     string           `json:"schema_version"`
		SourceRegion      string           `json:"source_region"`
		NetworkTemplateID string           `json:"network_template_id"`
		VPCCIDR           string           `json:"vpc_cidr"`
		SupportSubnet     StaticSubnet     `json:"support_subnet"`
		WorkloadSubnets   []StaticSubnet   `json:"workload_subnets"`
		NATShape          StaticNATShape   `json:"nat_shape"`
		RouteShape        StaticRouteShape `json:"route_shape"`
	}{
		SchemaVersion:     normalized.SchemaVersion,
		SourceRegion:      normalized.SourceRegion,
		NetworkTemplateID: normalized.NetworkTemplateID,
		VPCCIDR:           normalized.VPCCIDR,
		SupportSubnet:     normalized.SupportSubnet,
		WorkloadSubnets:   normalized.WorkloadSubnets,
		NATShape:          normalized.NATShape,
		RouteShape:        normalized.RouteShape,
	}
	raw, _ := json.Marshal(payload)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:16])
}

func normalizeStaticBlueprint(bp StaticVPCShardBlueprint) StaticVPCShardBlueprint {
	bp.SchemaVersion = strings.TrimSpace(bp.SchemaVersion)
	bp.SourceRegion = strings.TrimSpace(bp.SourceRegion)
	bp.NetworkTemplateID = strings.TrimSpace(bp.NetworkTemplateID)
	bp.VPCCIDR = strings.TrimSpace(bp.VPCCIDR)
	bp.SupportSubnet = normalizeSubnet(bp.SupportSubnet)
	workloads := make([]StaticSubnet, 0, len(bp.WorkloadSubnets))
	for _, subnet := range bp.WorkloadSubnets {
		workloads = append(workloads, normalizeSubnet(subnet))
	}
	sort.SliceStable(workloads, func(i, j int) bool {
		if workloads[i].Ordinal != workloads[j].Ordinal {
			return workloads[i].Ordinal < workloads[j].Ordinal
		}
		return workloads[i].Name < workloads[j].Name
	})
	bp.WorkloadSubnets = workloads
	bp.NATShape = normalizeNATShape(bp.NATShape)
	bp.RouteShape = normalizeRouteShape(bp.RouteShape)
	return bp
}

func normalizeSubnet(subnet StaticSubnet) StaticSubnet {
	subnet.Name = strings.TrimSpace(subnet.Name)
	subnet.CIDR = strings.TrimSpace(subnet.CIDR)
	subnet.Zone = strings.TrimSpace(subnet.Zone)
	subnet.Role = strings.TrimSpace(subnet.Role)
	return subnet
}

func normalizeNATShape(shape StaticNATShape) StaticNATShape {
	shape.Mode = strings.TrimSpace(shape.Mode)
	gateways := make([]StaticNATGateway, 0, len(shape.Gateways))
	for _, gateway := range shape.Gateways {
		gateway.Name = strings.TrimSpace(gateway.Name)
		gateway.Zone = strings.TrimSpace(gateway.Zone)
		gateway.Subnet = strings.TrimSpace(gateway.Subnet)
		gateways = append(gateways, gateway)
	}
	sort.SliceStable(gateways, func(i, j int) bool {
		return gateways[i].Name < gateways[j].Name
	})
	shape.Gateways = gateways
	return shape
}

func normalizeRouteShape(shape StaticRouteShape) StaticRouteShape {
	tables := make([]StaticRouteTable, 0, len(shape.RouteTables))
	for _, table := range shape.RouteTables {
		table.Name = strings.TrimSpace(table.Name)
		associations := make([]StaticRouteAssociation, 0, len(table.Associations))
		for _, assoc := range table.Associations {
			assoc.Target = strings.TrimSpace(assoc.Target)
			associations = append(associations, assoc)
		}
		sort.SliceStable(associations, func(i, j int) bool {
			return associations[i].Target < associations[j].Target
		})
		routes := make([]StaticRoute, 0, len(table.Routes))
		for _, route := range table.Routes {
			route.Destination = strings.TrimSpace(route.Destination)
			route.NextHopType = strings.TrimSpace(route.NextHopType)
			route.NextHopRef = strings.TrimSpace(route.NextHopRef)
			routes = append(routes, route)
		}
		sort.SliceStable(routes, func(i, j int) bool {
			if routes[i].Destination != routes[j].Destination {
				return routes[i].Destination < routes[j].Destination
			}
			if routes[i].NextHopType != routes[j].NextHopType {
				return routes[i].NextHopType < routes[j].NextHopType
			}
			return routes[i].NextHopRef < routes[j].NextHopRef
		})
		table.Associations = associations
		table.Routes = routes
		tables = append(tables, table)
	}
	sort.SliceStable(tables, func(i, j int) bool {
		return tables[i].Name < tables[j].Name
	})
	shape.RouteTables = tables
	return shape
}
