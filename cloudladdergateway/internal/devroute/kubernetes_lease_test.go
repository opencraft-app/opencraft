package devroute

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestKubernetesLeaseStoreSharesRegistrationAndPreservesTombstone(t *testing.T) {
	var mu sync.Mutex
	var saved map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Fatalf("authorization = %q", r.Header.Get("Authorization"))
		}
		mu.Lock()
		defer mu.Unlock()
		switch r.Method {
		case http.MethodGet:
			if saved == nil {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_ = json.NewEncoder(w).Encode(saved)
		case http.MethodPost:
			if !strings.HasSuffix(r.URL.Path, "/leases") {
				t.Fatalf("create path = %q", r.URL.Path)
			}
			if err := json.NewDecoder(r.Body).Decode(&saved); err != nil {
				t.Fatal(err)
			}
			saved["metadata"].(map[string]any)["resourceVersion"] = "1"
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(saved)
		case http.MethodPut:
			if err := json.NewDecoder(r.Body).Decode(&saved); err != nil {
				t.Fatal(err)
			}
			saved["metadata"].(map[string]any)["resourceVersion"] = "2"
			_ = json.NewEncoder(w).Encode(saved)
		default:
			t.Fatalf("unexpected method %s", r.Method)
		}
	}))
	defer server.Close()

	store, err := NewKubernetesLeaseStore(KubernetesLeaseOptions{
		BaseURL:      server.URL,
		Namespace:    "testing",
		Token:        "test-token",
		Prefix:       "clg-devroute-",
		AllowedCIDRs: []string{"9.0.0.0/8"},
		AllowedPorts: []int{18084},
		DeliveryMode: DeliveryModeDirect,
		Client:       server.Client(),
	})
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	store2, err := NewKubernetesLeaseStore(KubernetesLeaseOptions{
		BaseURL:      server.URL,
		Namespace:    "testing",
		Token:        "test-token",
		Prefix:       "clg-devroute-",
		AllowedCIDRs: []string{"9.0.0.0/8"},
		AllowedPorts: []int{18084},
		DeliveryMode: DeliveryModeDirect,
		Client:       server.Client(),
	})
	if err != nil {
		t.Fatalf("new second store: %v", err)
	}
	now := time.Date(2026, 9, 8, 10, 0, 0, 123000000, time.UTC)
	want := Registration{
		UIN: "450860000013", UserID: "usr_dev", BaseURL: "http://9.134.214.121:18084",
		DeliveryMode: DeliveryModeDirect, SourceIP: "9.134.214.121", Port: 18084,
		RenewedAt: now, TTL: 8 * time.Hour,
	}
	if err := store.Upsert(context.Background(), want); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	got, err := store2.Get(context.Background(), want.UIN)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.UIN != want.UIN || got.UserID != want.UserID || got.BaseURL != want.BaseURL || got.TTL != want.TTL || !got.RenewedAt.Equal(want.RenewedAt) {
		t.Fatalf("registration = %+v, want %+v", got, want)
	}

	disabledAt := now.Add(time.Hour)
	if err := store2.Disable(context.Background(), want.UIN, disabledAt); err != nil {
		t.Fatalf("disable: %v", err)
	}
	disabled, err := store.Get(context.Background(), want.UIN)
	if err != nil {
		t.Fatalf("get disabled: %v", err)
	}
	if disabled.DisabledAt == nil || !disabled.DisabledAt.Equal(disabledAt) || disabled.State(disabledAt) != StateDisabled {
		t.Fatalf("disabled registration = %+v", disabled)
	}
}

