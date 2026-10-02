package meshharness

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestFederationEvaluatorOverridesIdentityAndDropsOldSeries(t *testing.T) {
	now := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	body := fmt.Sprintf("rivet_cell_heartbeat_timestamp_seconds{cell=\"actor-a\",cluster=\"forged\"} %d\n", now.Unix())
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/federate" {
			t.Fatalf("path = %s", request.URL.Path)
		}
		fmt.Fprint(response, body)
	}))
	defer server.Close()
	evaluator := FederationEvaluator{Now: func() time.Time { return now }}
	cells, err := evaluator.Scrape(context.Background(), []FederationTarget{{Cluster: "tke-a", URL: server.URL}})
	if err != nil || cells["actor-a"].Cluster != "tke-a" {
		t.Fatalf("trusted target identity was not enforced: %#v %v", cells, err)
	}

	body = ""
	restarted := FederationEvaluator{Now: func() time.Time { return now.Add(time.Minute) }}
	cells, err = restarted.Scrape(context.Background(), []FederationTarget{{Cluster: "tke-a", URL: server.URL}})
	if err != nil || len(cells) != 0 {
		t.Fatalf("deleted Cell survived a Hub restart scrape: %#v %v", cells, err)
	}
}

func TestFederationEvaluatorRejectsDuplicateAndTargetFailure(t *testing.T) {
	now := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	server := func(status int) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			response.WriteHeader(status)
			if status == http.StatusOK {
				fmt.Fprintf(response, "rivet_cell_heartbeat_timestamp_seconds{cell=\"same\"} %d\n", now.Unix())
			}
		}))
	}
	a, b := server(http.StatusOK), server(http.StatusOK)
	defer a.Close()
	defer b.Close()
	evaluator := FederationEvaluator{Now: func() time.Time { return now }}
	if _, err := evaluator.Scrape(context.Background(), []FederationTarget{{Cluster: "a", URL: a.URL}, {Cluster: "b", URL: b.URL}}); err == nil {
		t.Fatal("duplicate Cell identity across TKE environments was accepted")
	}
	failing := server(http.StatusInternalServerError)
	defer failing.Close()
	if _, err := evaluator.Scrape(context.Background(), []FederationTarget{{Cluster: "a", URL: failing.URL}}); err == nil {
		t.Fatal("failed spoke scrape was interpreted as zero capacity")
	}
}
