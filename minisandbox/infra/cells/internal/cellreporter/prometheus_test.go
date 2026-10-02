package cellreporter

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPrometheusCapacityCollectsBoundedCellEvidence(t *testing.T) {
	now := time.Date(2026, 8, 21, 10, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		query := request.URL.Query().Get("query")
		if !strings.Contains(query, `cell="actor-bj-k01"`) {
			t.Errorf("query is not Cell-bound: %s", query)
		}
		value := "1"
		switch {
		case strings.HasPrefix(query, "actor:fdb_storage_headroom_bytes"):
			value = "171798691840"
		case strings.HasPrefix(query, "actor_fleet:cell_fdb_logical_bytes"):
			value = "2949563115"
		case strings.HasPrefix(query, "actor:fdb_storage_headroom_samples:6h"):
			value = "720"
		case strings.HasPrefix(query, "actor:fdb_write_utilization:ratio"):
			value = "0.123"
		case strings.HasPrefix(query, "actor:fdb_data_movement_bytes"):
			value = "0"
		case strings.HasPrefix(query, "actor:fdb_storage_headroom_eta_seconds"):
			value = "+Inf"
		}
		_, _ = fmt.Fprintf(w, `{"status":"success","data":{"result":[{"metric":{"cell":"actor-bj-k01"},"value":[%d,%q]}]}}`, now.Unix(), value)
	}))
	defer server.Close()

	reporter := Reporter{Config: Config{CellName: "actor-bj-k01", PrometheusURL: server.URL}, Now: func() time.Time { return now }}
	evidence, err := reporter.prometheusCapacity(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if evidence.HeadroomBytes != 171798691840 || evidence.LogicalBytes != 2949563115 || evidence.HeadroomSamples != 720 ||
		evidence.WriteUtilizationPercent != 13 || evidence.DataMovementBytes != 0 {
		t.Fatalf("unexpected capacity evidence: %#v", evidence)
	}
	if evidence.ETAKnown {
		t.Fatalf("infinite ETA must be represented as unknown/unbounded: %#v", evidence)
	}
}

func TestPrometheusCapacityRejectsAmbiguousOrStaleEvidence(t *testing.T) {
	now := time.Date(2026, 8, 21, 10, 0, 0, 0, time.UTC)
	tests := []struct {
		name   string
		status int
		body   string
	}{
		{name: "duplicate series", status: http.StatusOK, body: fmt.Sprintf(`{"status":"success","data":{"result":[{"metric":{"cell":"actor-bj-k01"},"value":[%d,"1"]},{"metric":{"cell":"actor-bj-k01"},"value":[%d,"1"]}]}}`, now.Unix(), now.Unix())},
		{name: "wrong Cell", status: http.StatusOK, body: fmt.Sprintf(`{"status":"success","data":{"result":[{"metric":{"cell":"actor-bj-k02"},"value":[%d,"1"]}]}}`, now.Unix())},
		{name: "stale sample", status: http.StatusOK, body: fmt.Sprintf(`{"status":"success","data":{"result":[{"metric":{"cell":"actor-bj-k01"},"value":[%d,"1"]}]}}`, now.Add(-3*time.Minute).Unix())},
		{name: "NaN", status: http.StatusOK, body: fmt.Sprintf(`{"status":"success","data":{"result":[{"metric":{"cell":"actor-bj-k01"},"value":[%d,"NaN"]}]}}`, now.Unix())},
		{name: "negative value", status: http.StatusOK, body: fmt.Sprintf(`{"status":"success","data":{"result":[{"metric":{"cell":"actor-bj-k01"},"value":[%d,"-1"]}]}}`, now.Unix())},
		{name: "HTTP failure", status: http.StatusServiceUnavailable, body: `unavailable`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(test.status)
				_, _ = w.Write([]byte(test.body))
			}))
			defer server.Close()
			reporter := Reporter{Config: Config{CellName: "actor-bj-k01", PrometheusURL: server.URL}, Now: func() time.Time { return now }}
			if _, err := reporter.prometheusCapacity(context.Background()); err == nil {
				t.Fatalf("%s evidence was accepted", test.name)
			}
		})
	}
}

func TestPrometheusCapacityRejectsTransportTimeout(t *testing.T) {
	reporter := Reporter{
		Config: Config{CellName: "actor-bj-k01", PrometheusURL: "http://prometheus.invalid"},
		HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return nil, context.DeadlineExceeded
		})},
	}
	if _, err := reporter.prometheusCapacity(context.Background()); err == nil {
		t.Fatal("Prometheus transport timeout was accepted")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestPrometheusCapacityFailsClosedOnMissingSeries(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"success","data":{"result":[]}}`))
	}))
	defer server.Close()
	reporter := Reporter{Config: Config{CellName: "actor-bj-k01", PrometheusURL: server.URL}}
	if _, err := reporter.prometheusCapacity(context.Background()); err == nil {
		t.Fatal("missing Prometheus series was accepted as zero capacity")
	}
}

func TestPrometheusBackupRestorableRequiresBothExactSignals(t *testing.T) {
	now := time.Date(2026, 8, 21, 10, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name, collection, restorable string
		want                         bool
	}{
		{name: "restorable", collection: "1", restorable: "1", want: true},
		{name: "collector failed", collection: "0", restorable: "1"},
		{name: "not restorable", collection: "1", restorable: "0"},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				query := request.URL.Query().Get("query")
				value := test.restorable
				if strings.HasPrefix(query, "actor_fdb_backup_collection_success") {
					value = test.collection
				}
				_, _ = fmt.Fprintf(w, `{"status":"success","data":{"result":[{"metric":{"cell":"actor-bj-k01"},"value":[%d,%q]}]}}`, now.Unix(), value)
			}))
			defer server.Close()
			reporter := Reporter{Config: Config{CellName: "actor-bj-k01", PrometheusURL: server.URL}, Now: func() time.Time { return now }}
			got, err := reporter.prometheusBackupRestorable(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if got != test.want {
				t.Fatalf("restorable=%t, want %t", got, test.want)
			}
		})
	}
}

func TestPrometheusBackupRestorableFailsClosedOnMissingEvidence(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"success","data":{"result":[]}}`))
	}))
	defer server.Close()
	reporter := Reporter{Config: Config{CellName: "actor-bj-k01", PrometheusURL: server.URL}}
	if _, err := reporter.prometheusBackupRestorable(context.Background()); err == nil {
		t.Fatal("missing exact backup evidence was accepted")
	}
}