func TestKubernetesLeaseStoreReloadsProjectedTokenForEveryRequest(t *testing.T) {
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("token-a\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var got []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = append(got, r.Header.Get("Authorization"))
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()
	store, err := NewKubernetesLeaseStore(KubernetesLeaseOptions{
		BaseURL: server.URL, Namespace: "testing", TokenFile: tokenFile,
		AllowedCIDRs: []string{"9.0.0.0/8"}, AllowedPorts: []int{18084},
		DeliveryMode: DeliveryModeDirect, Client: server.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Ready(context.Background()); err != nil {
		t.Fatalf("ready with token-a: %v", err)
	}
	if err := os.WriteFile(tokenFile, []byte("token-b\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.Ready(context.Background()); err != nil {
		t.Fatalf("ready with token-b: %v", err)
	}
	want := []string{"Bearer token-a", "Bearer token-b"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("authorization headers = %#v, want %#v", got, want)
	}
}

func TestKubernetesLeaseStoreRetriesWriteConflict(t *testing.T) {
	writes := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			w.WriteHeader(http.StatusNotFound)
		case http.MethodPost:
			writes++
			if writes == 1 {
				w.WriteHeader(http.StatusConflict)
				return
			}
			w.WriteHeader(http.StatusCreated)
		default:
			t.Fatalf("unexpected method %s", r.Method)
		}
	}))
	defer server.Close()
	store, err := NewKubernetesLeaseStore(KubernetesLeaseOptions{
		BaseURL: server.URL, Namespace: "testing", Token: "test-token",
		AllowedCIDRs: []string{"9.0.0.0/8"}, AllowedPorts: []int{18084},
		DeliveryMode: DeliveryModeDirect, Client: server.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	err = store.Upsert(context.Background(), Registration{
		UIN: "450860000013", BaseURL: "http://9.134.214.121:18084",
		DeliveryMode: DeliveryModeDirect, SourceIP: "9.134.214.121", Port: 18084,
		RenewedAt: time.Now().UTC(), TTL: time.Hour,
	})
	if err != nil {
		t.Fatalf("upsert after conflict: %v", err)
	}
	if writes != 2 {
		t.Fatalf("writes = %d, want 2", writes)
	}
}

func TestKubernetesLeaseStoreRejectsTamperedLease(t *testing.T) {
	directStore, err := NewKubernetesLeaseStore(KubernetesLeaseOptions{
		BaseURL: "https://kubernetes.test", Namespace: "testing", Token: "test-token",
		Prefix: "clg-devroute-", AllowedCIDRs: []string{"9.0.0.0/8"}, AllowedPorts: []int{18084},
		DeliveryMode: DeliveryModeDirect,
	})
	if err != nil {
		t.Fatal(err)
	}
	registration := Registration{
		UIN: "450860000013", BaseURL: "http://9.134.214.121:18084",
		DeliveryMode: DeliveryModeDirect, SourceIP: "9.134.214.121", Port: 18084,
		RenewedAt: time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC), TTL: time.Hour,
	}
	original := leaseFromRegistration(directStore.leaseName(registration.UIN), "testing", registration)
	if _, err := directStore.registrationFromLease(original, registration.UIN); err != nil {
		t.Fatalf("valid lease rejected: %v", err)
	}
	tests := []struct {
		name   string
		mutate func(*leaseDocument)
	}{
		{name: "uin annotation", mutate: func(doc *leaseDocument) { doc.Metadata.Annotations[annotationUIN] = "450860000014" }},
		{name: "lease name", mutate: func(doc *leaseDocument) { doc.Metadata.Name = "clg-devroute-other" }},
		{name: "namespace", mutate: func(doc *leaseDocument) { doc.Metadata.Namespace = "production" }},
		{name: "managed label", mutate: func(doc *leaseDocument) { doc.Metadata.Labels[managedByLabel] = "attacker" }},
		{name: "document kind", mutate: func(doc *leaseDocument) { doc.Kind = "Secret" }},
		{name: "holder identity", mutate: func(doc *leaseDocument) { doc.Spec.HolderIdentity = "http://9.134.214.122:18084" }},
		{name: "https scheme", mutate: func(doc *leaseDocument) { setLeaseBaseURL(doc, "https://9.134.214.121:18084") }},
		{name: "source outside cidr", mutate: func(doc *leaseDocument) {
			doc.Metadata.Annotations[annotationSourceIP] = "203.0.113.9"
			setLeaseBaseURL(doc, "http://203.0.113.9:18084")
		}},
		{name: "non canonical source ip", mutate: func(doc *leaseDocument) {
			doc.Metadata.Annotations[annotationSourceIP] = "::ffff:9.134.214.121"
			setLeaseBaseURL(doc, "http://[::ffff:9.134.214.121]:18084")
		}},
		{name: "port", mutate: func(doc *leaseDocument) {
			doc.Metadata.Annotations[annotationPort] = "3306"
			setLeaseBaseURL(doc, "http://9.134.214.121:3306")
		}},
		{name: "url path", mutate: func(doc *leaseDocument) { setLeaseBaseURL(doc, "http://9.134.214.121:18084/private") }},
		{name: "root url path", mutate: func(doc *leaseDocument) { setLeaseBaseURL(doc, "http://9.134.214.121:18084/") }},
		{name: "url query", mutate: func(doc *leaseDocument) { setLeaseBaseURL(doc, "http://9.134.214.121:18084?next=private") }},
		{name: "url userinfo", mutate: func(doc *leaseDocument) { setLeaseBaseURL(doc, "http://user@9.134.214.121:18084") }},
		{name: "delivery mode", mutate: func(doc *leaseDocument) { doc.Metadata.Annotations[annotationDeliveryMode] = DeliveryModeDevtunnel }},
		{name: "unexpected tunnel host", mutate: func(doc *leaseDocument) {
			doc.Metadata.Annotations[annotationTunnelHost] = "uin-450860000013.tunnel.internal"
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			doc := cloneLeaseDocument(t, original)
			tc.mutate(&doc)
			if got, err := directStore.registrationFromLease(doc, registration.UIN); err == nil {
				t.Fatalf("tampered lease accepted: %+v", got)
			}
		})
	}
}

func TestKubernetesLeaseStoreValidatesDevtunnelLease(t *testing.T) {
	store, err := NewKubernetesLeaseStore(KubernetesLeaseOptions{
		BaseURL: "https://kubernetes.test", Namespace: "testing", Token: "test-token",
		AllowedCIDRs: []string{"9.0.0.0/8"}, AllowedPorts: []int{18084},
		DeliveryMode: DeliveryModeDevtunnel, TunnelBaseURL: "http://devtunnel.testing",
		TunnelHostSuffix: "tunnel.internal",
	})
	if err != nil {
		t.Fatal(err)
	}
	registration := Registration{
		UIN: "450860000013", BaseURL: "http://devtunnel.testing",
		DeliveryMode: DeliveryModeDevtunnel, SourceIP: "9.134.214.121", Port: 18084,
		TunnelHost:      "uin-450860000013.tunnel.internal",
		TunnelTokenHash: strings.Repeat("a", 64),
		RenewedAt:       time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC), TTL: time.Hour,
	}
	original := leaseFromRegistration(store.leaseName(registration.UIN), "testing", registration)
	if _, err := store.registrationFromLease(original, registration.UIN); err != nil {
		t.Fatalf("valid devtunnel lease rejected: %v", err)
	}
	wrongHost := cloneLeaseDocument(t, original)
	wrongHost.Metadata.Annotations[annotationTunnelHost] = "uin-450860000014.tunnel.internal"
	if _, err := store.registrationFromLease(wrongHost, registration.UIN); err == nil {
		t.Fatal("wrong tunnel host accepted")
	}
	wrongHub := cloneLeaseDocument(t, original)
	setLeaseBaseURL(&wrongHub, "http://attacker.testing")
	if _, err := store.registrationFromLease(wrongHub, registration.UIN); err == nil {
		t.Fatal("wrong tunnel hub accepted")
	}
}

func setLeaseBaseURL(document *leaseDocument, baseURL string) {
	document.Metadata.Annotations[annotationBaseURL] = baseURL
	document.Spec.HolderIdentity = baseURL
}

func cloneLeaseDocument(t *testing.T, original leaseDocument) leaseDocument {
	t.Helper()
	body, err := json.Marshal(original)
	if err != nil {
		t.Fatal(err)
	}
	var clone leaseDocument
	if err := json.Unmarshal(body, &clone); err != nil {
		t.Fatal(err)
	}
	return clone
}
