package devroute

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/tunnelcap"
)

const (
	serviceAccountRoot     = "/var/run/secrets/kubernetes.io/serviceaccount"
	annotationUIN          = "cloudladdergateway.lightvela.com/uin"
	annotationUserID       = "cloudladdergateway.lightvela.com/user-id"
	annotationBaseURL      = "cloudladdergateway.lightvela.com/base-url"
	annotationDeliveryMode = "cloudladdergateway.lightvela.com/delivery-mode"
	annotationSourceIP     = "cloudladdergateway.lightvela.com/source-ip"
	annotationPort         = "cloudladdergateway.lightvela.com/port"
	annotationTunnelHost   = "cloudladdergateway.lightvela.com/tunnel-host"
	annotationTunnelToken  = "cloudladdergateway.lightvela.com/tunnel-token-sha256"
	annotationDisabled     = "cloudladdergateway.lightvela.com/disabled-at"
	managedByLabel         = "app.kubernetes.io/managed-by"
	developerRouteLabel    = "cloudladdergateway.lightvela.com/type"
	readinessProbeUIN      = "cloudladdergateway-readiness-probe"
)

type KubernetesLeaseOptions struct {
	BaseURL          string
	Namespace        string
	Token            string
	TokenFile        string
	Prefix           string
	AllowedCIDRs     []string
	AllowedPorts     []int
	DeliveryMode     string
	TunnelBaseURL    string
	TunnelHostSuffix string
	Client           *http.Client
}

type KubernetesLeaseStore struct {
	baseURL          string
	namespace        string
	token            string
	tokenFile        string
	prefix           string
	allowedCIDRs     []netip.Prefix
	allowedPorts     map[int]struct{}
	deliveryMode     string
	tunnelBaseURL    string
	tunnelHostSuffix string
	client           *http.Client
}

type leaseDocument struct {
	APIVersion string        `json:"apiVersion"`
	Kind       string        `json:"kind"`
	Metadata   leaseMetadata `json:"metadata"`
	Spec       leaseSpec     `json:"spec"`
}

type leaseMetadata struct {
	Name            string            `json:"name"`
	Namespace       string            `json:"namespace,omitempty"`
	ResourceVersion string            `json:"resourceVersion,omitempty"`
	Labels          map[string]string `json:"labels,omitempty"`
	Annotations     map[string]string `json:"annotations,omitempty"`
}

type leaseSpec struct {
	HolderIdentity       string `json:"holderIdentity,omitempty"`
	LeaseDurationSeconds int32  `json:"leaseDurationSeconds,omitempty"`
	RenewTime            string `json:"renewTime,omitempty"`
}

func NewKubernetesLeaseStore(opts KubernetesLeaseOptions) (*KubernetesLeaseStore, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(opts.BaseURL), "/")
	if _, err := url.ParseRequestURI(baseURL); err != nil || baseURL == "" {
		return nil, errors.New("kubernetes api base url is required")
	}
	namespace := strings.TrimSpace(opts.Namespace)
	if namespace == "" {
		return nil, errors.New("kubernetes namespace is required")
	}
	prefix := strings.TrimSpace(opts.Prefix)
	if prefix == "" {
		prefix = "cloudladdergateway-devroute-"
	}
	allowedCIDRs, err := parsePrefixes(opts.AllowedCIDRs)
	if err != nil || len(allowedCIDRs) == 0 {
		return nil, errors.New("kubernetes lease store requires valid allowed cidrs")
	}
	allowedPorts := make(map[int]struct{}, len(opts.AllowedPorts))
	for _, port := range opts.AllowedPorts {
		if port < 1 || port > 65535 {
			return nil, fmt.Errorf("invalid allowed port %d", port)
		}
		allowedPorts[port] = struct{}{}
	}
	if len(allowedPorts) == 0 {
		return nil, errors.New("kubernetes lease store requires allowed ports")
	}
	deliveryMode := strings.ToLower(strings.TrimSpace(opts.DeliveryMode))
	if deliveryMode == "" {
		deliveryMode = DeliveryModeDirect
	}
	if deliveryMode != DeliveryModeDirect && deliveryMode != DeliveryModeDevtunnel {
		return nil, fmt.Errorf("unsupported delivery mode %q", deliveryMode)
	}
	tunnelBaseURL := strings.TrimRight(strings.TrimSpace(opts.TunnelBaseURL), "/")
	tunnelHostSuffix := normalizeTunnelHostSuffix(opts.TunnelHostSuffix)
	if deliveryMode == DeliveryModeDevtunnel {
		if err := validateTunnelBaseURL(tunnelBaseURL); err != nil {
			return nil, err
		}
		if tunnelHostSuffix == "" {
			return nil, errors.New("devtunnel host suffix is required")
		}
	}
	client := opts.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	return &KubernetesLeaseStore{
		baseURL: baseURL, namespace: namespace, token: strings.TrimSpace(opts.Token),
		tokenFile: strings.TrimSpace(opts.TokenFile), prefix: prefix,
		allowedCIDRs: allowedCIDRs, allowedPorts: allowedPorts, deliveryMode: deliveryMode,
		tunnelBaseURL: tunnelBaseURL, tunnelHostSuffix: tunnelHostSuffix, client: client,
	}, nil
}

