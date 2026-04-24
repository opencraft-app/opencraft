package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"cvm-mock-e2b/internal/blueprint"
	"cvm-mock-e2b/internal/provider"
)

func main() {
	var (
		sourceVpcID       string
		region            string
		networkTemplateID string
		outputPath        string
	)
	flag.StringVar(&sourceVpcID, "source-vpc-id", "", "source live VPC id to export")
	flag.StringVar(&region, "region", strings.TrimSpace(os.Getenv("TENCENT_REGION")), "Tencent Cloud region")
	flag.StringVar(&networkTemplateID, "network-template-id", "", "network template id to persist into static blueprint")
	flag.StringVar(&outputPath, "output", blueprint.DefaultStaticBlueprintPath, "output static blueprint yaml path")
	flag.Parse()

	if strings.TrimSpace(sourceVpcID) == "" {
		fatalf("missing --source-vpc-id")
	}
	if strings.TrimSpace(region) == "" {
		fatalf("missing --region (or TENCENT_REGION)")
	}
	cp, err := provider.ResolveFromEnv()
	if err != nil {
		fatalf("resolve provider: %v", err)
	}
	exporter, ok := cp.(provider.VPCShardBlueprintExporter)
	if !ok {
		fatalf("provider does not support VPC blueprint export")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	exported, err := exporter.ExportVPCShardBlueprint(ctx, strings.TrimSpace(region), strings.TrimSpace(sourceVpcID))
	if err != nil {
		fatalf("export live vpc blueprint: %v", err)
	}
	if strings.TrimSpace(networkTemplateID) != "" {
		exported.NetworkTemplateID = strings.TrimSpace(networkTemplateID)
	}
	static := blueprint.StaticVPCShardBlueprint{
		SchemaVersion:     firstNonEmpty(strings.TrimSpace(exported.SchemaVersion), "v1alpha1"),
		SourceRegion:      strings.TrimSpace(exported.SourceRegion),
		NetworkTemplateID: strings.TrimSpace(exported.NetworkTemplateID),
		VPCCIDR:           strings.TrimSpace(exported.VPCCIDR),
		SupportSubnet: blueprint.StaticSubnet{
			Name:    exported.SupportSubnet.Name,
			CIDR:    exported.SupportSubnet.CIDR,
			Zone:    exported.SupportSubnet.Zone,
			Role:    string(exported.SupportSubnet.Role),
			Ordinal: exported.SupportSubnet.Ordinal,
		},
		WorkloadSubnets: convertStaticSubnets(exported.WorkloadSubnets),
		NATShape:        exported.NATShape,
		RouteShape:      exported.RouteShape,
	}
	if err := blueprint.SaveStaticVPCShardBlueprint(outputPath, static); err != nil {
		fatalf("save static blueprint: %v", err)
	}
	fmt.Printf("wrote static blueprint to %s\n", outputPath)
}

func convertStaticSubnets(specs []provider.VPCShardSubnetSpec) []blueprint.StaticSubnet {
	items := make([]blueprint.StaticSubnet, 0, len(specs))
	for _, subnet := range specs {
		items = append(items, blueprint.StaticSubnet{
			Name:    subnet.Name,
			CIDR:    subnet.CIDR,
			Zone:    subnet.Zone,
			Role:    string(subnet.Role),
			Ordinal: subnet.Ordinal,
		})
	}
	return items
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func fatalf(format string, args ...any) {
	_, _ = fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
