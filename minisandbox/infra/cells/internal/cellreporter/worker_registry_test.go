package cellreporter

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWorkerRegistryPlacementCount(t *testing.T) {
	const cell = "actor-bj-a01"
	const uid = "cell-uid"
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/v1/cells/"+cell+"/placement-count" || request.URL.Query().Get("cell_uid") != uid {
			t.Fatalf("unexpected request URL %s", request.URL.String())
		}
		writer.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(writer, `{"schema":"%s","cell_name":"%s","cell_uid":"%s","count":17,"shards":64}`, placementCountSchema, cell, uid)
	}))
	defer server.Close()
	reporter := Reporter{Config: Config{WorkerRegistryURL: server.URL}, HTTP: server.Client()}
	count, err := reporter.workerRegistryPlacementCount(context.Background(), cell, uid)
	if err != nil || count != 17 {
		t.Fatalf("count=%d err=%v", count, err)
	}
}

func TestWorkerRegistryPlacementCountFailsClosed(t *testing.T) {
	for _, body := range []string{
		`{"schema":"wrong","cell_name":"actor-bj-a01","cell_uid":"cell-uid","count":1,"shards":64}`,
		`{"schema":"rivet-worker-cell-placement-count/v1","cell_name":"actor-bj-b01","cell_uid":"cell-uid","count":1,"shards":64}`,
		`{"schema":"rivet-worker-cell-placement-count/v1","cell_name":"actor-bj-a01","cell_uid":"cell-uid","count":-1,"shards":64}`,
		`{"schema":"rivet-worker-cell-placement-count/v1","cell_name":"actor-bj-a01","cell_uid":"cell-uid","count":1,"shards":1}`,
		`{"schema":"rivet-worker-cell-placement-count/v1","cell_name":"actor-bj-a01","cell_uid":"cell-uid","count":1,"shards":64,"extra":true}`,
		`not-json`,
	} {
		t.Run(strings.ReplaceAll(body[:min(len(body), 12)], "\"", ""), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) { _, _ = writer.Write([]byte(body)) }))
			defer server.Close()
			reporter := Reporter{Config: Config{WorkerRegistryURL: server.URL}, HTTP: server.Client()}
			if _, err := reporter.workerRegistryPlacementCount(context.Background(), "actor-bj-a01", "cell-uid"); err == nil {
				t.Fatalf("invalid response accepted: %s", body)
			}
		})
	}
}

func TestValidateWorkerRegistryURL(t *testing.T) {
	if err := validateWorkerRegistryURL("http://registry.internal:8080"); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"", "registry:8080", "ftp://registry", "http://registry/path?q=1", "http://registry/#fragment"} {
		if err := validateWorkerRegistryURL(value); err == nil {
			t.Fatalf("invalid URL accepted: %q", value)
		}
	}
}
