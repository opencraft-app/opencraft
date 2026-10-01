package main

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestListenerRequiresTLSOutsideLoopback(t *testing.T) {
	for _, addr := range []string{"10.15.225.38:8090", "0.0.0.0:8090", ":8090", "[::]:8090", "localhost:8090", "invalid"} {
		t.Run(addr, func(t *testing.T) {
			if _, err := listenerTLS(addr, "", ""); err == nil {
				t.Fatal("accepted non-literal-loopback plaintext listener")
			}
		})
	}
	for _, addr := range []string{"127.0.0.1:8090", "[::1]:8090"} {
		config, err := listenerTLS(addr, "", "")
		if err != nil || config != nil {
			t.Fatalf("loopback HTTP: %v", err)
		}
	}
}
func TestListenerRejectsPartialOrInvalidTLS(t *testing.T) {
	for _, pair := range [][2]string{{"cert", ""}, {"", "key"}, {"missing-cert", "missing-key"}} {
		if _, err := listenerTLS("127.0.0.1:8090", pair[0], pair[1]); err == nil {
			t.Fatal("invalid TLS fell back to plaintext")
		}
	}
}
func TestMinimumTLSVersion(t *testing.T) {
	if minimumTLSVersion != tls.VersionTLS12 {
		t.Fatal("unexpected TLS minimum")
	}
}

func TestTLSListenerHandshakeAndPrivateKeyPermissions(t *testing.T) {
	seed := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer seed.Close()
	dir := t.TempDir()
	certPath, keyPath := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	cert := seed.TLS.Certificates[0]
	key, err := x509.MarshalPKCS8PrivateKey(cert.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Certificate[0]}), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}), 0600); err != nil {
		t.Fatal(err)
	}
	config, err := listenerTLS("10.15.225.38:8090", certPath, keyPath)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	server.TLS = config
	server.StartTLS()
	defer server.Close()
	roots := x509.NewCertPool()
	roots.AddCert(seed.Certificate())
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}}}
	defer client.CloseIdleConnections()
	response, err := client.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusNoContent || response.TLS == nil {
		t.Fatal("not a successful verified TLS request")
	}
	if err := os.Chmod(keyPath, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := listenerTLS("127.0.0.1:8090", certPath, keyPath); err == nil {
		t.Fatal("accepted publicly readable private key")
	}
	if err := os.Chmod(keyPath, 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "key-link.pem")
	if err := os.Symlink(keyPath, link); err != nil {
		t.Fatal(err)
	}
	if _, err := listenerTLS("127.0.0.1:8090", certPath, link); err == nil {
		t.Fatal("accepted symlink key")
	}
}
