package website

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFullstackPublishKeepsBackendCodePrivate(t *testing.T) {
	code := "export default {fetch(){return new Response('ok')}}"
	artifact := websiteZip(t, map[string]string{"index.html": "<script>window.release='__LIGHTVELA_RELEASE_ID__'</script>", "__backend/app.mjs": code})
	state := &fakeCOSState{artifact: artifact, metadataHash: digestForTest(string(artifact)), objects: map[string]int64{}}
	d, path := newPublishTestDeployer(t, state)
	deployed := false
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer deploy-test" {
			t.Error("missing internal authentication")
		}
		switch r.Method {
		case "PUT":
			var bundle struct {
				Code   string `json:"code"`
				SHA256 string `json:"sha256"`
			}
			_ = json.NewDecoder(r.Body).Decode(&bundle)
			if bundle.Code != code || bundle.SHA256 != digestForTest(code) {
				t.Error("wrong runtime artifact")
			}
			deployed = true
			w.WriteHeader(201)
			_, _ = w.Write([]byte(`{"status":"ready","sha256":"` + bundle.SHA256 + `"}`))
		case "GET":
			_, _ = w.Write([]byte(`{"storage_bytes":128}`))
		default:
			t.Errorf("unexpected runtime method %s", r.Method)
		}
	}))
	defer runtime.Close()
	d.runtimeURL = runtime.URL
	d.runtimeToken = "deploy-test"
	op := Operation{OperationID: "wo-1", SiteID: "ws-1", ReleaseID: "wr-0123456789abcdef", OperationType: "deploy", LeaseToken: "lease", ArtifactSize: int64(len(artifact)), ArtifactHash: digestForTest(string(artifact)), Kind: "fullstack", BackendSHA256: digestForTest(code)}
	if err := d.publishRelease(op, false); err != nil {
		t.Fatal(err)
	}
	if !deployed || *path == "" {
		t.Fatal("fullstack not activated")
	}
	for _, key := range state.putKeys {
		if strings.Contains(key, "__backend") {
			t.Fatal("backend source published to static origin")
		}
	}
}
func TestStaticPublishRejectsReservedBackendSource(t *testing.T) {
	artifact := websiteZip(t, map[string]string{"index.html": "hello", "__backend/app.mjs": "server code"})
	state := &fakeCOSState{artifact: artifact, metadataHash: digestForTest(string(artifact)), objects: map[string]int64{}}
	d, path := newPublishTestDeployer(t, state)
	op := Operation{OperationID: "wo-1", SiteID: "ws-1", ReleaseID: "wr-0123456789abcdef", OperationType: "deploy", LeaseToken: "lease", ArtifactSize: int64(len(artifact)), ArtifactHash: digestForTest(string(artifact))}
	if err := d.publishRelease(op, false); err == nil {
		t.Fatal("static upload accepted backend folder")
	}
	if *path != "" || len(state.putKeys) != 0 {
		t.Fatal("backend source reached COS")
	}
}

func TestRollbackMissingRetainedStaticNeverActivates(t *testing.T) {
	state := &fakeCOSState{objects: map[string]int64{}}
	d, path := newPublishTestDeployer(t, state)
	err := d.Execute(Operation{OperationID: "wo-1", SiteID: "ws-1", ReleaseID: "wr-old", OperationType: "rollback", LeaseToken: "lease"})
	if !errors.Is(err, ErrOperationFailedAndReported) || *path != "" {
		t.Fatalf("missing rollback artifact must fail durably: %v", err)
	}
}

func TestFullstackPublishRetainsHistoricalRollbackArtifacts(t *testing.T) {
	code := "export default {fetch(){return new Response('ok')}}"
	artifact := websiteZip(t, map[string]string{"index.html": "<script>window.release='__LIGHTVELA_RELEASE_ID__'</script>", "__backend/app.mjs": code})
	historical := "sites/ws-1/releases/wr-historical/index.html"
	previous := "sites/ws-1/releases/wr-previous/"
	state := &fakeCOSState{artifact: artifact, metadataHash: digestForTest(string(artifact)), objects: map[string]int64{historical: 12, previous + "index.html": 12}}
	d, path := newPublishTestDeployer(t, state)
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "PUT" {
			w.WriteHeader(201)
			_, _ = w.Write([]byte(`{"status":"ready","sha256":"` + digestForTest(code) + `"}`))
			return
		}
		if r.Method == "GET" {
			_, _ = w.Write([]byte(`{"storage_bytes":128}`))
			return
		}
		t.Errorf("unexpected runtime request: %s", r.Method)
	}))
	defer runtime.Close()
	d.runtimeURL = runtime.URL
	d.runtimeToken = "test"
	op := Operation{OperationID: "wo-1", SiteID: "ws-1", ReleaseID: "wr-0123456789abcdef", OperationType: "deploy", LeaseToken: "lease", ArtifactSize: int64(len(artifact)), ArtifactHash: digestForTest(string(artifact)), Kind: "fullstack", BackendSHA256: digestForTest(code), ActiveCloudPath: previous}
	if err := d.publishRelease(op, false); err != nil {
		t.Fatal(err)
	}
	if *path == "" {
		t.Fatal("not activated")
	}
	if _, ok := state.objects[historical]; !ok {
		t.Fatal("fullstack publication removed a historical rollback artifact without control-plane retention authorization")
	}
}
