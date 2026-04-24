package networklayout

import (
	"encoding/binary"
	"fmt"
	"net"
)

const (
	PoolSubnetPrefixBits    = 16
	SupportSubnetPrefixBits = 18
	MinSupportSubnetIPs     = 10000
)

func PoolSubnetCIDR(vpcCIDR string, index int) (string, error) {
	return nthSubnetCIDR(vpcCIDR, PoolSubnetPrefixBits, index)
}

func SupportSubnetCIDR(vpcCIDR string) (string, error) {
	_, network, err := net.ParseCIDR(vpcCIDR)
	if err != nil {
		return "", fmt.Errorf("parse vpc cidr: %w", err)
	}
	baseOnes, bits := network.Mask.Size()
	if bits != 32 {
		return "", fmt.Errorf("only IPv4 cidr is supported: %s", vpcCIDR)
	}
	if SupportSubnetPrefixBits < baseOnes {
		return "", fmt.Errorf("support subnet prefix /%d is larger than vpc cidr %s", SupportSubnetPrefixBits, vpcCIDR)
	}

	subnetCount := 1 << (SupportSubnetPrefixBits - baseOnes)
	return nthSubnetCIDR(vpcCIDR, SupportSubnetPrefixBits, subnetCount-1)
}

func CIDRAddressCount(cidr string) (int, error) {
	_, network, err := net.ParseCIDR(cidr)
	if err != nil {
		return 0, fmt.Errorf("parse cidr: %w", err)
	}
	ones, bits := network.Mask.Size()
	if bits != 32 {
		return 0, fmt.Errorf("only IPv4 cidr is supported: %s", cidr)
	}
	return 1 << (bits - ones), nil
}

func nthSubnetCIDR(vpcCIDR string, prefixBits, index int) (string, error) {
	ip, network, err := net.ParseCIDR(vpcCIDR)
	if err != nil {
		return "", fmt.Errorf("parse vpc cidr: %w", err)
	}
	baseOnes, bits := network.Mask.Size()
	if bits != 32 {
		return "", fmt.Errorf("only IPv4 cidr is supported: %s", vpcCIDR)
	}
	if prefixBits < baseOnes {
		return "", fmt.Errorf("prefix /%d is larger than vpc cidr %s", prefixBits, vpcCIDR)
	}

	subnetCount := 1 << (prefixBits - baseOnes)
	if index < 0 || index >= subnetCount {
		return "", fmt.Errorf("subnet index %d out of range for %s with /%d", index, vpcCIDR, prefixBits)
	}

	baseIP := ip.To4()
	if baseIP == nil {
		return "", fmt.Errorf("only IPv4 cidr is supported: %s", vpcCIDR)
	}
	baseInt := binary.BigEndian.Uint32(baseIP)
	subnetSize := uint32(1) << (32 - prefixBits)
	subnetIP := make(net.IP, len(baseIP))
	binary.BigEndian.PutUint32(subnetIP, baseInt+(uint32(index)*subnetSize))
	return fmt.Sprintf("%s/%d", subnetIP.String(), prefixBits), nil
}
