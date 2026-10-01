//go:build websiteintegration

package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"hash/crc64"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	logic "ctl/pkg/logic/website"
	"ctl/pkg/model/bundle"
	"ctl/pkg/model/pass"
	quota "ctl/pkg/model/userresourcequota"
	model "ctl/pkg/model/website"
	"ctl/pkg/resource"
	"ctl/test/testutil"
	"git.woa.com/wisp/mono/site-gateway/internal/backend"
	"git.woa.com/wisp/mono/site-gateway/internal/hostroute"
	"git.woa.com/wisp/mono/site-gateway/internal/origin"
	"git.woa.com/wisp/mono/site-gateway/internal/siteauth"
	"git.woa.com/wisp/mono/site-gateway/internal/sitemeta"
	"github.com/lightclaw/tencent-rescue-exporter/websiteintegration"
)

type localCOS struct {
	sync.Mutex
	objects  map[string][]byte
	metadata map[string]string
}

func (c *localCOS) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	c.Lock()
	defer c.Unlock()
	key := strings.TrimPrefix(r.URL.Path, "/")
	if r.Method == "GET" && key == "" {
		type entry struct {
			Key          string
			Size         int
			LastModified string
		}
		var response struct {
			XMLName     xml.Name `xml:"ListBucketResult"`
			IsTruncated bool
			Contents    []entry
		}
		keys := make([]string, 0)
		for key := range c.objects {
			if strings.HasPrefix(key, r.URL.Query().Get("prefix")) {
				keys = append(keys, key)
			}
		}
		sort.Strings(keys)
		for _, key := range keys {
			response.Contents = append(response.Contents, entry{Key: key, Size: len(c.objects[key]), LastModified: "2026-09-29T00:00:00.000Z"})
		}
		w.Header().Set("Content-Type", "application/xml")
		_ = xml.NewEncoder(w).Encode(response)
		return
	}
	if r.Method == "POST" && r.URL.Query().Has("delete") {
		var body struct {
			Objects []struct{ Key string } `xml:"Object"`
		}
		_ = xml.NewDecoder(r.Body).Decode(&body)
		for _, object := range body.Objects {
			delete(c.objects, object.Key)
			delete(c.metadata, object.Key)
		}
		_, _ = io.WriteString(w, "<DeleteResult/>")
		return
	}
	switch r.Method {
	case "PUT":
		data, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "read failed", 500)
			return
		}
		c.objects[key] = data
		c.metadata[key] = r.Header.Get("x-cos-meta-artifact-sha256")
		w.Header().Set("x-cos-hash-crc64ecma", strconv.FormatUint(crc64.Checksum(data, crc64.MakeTable(crc64.ECMA)), 10))
		w.WriteHeader(200)
	case "GET", "HEAD":
		data, ok := c.objects[key]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.Header().Set("x-cos-meta-artifact-sha256", c.metadata[key])
		w.WriteHeader(200)
		if r.Method == "GET" {
			_, _ = w.Write(data)
		}
	case "DELETE":
		delete(c.objects, key)
		delete(c.metadata, key)
		w.WriteHeader(204)
	default:
		w.WriteHeader(405)
	}
}
func (c *localCOS) Get(_ context.Context, key string) (*origin.Object, error) {
	c.Lock()
	defer c.Unlock()
	data, ok := c.objects[key]
	if !ok {
		return nil, origin.ErrNotFound
	}
	return &origin.Object{Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), ContentType: "text/html"}, nil
}
func integrationHash(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

// This is a cross-service logic/transport test, NOT live COS or production OIDC
// acceptance. COS is emulated; the runtime is a real Linux/runsc service.
func TestFullstackReleaseGatewayRuntimeIntegration(t *testing.T) {
	runtimeURL := os.Getenv("WEBSITE_E2E_RUNTIME_URL")
	if runtimeURL == "" {
		t.Skip("requires dedicated local Linux/runsc runtime")
	}
	const deployToken = "local-e2e-deploy-credential-not-production"
	const invokeToken = "local-e2e-invoke-credential-not-production"
	const user = "user-e2e"
	siteID := fmt.Sprintf("ws-e2e-%x", time.Now().UnixNano())
	host := siteID + ".lightvela.tech"
	t.Setenv("WEBSITE_RUNTIME_BASE_URL", runtimeURL)
	t.Setenv("WEBSITE_RUNTIME_DEPLOY_TOKEN", deployToken)
	t.Setenv("WEBSITE_BACKEND_BETA_USERS", user)
	t.Setenv("WEBSITE_COS_BUCKET", "test-bucket-1000")
	t.Setenv("WEBSITE_COS_REGION", "ap-test")
	t.Setenv("WEBSITE_COS_SECRET_ID", "test-only-id")
	t.Setenv("WEBSITE_COS_SECRET_KEY", "test-only-key")
	db := testutil.NewSQLiteDB(t, &model.SiteEntity{}, &model.ReleaseEntity{}, &model.OperationEntity{}, &model.UsageDailyEntity{}, &quota.Entity{}, &pass.Entity{}, &bundle.Entity{})
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	b := bundle.Entity{BundleID: "bundle-e2e", StaticSiteQuota: `{"max_sites":3,"monthly_traffic_bytes":10000000,"storage_bytes":100000000,"max_artifact_size":1000000,"max_files":100}`}
	p := pass.Entity{PassID: "pass-e2e", UserID: user, BundleID: b.BundleID, ExpiredTime: time.Now().Add(time.Hour), Status: pass.StatusActive}
	site := model.SiteEntity{SiteID: siteID, BundleID: b.BundleID, Status: model.SiteStatusActive, OperationGeneration: 1}
	site.UserID = user
	q := quota.Entity{UserID: user, ResourceName: model.ResourceNameWebsiteSite, ResourceKey: b.BundleID, ResourceQuotaTotal: 3, ResourceQuotaAvailable: 2}
	for _, value := range []any{&b, &p, &site, &q} {
		if err := db.Create(value).Error; err != nil {
			t.Fatal(err)
		}
	}
	control := logic.NewLogic()
	ctl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var data any
		var err error
		path := strings.TrimPrefix(r.URL.Path, "/internal/ctl/websites/")
		parts := strings.Split(path, "/")
		switch {
		case len(parts) == 2 && parts[0] == "sites":
			data, err = control.GetSiteInternal(parts[1])
		case len(parts) == 3 && parts[0] == "sites" && parts[2] == "storage":
			var payload struct {
				Bytes int64 `json:"storage_bytes"`
			}
			_ = json.NewDecoder(r.Body).Decode(&payload)
			err = control.UpdateSiteStorage(parts[1], payload.Bytes)
		case len(parts) == 3 && parts[0] == "operations":
			switch parts[2] {
			case "claim":
				op, claimed, e := control.ClaimOperation(parts[1], "integration-worker", time.Minute)
				err = e
				data = map[string]any{"operation": op, "claimed": claimed}
			case "complete":
				var p struct {
					Lease string `json:"lease_token"`
					Path  string `json:"cloud_path"`
					URL   string `json:"public_url"`
				}
				_ = json.NewDecoder(r.Body).Decode(&p)
				err = control.CompleteOperation(parts[1], p.Lease, p.Path, p.URL)
			case "fail":
				var p struct {
					Lease string `json:"lease_token"`
					Error string `json:"error_message"`
				}
				_ = json.NewDecoder(r.Body).Decode(&p)
				err = control.FailOperation(parts[1], p.Lease, p.Error)
			default:
				err = fmt.Errorf("unexpected operation")
			}
		default:
			err = fmt.Errorf("unexpected control request")
		}
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"code": "OK", "data": data})
	}))
	defer ctl.Close()
	cos := &localCOS{objects: map[string][]byte{}, metadata: map[string]string{}}
	cosHTTP := httptest.NewServer(cos)
	defer cosHTTP.Close()
	worker, err := websiteintegration.New(ctl.URL, cosHTTP.URL, runtimeURL, deployToken)
	if err != nil {
		t.Fatal(err)
	}
	run := func(operationID string) error {
		op, ok, err := worker.ClaimOperation(operationID)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("operation not claimed")
		}
		return worker.Execute(*op)
	}
	publish := func(code string, wantSuccess bool) string {
		t.Helper()
		var artifact bytes.Buffer
		zw := zip.NewWriter(&artifact)
		for name, body := range map[string]string{"index.html": "<html><script>globalThis.__LIGHTVELA_RELEASE_ID__='__LIGHTVELA_RELEASE_ID__'</script></html>", "__backend/app.mjs": code} {
			f, e := zw.Create(name)
			if e != nil {
				t.Fatal(e)
			}
			_, _ = io.WriteString(f, body)
		}
		if err := zw.Close(); err != nil {
			t.Fatal(err)
		}
		result, err := control.CreateRelease(user, siteID, logic.CreateReleaseRequest{Kind: "fullstack", BackendSHA256: integrationHash([]byte(code)), ArtifactHash: integrationHash(artifact.Bytes()), ArtifactSize: int64(artifact.Len()), FileCount: 2})
		if err != nil {
			t.Fatal(err)
		}
		request, _ := http.NewRequest("PUT", cosHTTP.URL+"/_artifacts/"+siteID+"/"+result.ReleaseID+".zip", bytes.NewReader(artifact.Bytes()))
		request.Header.Set("x-cos-meta-artifact-sha256", integrationHash(artifact.Bytes()))
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != 200 {
			t.Fatal("fixture upload failed")
		}
		err = run(result.OperationID)
		if wantSuccess && err != nil {
			t.Fatal(err)
		}
		if !wantSuccess && err == nil {
			t.Fatal("invalid backend activated")
		}
		operation, err := control.GetOperation(user, result.OperationID)
		if err != nil {
			t.Fatal(err)
		}
		if wantSuccess && operation.Status != model.OpStatusSuccess {
			t.Fatalf("operation not terminal success: %s", operation.Status)
		}
		cos.Lock()
		for key := range cos.objects {
			if strings.Contains(key, "__backend") {
				t.Error("backend source escaped into COS")
			}
		}
		cos.Unlock()
		return result.ReleaseID
	}
	code := `export default {async fetch(r){const {a,b}=await r.json();return Response.json({sum:a+b})}}`
	v1 := publish(code, true)
	client, err := backend.New(runtimeURL, invokeToken)
	if err != nil {
		t.Fatal(err)
	}
	codec, err := siteauth.NewTokenCodec(siteauth.TokenCodecConfig{ActiveKeyID: "test", Keys: map[string][]byte{"test": []byte("0123456789abcdef0123456789abcdef")}})
	if err != nil {
		t.Fatal(err)
	}
	token, err := codec.SealSession(siteauth.SessionClaims{SiteID: siteID, SiteHost: host, UserID: user, Nonce: "e2e"})
	if err != nil {
		t.Fatal(err)
	}
	metadata := sitemeta.NewClient(sitemeta.Options{BaseURL: ctl.URL, PositiveTTL: time.Nanosecond})
	gateway := httptest.NewServer(NewSiteHandler(Options{Resolver: hostroute.New([]string{"lightvela.tech"}), Sites: metadata, Origin: cos, Backend: client, Auth: AuthOptions{Required: true, TokenCodec: codec}}))
	defer gateway.Close()
	request := func(method, path, revision, cookie string) (int, string) {
		t.Helper()
		req, _ := http.NewRequest(method, gateway.URL+path, strings.NewReader(`{"a":2,"b":3}`))
		req.Host = host
		req.Header.Set("Origin", "https://"+host)
		req.Header.Set("X-Website-Release", revision)
		req.Header.Set("Content-Type", "application/json")
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: siteSessionCookie, Value: cookie})
		}
		resp, err := gateway.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return resp.StatusCode, string(body)
	}
	if status, body := request("GET", "/", v1, token); status != 200 || !strings.Contains(body, v1) || strings.Contains(body, "__LIGHTVELA_RELEASE_ID__'") {
		t.Fatalf("static release pin failed: %d %s", status, body)
	}
	if status, body := request("POST", "/api/sum", v1, token); status != 200 || body != `{"sum":5}` {
		t.Fatalf("v1 backend: %d %s", status, body)
	}
	if status, _ := request("POST", "/api/sum", v1, ""); status != 401 {
		t.Fatalf("anonymous status=%d", status)
	}
	v2 := publish(strings.Replace(code, "a+b", "a+b+100", 1), true)
	if status, _ := request("POST", "/api/sum", v1, token); status != 409 {
		t.Fatalf("old page was not fenced: %d", status)
	}
	if status, body := request("POST", "/api/sum", v2, token); status != 200 || body != `{"sum":105}` {
		t.Fatalf("v2 backend: %d %s", status, body)
	}
	rollback, err := control.RollbackRelease(user, siteID, v1)
	if err != nil {
		t.Fatal(err)
	}
	if err := run(rollback.OperationID); err != nil {
		t.Fatal(err)
	}
	if status, body := request("POST", "/api/sum", v1, token); status != 200 || body != `{"sum":5}` {
		t.Fatalf("rollback backend: %d %s", status, body)
	}
	publish("invalid JS !!", false)
	if status, body := request("POST", "/api/sum", v1, token); status != 200 || body != `{"sum":5}` {
		t.Fatalf("failed publish damaged old site: %d %s", status, body)
	}
	if err := control.OnPassIsolated(user); err != nil {
		t.Fatal(err)
	}
	if status, _ := request("POST", "/api/sum", v1, token); status != 403 {
		t.Fatalf("suspended site served API: %d", status)
	}
	if err := control.OnPassRenewed(user); err != nil {
		t.Fatal(err)
	}
	if status, body := request("POST", "/api/sum", v1, token); status != 200 || body != `{"sum":5}` {
		t.Fatalf("resume failed: %d %s", status, body)
	}
	deletion, err := control.DeleteSite(user, siteID)
	if err != nil {
		t.Fatal(err)
	}
	if err := run(deletion.OperationID); err != nil {
		t.Fatal(err)
	}
	if _, err := control.GetSiteInternal(siteID); err == nil {
		t.Fatal("deleted site metadata still live")
	}
	// Check the actual private runtime store, not just the CTL tombstone.
	req, _ := http.NewRequest("GET", runtimeURL+"/v1/sites/"+siteID, nil)
	req.Header.Set("Authorization", "Bearer "+deployToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var storage struct {
		Bytes int64 `json:"storage_bytes"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&storage); err != nil {
		t.Fatal(err)
	}
	if storage.Bytes != 0 {
		t.Fatal("backend data retained after delete")
	}
	_ = resource.GormDB // database state assertions above use the real shared CTL resource
}
