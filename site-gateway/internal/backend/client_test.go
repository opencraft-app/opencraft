package backend

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientDoesNotFollowCredentialRedirect(t *testing.T) {
	hits := 0
	victim := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++ }))
	defer victim.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, victim.URL, 302) }))
	defer redirect.Close()
	c, err := New(redirect.URL, "internal")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Invoke(context.Background(), "ws-a", "wr-a", Invocation{SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}); err == nil {
		t.Fatal("redirect accepted")
	}
	if hits != 0 {
		t.Fatal("internal credential followed redirect")
	}
}
func TestClientPreservesApplicationErrorWithoutStaticFallback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(Result{Status: 422, Body: []byte("bad input")})
	}))
	defer server.Close()
	c, err := New(server.URL, "internal")
	if err != nil {
		t.Fatal(err)
	}
	result, err := c.Invoke(context.Background(), "ws-a", "wr-a", Invocation{SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"})
	if err != nil || result.Status != 422 || string(result.Body) != "bad input" {
		t.Fatal("application error changed")
	}
}
