package naming

import (
	"fmt"
	"strings"
)

func Resource(parts ...string) string {
	clean := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		clean = append(clean, part)
	}
	return strings.Join(clean, "-")
}

func StableResource(parts ...string) string {
	return fmt.Sprintf("lc-%s", Resource(parts...))
}

func ClusterName(envShort string) string {
	return fmt.Sprintf("tke-%s", envShort)
}

func NodePoolName(envShort string) string {
	return fmt.Sprintf("general-%s", envShort)
}

func ClusterEndpointSecurityGroupName(envShort string) string {
	return fmt.Sprintf("tke-endpoint-%s", envShort)
}

func CynosdbClusterName(envShort string) string {
	return fmt.Sprintf("cynosdb-%s", envShort)
}

func TCRInstanceName(envShort string) string {
	return fmt.Sprintf("lightclaw-%s", envShort)
}

func VPCName(envShort string) string {
	return fmt.Sprintf("lightclaw-%s", envShort)
}

func AccessVPCName(envShort string) string {
	return fmt.Sprintf("lightclaw-%s-access", envShort)
}

func AccessSubnetName(envShort string) string {
	return fmt.Sprintf("lightclaw-%s-access", envShort)
}

func AccessRouteTableName(envShort string) string {
	return fmt.Sprintf("lightclaw-%s-access", envShort)
}

func ControlPlaneCCNName(envShort string) string {
	return fmt.Sprintf("lightclaw-%s-control-plane", envShort)
}

func ControlPlanePrivateLinkServiceName(envShort string) string {
	return fmt.Sprintf("lightclaw-%s-control-plane", envShort)
}

func ControlPlanePrivateLinkEndpointName(envShort string) string {
	return fmt.Sprintf("lightclaw-%s-control-plane", envShort)
}

func ControlPlaneProviderCLBName(envShort string) string {
	return fmt.Sprintf("control-plane-%s", envShort)
}

func CtlMqRedisName(envShort string) string {
	return fmt.Sprintf("ctl-mq-redis-%s", envShort)
}

func SandboxRouteRedisName(envShort string) string {
	return fmt.Sprintf("sandbox-route-redis-%s", envShort)
}

func JumpserverName(envShort string) string {
	return fmt.Sprintf("jumpserver-%s", envShort)
}

func StorageBucketName(envShort, accountAppID string) string {
	return fmt.Sprintf("lightclawuser-%s-%s", envShort, accountAppID)
}

func StorageCAMUserName(envShort string) string {
	return fmt.Sprintf("lightclawuser-cos-%s", envShort)
}

func StorageCAMPolicyName(envShort string) string {
	return fmt.Sprintf("lightclawuser-cos-only-%s", envShort)
}
