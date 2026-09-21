package gateway

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

var ErrUnsafeSetURL = errors.New("unsafe managed set url")

var dnsLabelPattern = regexp.MustCompile(`^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$`)

type managedSetURLKind string

const (
	managedSetAdminURL   managedSetURLKind = "admin"
	managedSetTrafficURL managedSetURLKind = "traffic"
)

func validateManagedSetAdminBaseURL(setID string, rawURL string) error {
	_, err := parseManagedSetURL(setID, rawURL, managedSetAdminURL)
	return err
}

func validateManagedSetTrafficBaseURL(setID string, rawURL string) error {
	_, err := parseManagedSetURL(setID, rawURL, managedSetTrafficURL)
	return err
}

func parseManagedSetURL(setID string, rawURL string, kind managedSetURLKind) (*url.URL, error) {
	setID = strings.TrimSpace(setID)
	if setID != "" && !dnsLabelPattern.MatchString(setID) {
		return nil, fmt.Errorf("%w: invalid set id", ErrUnsafeSetURL)
	}
	parsed, err := url.ParseRequestURI(strings.TrimSpace(rawURL))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("%w: invalid absolute url", ErrUnsafeSetURL)
	}
	if parsed.Scheme != "http" {
		return nil, fmt.Errorf("%w: managed set url must use http", ErrUnsafeSetURL)
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return nil, fmt.Errorf("%w: credentials, path, query, and fragment are not allowed", ErrUnsafeSetURL)
	}
	if parsed.Port() != "3000" {
		return nil, fmt.Errorf("%w: managed set url must use port 3000", ErrUnsafeSetURL)
	}
	hostname := parsed.Hostname()
	if hostname == "" || hostname != strings.ToLower(hostname) || net.ParseIP(hostname) != nil {
		return nil, fmt.Errorf("%w: managed set url must use a kubernetes service hostname", ErrUnsafeSetURL)
	}
	labels := strings.Split(hostname, ".")
	for _, label := range labels {
		if len(label) > 63 || !dnsLabelPattern.MatchString(label) {
			return nil, fmt.Errorf("%w: invalid kubernetes service hostname", ErrUnsafeSetURL)
		}
	}
	if !validManagedSetDNSShape(labels) {
		return nil, fmt.Errorf("%w: external dns names are not allowed", ErrUnsafeSetURL)
	}
	if !managedSetServiceNameMatches(labels[0], setID, kind) {
		return nil, fmt.Errorf("%w: hostname does not match the managed set service", ErrUnsafeSetURL)
	}
	return parsed, nil
}

func validManagedSetDNSShape(labels []string) bool {
	switch len(labels) {
	case 1:
		return true
	case 3:
		return labels[2] == "svc"
	case 5:
		return labels[2] == "svc" && labels[3] == "cluster" && labels[4] == "local"
	default:
		return false
	}
}

func managedSetServiceNameMatches(serviceName string, setID string, kind managedSetURLKind) bool {
	if !dnsLabelPattern.MatchString(serviceName) {
		return false
	}
	if setID == "" {
		switch kind {
		case managedSetAdminURL:
			return (strings.HasSuffix(serviceName, "-newapi-admin") && serviceName != "newapi-admin") ||
				(strings.HasSuffix(serviceName, "-newapi") && serviceName != "newapi")
		case managedSetTrafficURL:
			return strings.HasSuffix(serviceName, "-newapi-traffic") && serviceName != "newapi-traffic"
		default:
			return false
		}
	}
	marker := "-" + setID + "-"
	index := strings.LastIndex(serviceName, marker)
	if index <= 0 {
		return false
	}
	tail := serviceName[index+len(marker):]
	switch kind {
	case managedSetAdminURL:
		return tail == "newapi-admin" || tail == "newapi"
	case managedSetTrafficURL:
		if tail == "newapi-traffic" {
			return true
		}
		if !strings.HasPrefix(tail, "g") || !strings.HasSuffix(tail, "-newapi-traffic") {
			return false
		}
		generation := strings.TrimSuffix(strings.TrimPrefix(tail, "g"), "-newapi-traffic")
		value, err := strconv.ParseInt(generation, 10, 64)
		return err == nil && value > 0
	default:
		return false
	}
}

func managedSetAdminURLPolicy(setID string, rawBaseURL string) func(*url.URL) error {
	baseURL, err := parseManagedSetURL(setID, rawBaseURL, managedSetAdminURL)
	return func(target *url.URL) error {
		if err != nil {
			return err
		}
		if target == nil || target.Scheme != baseURL.Scheme || target.Host != baseURL.Host {
			return fmt.Errorf("%w: new-api request escaped its configured origin", ErrUnsafeSetURL)
		}
		return nil
	}
}
