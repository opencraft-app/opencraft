package ingressproxy

import (
	"fmt"
	"hash/crc32"
	"net"
	"strconv"
	"strings"
)

type Target struct {
	Port      string
	SandboxID string
	IP        string
}

func (t Target) IsIPBackdoor() bool {
	return t.IP != ""
}

func (t Target) ShardKey() string {
	if t.IsIPBackdoor() {
		return "ip:" + t.IP
	}
	return t.SandboxID
}

func ParseTargetHost(host string, enableIPBackdoor bool) (Target, error) {
	label := host
	if i := strings.Index(label, ":"); i >= 0 {
		label = label[:i]
	}

	if enableIPBackdoor {
		if port, ip, err := parseIPBackdoorHost(label); err == nil {
			return Target{Port: port, IP: ip}, nil
		}
	}

	port, sandboxID, err := parseSandboxHost(label)
	if err != nil {
		return Target{}, err
	}
	return Target{Port: port, SandboxID: sandboxID}, nil
}

func ShardForKey(key string, shardCount int) (int, error) {
	if strings.TrimSpace(key) == "" {
		return 0, fmt.Errorf("shard key required")
	}
	if shardCount <= 0 {
		return 0, fmt.Errorf("shard count must be positive")
	}
	return int(crc32.ChecksumIEEE([]byte(key)) % uint32(shardCount)), nil
}

func parseSandboxHost(host string) (port, sandboxID string, err error) {
	parts := strings.SplitN(host, "-", 2)
	if len(parts) != 2 {
		return "", "", fmt.Errorf("missing separator")
	}
	if !isValidPort(parts[0]) {
		return "", "", fmt.Errorf("invalid port")
	}

	rest := parts[1]
	if i := strings.Index(rest, "."); i >= 0 {
		rest = rest[:i]
	}
	sandboxID = strings.TrimSuffix(rest, "-00000000")
	if sandboxID == "" {
		return "", "", fmt.Errorf("empty sandbox id")
	}
	return parts[0], sandboxID, nil
}

func parseIPBackdoorHost(host string) (port, ip string, err error) {
	parts := strings.SplitN(host, "-ip-", 2)
	if len(parts) != 2 {
		return "", "", fmt.Errorf("invalid ip backdoor format")
	}
	if !isValidPort(parts[0]) {
		return "", "", fmt.Errorf("invalid port")
	}

	ipPart := parts[1]
	if i := strings.Index(ipPart, "."); i >= 0 {
		candidate := ipPart
		for j := 0; j < strings.Count(ipPart, "."); j++ {
			if parsed := net.ParseIP(candidate); parsed != nil && parsed.To4() != nil {
				return parts[0], parsed.To4().String(), nil
			}
			lastDot := strings.LastIndex(candidate, ".")
			if lastDot < 0 {
				break
			}
			candidate = candidate[:lastDot]
		}
	}

	parsed := net.ParseIP(ipPart)
	if parsed == nil || parsed.To4() == nil {
		return "", "", fmt.Errorf("invalid ipv4")
	}
	return parts[0], parsed.To4().String(), nil
}

func isValidPort(port string) bool {
	value, err := strconv.Atoi(port)
	if err != nil {
		return false
	}
	return value >= 1 && value <= 65535
}
