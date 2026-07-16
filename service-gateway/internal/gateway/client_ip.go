package gateway

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
)

const canonicalClientIPHeader = "X-Lightclaw-Client-IP"

func parseTrustedProxyCIDRs(values []string) ([]netip.Prefix, error) {
	prefixes := make([]netip.Prefix, 0, len(values))
	for _, value := range values {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(value))
		if err != nil {
			return nil, err
		}
		prefixes = append(prefixes, prefix.Masked())
	}
	return prefixes, nil
}

// canonicalClientIP accepts forwarding headers only when the immediate TCP
// peer is configured as trusted, then peels trusted hops from right to left.
// The first untrusted hop is authoritative; direct callers cannot supply their
// own client identity.
func canonicalClientIP(r *http.Request, trustedProxies []netip.Prefix) string {
	peer, peerOK := remoteIP(r.RemoteAddr)
	if !peerOK || !containsIP(trustedProxies, peer) {
		if peerOK {
			return peer.String()
		}
		return strings.TrimSpace(r.RemoteAddr)
	}

	candidate := peer
	forwarded := r.Header.Values("X-Forwarded-For")
	for i := len(forwarded) - 1; i >= 0; i-- {
		parts := strings.Split(forwarded[i], ",")
		for j := len(parts) - 1; j >= 0; j-- {
			if !containsIP(trustedProxies, candidate) {
				return candidate.String()
			}
			if addr, ok := parseClientIP(parts[j]); ok {
				candidate = addr
			}
		}
	}
	return candidate.String()
}

func remoteIP(remoteAddr string) (netip.Addr, bool) {
	remote := strings.TrimSpace(remoteAddr)
	if host, _, err := net.SplitHostPort(remote); err == nil {
		remote = host
	}
	return parseClientIP(remote)
}

func containsIP(prefixes []netip.Prefix, addr netip.Addr) bool {
	for _, prefix := range prefixes {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

func parseClientIP(value string) (netip.Addr, bool) {
	value = strings.Trim(strings.TrimSpace(value), "\"")
	addr, err := netip.ParseAddr(value)
	if err != nil {
		return netip.Addr{}, false
	}
	return addr.Unmap(), true
}

func setCanonicalClientIPHeaders(header http.Header, clientIP string) {
	header.Del("Forwarded")
	header.Del("X-Forwarded-For")
	header.Del("X-Real-IP")
	header.Del(canonicalClientIPHeader)
	if clientIP == "" {
		return
	}
	header.Set("X-Forwarded-For", clientIP)
	header.Set("X-Real-IP", clientIP)
	header.Set(canonicalClientIPHeader, clientIP)
}