func NewInClusterKubernetesLeaseStore(
	namespace string,
	prefix string,
	allowedCIDRs []string,
	allowedPorts []int,
	deliveryMode string,
	tunnelBaseURL string,
	tunnelHostSuffix string,
) (*KubernetesLeaseStore, error) {
	host := strings.TrimSpace(os.Getenv("KUBERNETES_SERVICE_HOST"))
	port := strings.TrimSpace(os.Getenv("KUBERNETES_SERVICE_PORT_HTTPS"))
	if port == "" {
		port = "443"
	}
	if host == "" {
		return nil, errors.New("KUBERNETES_SERVICE_HOST is empty")
	}
	tokenFile := filepath.Join(serviceAccountRoot, "token")
	if _, err := os.Stat(tokenFile); err != nil {
		return nil, fmt.Errorf("stat service account token: %w", err)
	}
	caPEM, err := os.ReadFile(filepath.Join(serviceAccountRoot, "ca.crt"))
	if err != nil {
		return nil, fmt.Errorf("read service account ca: %w", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("parse service account ca")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}
	return NewKubernetesLeaseStore(KubernetesLeaseOptions{
		BaseURL:          "https://" + host + ":" + port,
		Namespace:        namespace,
		TokenFile:        tokenFile,
		Prefix:           prefix,
		AllowedCIDRs:     allowedCIDRs,
		AllowedPorts:     allowedPorts,
		DeliveryMode:     deliveryMode,
		TunnelBaseURL:    tunnelBaseURL,
		TunnelHostSuffix: tunnelHostSuffix,
		Client:           &http.Client{Transport: transport, Timeout: 5 * time.Second},
	})
}

func (s *KubernetesLeaseStore) Ready(ctx context.Context) error {
	_, status, err := s.getLease(ctx, readinessProbeUIN)
	if err != nil {
		return err
	}
	if status != http.StatusOK && status != http.StatusNotFound {
		return fmt.Errorf("kubernetes lease readiness status %d", status)
	}
	return nil
}

func (s *KubernetesLeaseStore) Get(ctx context.Context, uin string) (Registration, error) {
	document, status, err := s.getLease(ctx, uin)
	if err != nil {
		return Registration{}, err
	}
	if status == http.StatusNotFound {
		return Registration{}, ErrNotFound
	}
	if status != http.StatusOK {
		return Registration{}, fmt.Errorf("get kubernetes lease status %d", status)
	}
	return s.registrationFromLease(document, uin)
}

func (s *KubernetesLeaseStore) Upsert(ctx context.Context, registration Registration) error {
	registration.UIN = strings.TrimSpace(registration.UIN)
	registration.UserID = strings.TrimSpace(registration.UserID)
	registration.BaseURL = strings.TrimRight(strings.TrimSpace(registration.BaseURL), "/")
	registration.DeliveryMode = strings.ToLower(strings.TrimSpace(registration.DeliveryMode))
	registration.SourceIP = strings.TrimSpace(registration.SourceIP)
	registration.TunnelHost = strings.ToLower(strings.TrimSpace(registration.TunnelHost))
	registration.TunnelTokenHash = strings.ToLower(strings.TrimSpace(registration.TunnelTokenHash))
	if !validUIN(registration.UIN) || registration.DeliveryMode != s.deliveryMode {
		return errors.New("developer route registration identity or delivery mode is invalid")
	}
	if registration.RenewedAt.IsZero() || registration.TTL <= 0 {
		return errors.New("developer route registration lease time is invalid")
	}
	if err := s.validateStoredTarget(
		registration.UIN,
		registration.DeliveryMode,
		registration.SourceIP,
		registration.Port,
		registration.BaseURL,
		registration.TunnelHost,
		registration.TunnelTokenHash,
	); err != nil {
		return err
	}
	registration.DisabledAt = nil
	for attempt := 0; attempt < 3; attempt++ {
		existing, status, err := s.getLease(ctx, registration.UIN)
		if err != nil {
			return err
		}
		document := leaseFromRegistration(s.leaseName(registration.UIN), s.namespace, registration)
		method := http.MethodPost
		endpoint := s.collectionURL()
		expected := http.StatusCreated
		if status == http.StatusOK {
			document.Metadata.ResourceVersion = existing.Metadata.ResourceVersion
			method = http.MethodPut
			endpoint = s.itemURL(registration.UIN)
			expected = http.StatusOK
		} else if status != http.StatusNotFound {
			return fmt.Errorf("get kubernetes lease status %d", status)
		}
		responseStatus, err := s.writeLease(ctx, method, endpoint, document)
		if err != nil {
			return err
		}
		if responseStatus == expected {
			return nil
		}
		if responseStatus != http.StatusConflict {
			return fmt.Errorf("write kubernetes lease status %d", responseStatus)
		}
	}
	return errors.New("write kubernetes lease conflicted after retries")
}

func (s *KubernetesLeaseStore) Disable(ctx context.Context, uin string, disabledAt time.Time) error {
	for attempt := 0; attempt < 3; attempt++ {
		document, status, err := s.getLease(ctx, uin)
		if err != nil {
			return err
		}
		if status == http.StatusNotFound {
			return ErrNotFound
		}
		if status != http.StatusOK {
			return fmt.Errorf("get kubernetes lease status %d", status)
		}
		if document.Metadata.Annotations == nil {
			document.Metadata.Annotations = map[string]string{}
		}
		document.Metadata.Annotations[annotationDisabled] = disabledAt.UTC().Format(time.RFC3339Nano)
		responseStatus, err := s.writeLease(ctx, http.MethodPut, s.itemURL(uin), document)
		if err != nil {
			return err
		}
		if responseStatus == http.StatusOK {
			return nil
		}
		if responseStatus != http.StatusConflict {
			return fmt.Errorf("disable kubernetes lease status %d", responseStatus)
		}
	}
	return errors.New("disable kubernetes lease conflicted after retries")
}

func (s *KubernetesLeaseStore) getLease(ctx context.Context, uin string) (leaseDocument, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.itemURL(uin), nil)
	if err != nil {
		return leaseDocument{}, 0, err
	}
	if err := s.authorize(req); err != nil {
		return leaseDocument{}, 0, err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return leaseDocument{}, 0, fmt.Errorf("get kubernetes lease: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return leaseDocument{}, resp.StatusCode, nil
	}
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return leaseDocument{}, resp.StatusCode, nil
	}
	var document leaseDocument
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&document); err != nil {
		return leaseDocument{}, 0, fmt.Errorf("decode kubernetes lease: %w", err)
	}
	return document, resp.StatusCode, nil
}

