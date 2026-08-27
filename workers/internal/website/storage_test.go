package website

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/tencentyun/cos-go-sdk-v5"
)

func TestSumObjectSizes(t *testing.T) {
	objects := []cos.Object{
		{Key: "sites/ws-1/current/index.html", Size: 1024},
		{Key: "sites/ws-1/current/app.js", Size: 2048},
		{Key: "_artifacts/ws-1/wr-1.zip", Size: 4096},
	}
	if got := sumObjectSizes(objects); got != 7168 {
		t.Fatalf("合计 = %d，期望 7168", got)
	}
	if got := sumObjectSizes(nil); got != 0 {
		t.Fatalf("空列表合计 = %d，期望 0", got)
	}
	if got := sumObjectSizes([]cos.Object{{Key: "x", Size: -5}, {Key: "y", Size: 10}}); got != 10 {
		t.Fatalf("含负数时合计 = %d，期望 10", got)
	}
}

func TestReportSiteStoragePostsAbsoluteValue(t *testing.T) {
	var gotPath, gotToken string
	var gotBody struct {
		StorageBytes int64 `json:"storage_bytes"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotToken = r.Header.Get("X-Internal-Token")
		if r.Method != http.MethodPost {
			t.Errorf("方法 = %s，期望 POST", r.Method)
		}
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Errorf("decode body: %v", err)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	d := &Deployer{
		ctlBaseURL:    server.URL,
		httpClient:    server.Client(),
		internalToken: "secret-token",
	}
	if err := d.reportSiteStorage("ws-464eb1f654cd5d91", 987654); err != nil {
		t.Fatalf("reportSiteStorage: %v", err)
	}
	if gotPath != "/internal/ctl/websites/sites/ws-464eb1f654cd5d91/storage" {
		t.Fatalf("上报路径 = %q", gotPath)
	}
	if gotToken != "secret-token" {
		t.Fatalf("X-Internal-Token = %q", gotToken)
	}
	if gotBody.StorageBytes != 987654 {
		t.Fatalf("storage_bytes = %d，期望 987654", gotBody.StorageBytes)
	}
}

func TestReportSiteStorageTreatsNon2xxAsFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	d := &Deployer{ctlBaseURL: server.URL, httpClient: server.Client()}
	if err := d.reportSiteStorage("ws-1", 100); err == nil {
		t.Fatal("401 必须返回错误")
	}
}

func TestRefreshSiteStorageSwallowsFailures(t *testing.T) {
	d := &Deployer{ctlBaseURL: "http://127.0.0.1:1", httpClient: &http.Client{Timeout: time.Second}}
	d.refreshSiteStorage(nil, "ws-1")
	d.refreshSiteStorage(&cosClient{}, "")
}
