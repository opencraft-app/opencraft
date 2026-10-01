package main

import (
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"os"
)

const minimumTLSVersion = tls.VersionTLS12

// Only an explicit loopback listener may omit TLS (for local probes or a local
// TLS proxy). Private VPC addresses do not protect bearer tokens in transit.
func listenerTLS(addr, certFile, keyFile string) (*tls.Config, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("invalid runtime listener: %w", err)
	}
	if certFile == "" && keyFile == "" {
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			return nil, errors.New("non-loopback runtime listener requires TLS certificate and key")
		}
		return nil, nil
	}
	if certFile == "" || keyFile == "" {
		return nil, errors.New("both runtime TLS certificate and key required")
	}
	info, err := os.Lstat(keyFile)
	if err != nil {
		return nil, fmt.Errorf("runtime TLS key: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("runtime TLS key must be a private regular file")
	}
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("load runtime TLS certificate: %w", err)
	}
	return &tls.Config{MinVersion: minimumTLSVersion, Certificates: []tls.Certificate{cert}}, nil
}