func (s *KubernetesLeaseStore) writeLease(ctx context.Context, method string, endpoint string, document leaseDocument) (int, error) {
	body, err := json.Marshal(document)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	if err := s.authorize(req); err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("write kubernetes lease: %w", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, nil
}

func (s *KubernetesLeaseStore) authorize(req *http.Request) error {
	token := s.token
	if s.tokenFile != "" {
		content, err := os.ReadFile(s.tokenFile)
		if err != nil {
			return fmt.Errorf("read service account token: %w", err)
		}
		token = strings.TrimSpace(string(content))
	}
	if token == "" {
		return errors.New("service account token is empty")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	return nil
}

func (s *KubernetesLeaseStore) collectionURL() string {
	return s.baseURL + "/apis/coordination.k8s.io/v1/namespaces/" + url.PathEscape(s.namespace) + "/leases"
}

func (s *KubernetesLeaseStore) itemURL(uin string) string {
	return s.collectionURL() + "/" + url.PathEscape(s.leaseName(uin))
}

func (s *KubernetesLeaseStore) leaseName(uin string) string {
	hash := sha256.Sum256([]byte(strings.TrimSpace(uin)))
	return strings.TrimRight(s.prefix, "-") + "-" + hex.EncodeToString(hash[:8])
}

func leaseFromRegistration(name string, namespace string, registration Registration) leaseDocument {
	annotations := map[string]string{
		annotationUIN:          registration.UIN,
		annotationUserID:       registration.UserID,
		annotationBaseURL:      registration.BaseURL,
		annotationDeliveryMode: registration.DeliveryMode,
		annotationSourceIP:     registration.SourceIP,
		annotationPort:         strconv.Itoa(registration.Port),
		annotationTunnelHost:   registration.TunnelHost,
		annotationTunnelToken:  registration.TunnelTokenHash,
	}
	if registration.DisabledAt != nil {
		annotations[annotationDisabled] = registration.DisabledAt.UTC().Format(time.RFC3339Nano)
	}
	seconds := int64(registration.TTL / time.Second)
	if seconds > int64(^uint32(0)>>1) {
		seconds = int64(^uint32(0) >> 1)
	}
	return leaseDocument{
		APIVersion: "coordination.k8s.io/v1",
		Kind:       "Lease",
		Metadata: leaseMetadata{
			Name: name, Namespace: namespace,
			Labels: map[string]string{
				managedByLabel:      "cloudladdergateway",
				developerRouteLabel: "developer-route",
			},
			Annotations: annotations,
		},
		Spec: leaseSpec{
			HolderIdentity:       registration.BaseURL,
			LeaseDurationSeconds: int32(seconds),
			RenewTime:            registration.RenewedAt.UTC().Format(time.RFC3339Nano),
		},
	}
}

func (s *KubernetesLeaseStore) registrationFromLease(document leaseDocument, requestedUIN string) (Registration, error) {
	annotations := document.Metadata.Annotations
	uin := strings.TrimSpace(annotations[annotationUIN])
	baseURL := strings.TrimSpace(annotations[annotationBaseURL])
	requestedUIN = strings.TrimSpace(requestedUIN)
	if !validUIN(requestedUIN) || uin != requestedUIN || baseURL == "" || document.Spec.LeaseDurationSeconds <= 0 {
		return Registration{}, errors.New("kubernetes lease is missing developer route fields")
	}
	if document.APIVersion != "coordination.k8s.io/v1" || document.Kind != "Lease" || document.Spec.HolderIdentity != baseURL {
		return Registration{}, errors.New("kubernetes lease document does not match developer route")
	}
	if document.Metadata.Name != s.leaseName(requestedUIN) || document.Metadata.Namespace != s.namespace {
		return Registration{}, errors.New("kubernetes lease metadata does not match developer route")
	}
	if document.Metadata.Labels[managedByLabel] != "cloudladdergateway" || document.Metadata.Labels[developerRouteLabel] != "developer-route" {
		return Registration{}, errors.New("kubernetes lease labels do not match developer route")
	}
	deliveryMode := strings.ToLower(strings.TrimSpace(annotations[annotationDeliveryMode]))
	if deliveryMode != s.deliveryMode {
		return Registration{}, errors.New("kubernetes lease delivery mode does not match gateway")
	}
	sourceIP := strings.TrimSpace(annotations[annotationSourceIP])
	port, err := strconv.Atoi(strings.TrimSpace(annotations[annotationPort]))
	if err != nil {
		return Registration{}, errors.New("kubernetes lease port is invalid")
	}
	tunnelHost := strings.TrimSpace(annotations[annotationTunnelHost])
	tunnelTokenHash := strings.ToLower(strings.TrimSpace(annotations[annotationTunnelToken]))
	if err := s.validateStoredTarget(requestedUIN, deliveryMode, sourceIP, port, baseURL, tunnelHost, tunnelTokenHash); err != nil {
		return Registration{}, err
	}
	renewedAt, err := time.Parse(time.RFC3339Nano, document.Spec.RenewTime)
	if err != nil {
		return Registration{}, fmt.Errorf("parse lease renew time: %w", err)
	}
	registration := Registration{
		UIN: uin, UserID: strings.TrimSpace(annotations[annotationUserID]), BaseURL: baseURL,
		DeliveryMode: deliveryMode, SourceIP: sourceIP, Port: port, TunnelHost: tunnelHost,
		TunnelTokenHash: tunnelTokenHash,
		RenewedAt:       renewedAt, TTL: time.Duration(document.Spec.LeaseDurationSeconds) * time.Second,
	}
	if raw := strings.TrimSpace(annotations[annotationDisabled]); raw != "" {
		disabledAt, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			return Registration{}, fmt.Errorf("parse lease disabled time: %w", err)
		}
		registration.DisabledAt = &disabledAt
	}
	return registration, nil
}

func (s *KubernetesLeaseStore) validateStoredTarget(
	uin string,
	deliveryMode string,
	sourceIP string,
	port int,
	baseURL string,
	tunnelHost string,
	tunnelTokenHash string,
) error {
	address, err := netip.ParseAddr(sourceIP)
	if err != nil {
		return errors.New("kubernetes lease source ip is not allowed")
	}
	address = address.Unmap()
	if address.Zone() != "" || address.String() != sourceIP || !containsAddress(s.allowedCIDRs, address) {
		return errors.New("kubernetes lease source ip is not allowed")
	}
	if _, ok := s.allowedPorts[port]; !ok {
		return errors.New("kubernetes lease port is not allowed")
	}
	switch deliveryMode {
	case DeliveryModeDirect:
		if tunnelHost != "" || tunnelTokenHash != "" {
			return errors.New("direct developer route must not contain tunnel credentials")
		}
		if err := validateDirectBaseURL(baseURL, address, port); err != nil {
			return err
		}
	case DeliveryModeDevtunnel:
		if strings.TrimRight(baseURL, "/") != s.tunnelBaseURL {
			return errors.New("kubernetes lease tunnel base url does not match gateway")
		}
		if tunnelHost != tunnelHostForUIN(uin, s.tunnelHostSuffix) {
			return errors.New("kubernetes lease tunnel host does not match uin")
		}
		if !tunnelcap.ValidDigest(tunnelTokenHash) {
			return errors.New("kubernetes lease tunnel capability digest is invalid")
		}
	default:
		return errors.New("kubernetes lease delivery mode is invalid")
	}
	return nil
}

func validateDirectBaseURL(raw string, expectedAddress netip.Addr, expectedPort int) error {
	parsed, err := url.ParseRequestURI(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("developer route direct base url is invalid")
	}
	if parsed.EscapedPath() != "" {
		return errors.New("developer route direct base url path is not allowed")
	}
	address, err := netip.ParseAddr(parsed.Hostname())
	if err != nil || address.Unmap() != expectedAddress.Unmap() {
		return errors.New("developer route direct base url address does not match source ip")
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port != expectedPort {
		return errors.New("developer route direct base url port does not match registration")
	}
	return nil
}

func validateTunnelBaseURL(raw string) error {
	parsed, err := url.ParseRequestURI(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("devtunnel base url must be an absolute http(s) url without credentials or query")
	}
	if parsed.EscapedPath() != "" {
		return errors.New("devtunnel base url path is not allowed")
	}
	return nil
}

func normalizeTunnelHostSuffix(raw string) string {
	return strings.Trim(strings.ToLower(strings.TrimSpace(raw)), ".")
}

func tunnelHostForUIN(uin string, suffix string) string {
	suffix = normalizeTunnelHostSuffix(suffix)
	if suffix == "" {
		return ""
	}
	return "uin-" + strings.TrimSpace(uin) + "." + suffix
}
