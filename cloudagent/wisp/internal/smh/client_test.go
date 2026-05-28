package smh

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIssueToken(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		_ = json.NewEncoder(w).Encode(TokenResponse{AccessToken: "tok", ExpiresIn: 600})
	}))
	defer srv.Close()

	client, err := NewClient(srv.URL, "lib", "secret", srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	out, err := client.IssueToken(context.Background(), TokenRequest{
		SpaceID:       "space-1",
		Grant:         []string{"create_space", "space_admin"},
		PeriodSeconds: 600,
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.AccessToken != "tok" {
		t.Fatalf("token=%q", out.AccessToken)
	}
	for _, want := range []string{"library_id=lib", "library_secret=secret", "space_id=space-1", "grant=create_space%2Cspace_admin", "period=600"} {
		if !strings.Contains(gotQuery, want) {
			t.Fatalf("query %q missing %q", gotQuery, want)
		}
	}
}

func TestIssueTokenOmitsEmptySpaceID(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		_ = json.NewEncoder(w).Encode(TokenResponse{AccessToken: "tok", ExpiresIn: 600})
	}))
	defer srv.Close()

	client, err := NewClient(srv.URL, "lib", "secret", srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.IssueToken(context.Background(), TokenRequest{
		Grant:         []string{"create_space"},
		PeriodSeconds: 600,
	}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(gotQuery, "space_id=") {
		t.Fatalf("query %q unexpectedly included space_id", gotQuery)
	}
}

func TestCreateSpace(t *testing.T) {
	var gotPath string
	var gotBody CreateSpaceRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.String()
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatal(err)
		}
		_ = json.NewEncoder(w).Encode(CreateSpaceResponse{SpaceID: "space-new"})
	}))
	defer srv.Close()

	client, err := NewClient(srv.URL, "lib", "secret", srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	flag := true
	out, err := client.CreateSpace(context.Background(), "tok", CreateSpaceRequest{
		SpaceTag:   "workspace-a",
		AllowPhoto: &flag,
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.SpaceID != "space-new" {
		t.Fatalf("space=%q", out.SpaceID)
	}
	if !strings.Contains(gotPath, "/api/v1/space/lib?access_token=tok") {
		t.Fatalf("path=%q", gotPath)
	}
	if gotBody.SpaceTag != "workspace-a" {
		t.Fatalf("body=%+v", gotBody)
	}
	if gotBody.AllowPhoto == nil || !*gotBody.AllowPhoto {
		t.Fatalf("body=%+v", gotBody)
	}
}

func TestNewClientRejectsInsecureNonLocalDomain(t *testing.T) {
	_, err := NewClient("http://example.com", "lib", "secret", nil)
	if err == nil {
		t.Fatal("expected https enforcement error")
	}
}
