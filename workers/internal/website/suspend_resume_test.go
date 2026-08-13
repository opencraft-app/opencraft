package website

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// ctlStub 记录 worker 回调 ctl 的路径与 body，用来断言操作被收敛成了成功还是失败。
type ctlStub struct {
	server *httptest.Server
	paths  []string
	bodies []map[string]string
}

func newCtlStub(t *testing.T) *ctlStub {
	t.Helper()
	stub := &ctlStub{}
	stub.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]string
		_ = json.Unmarshal(raw, &body)
		stub.paths = append(stub.paths, r.URL.Path)
		stub.bodies = append(stub.bodies, body)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"code":"Success"}`))
	}))
	t.Cleanup(stub.server.Close)
	return stub
}

// newDeployerWithoutCos 故意不配置 COS 客户端。
//
// 这就是断言本身：suspend / resume 现在完全不碰对象存储，所以在 siteCos 为 nil 的
// deployer 上也必须能跑通。任何一天有人把删文件的逻辑加回来，这两个用例会立刻失败。
func newDeployerWithoutCos(stub *ctlStub) *Deployer {
	return &Deployer{
		ctlBaseURL:     stub.server.URL,
		httpClient:     &http.Client{Timeout: 5 * time.Second},
		siteRootDomain: "sites.example",
		siteURLScheme:  "http",
		siteCos:        nil,
	}
}

// 套餐到期下线不再删任何文件：站点由自研反代按状态返 403，文件永久保留。
func TestExecuteSuspendDoesNoCosWork(t *testing.T) {
	stub := newCtlStub(t)
	d := newDeployerWithoutCos(stub)

	op := Operation{OperationID: "wo-1", SiteID: "ws-1", OperationType: "suspend", LeaseToken: "wl-1"}
	if err := d.Execute(op); err != nil {
		t.Fatalf("Execute(suspend) = %v, want nil", err)
	}

	if len(stub.paths) != 1 || stub.paths[0] != "/internal/ctl/websites/operations/wo-1/complete" {
		t.Fatalf("expected a single complete callback, got %v", stub.paths)
	}
	// current/ 仍然是站点的有效位置，回调不能把 cloud_path 抹掉。
	if got := stub.bodies[0]["cloud_path"]; got != "sites/ws-1/current/" {
		t.Fatalf("cloud_path = %q, want sites/ws-1/current/", got)
	}
	if got := stub.bodies[0]["public_url"]; got != "http://ws-1.sites.example/" {
		t.Fatalf("public_url = %q, want the stable site URL", got)
	}
}

// 续费恢复同样不需要重新发布：隔离时文件一个都没删。
func TestExecuteResumeDoesNoCosWork(t *testing.T) {
	stub := newCtlStub(t)
	d := newDeployerWithoutCos(stub)

	op := Operation{OperationID: "wo-2", SiteID: "ws-2", ReleaseID: "wr-2", OperationType: "resume", LeaseToken: "wl-2"}
	if err := d.Execute(op); err != nil {
		t.Fatalf("Execute(resume) = %v, want nil", err)
	}
	if len(stub.paths) != 1 || stub.paths[0] != "/internal/ctl/websites/operations/wo-2/complete" {
		t.Fatalf("expected a single complete callback, got %v", stub.paths)
	}
}

// 真删能力必须留着，而且它依赖 COS：没有配置桶时只能失败，不能假装删干净了。
func TestExecuteDeleteStillRequiresCos(t *testing.T) {
	stub := newCtlStub(t)
	d := newDeployerWithoutCos(stub)

	op := Operation{OperationID: "wo-3", SiteID: "ws-3", OperationType: "delete", LeaseToken: "wl-3"}
	if err := d.Execute(op); err == nil {
		t.Fatal("Execute(delete) without COS must fail")
	}
	if len(stub.paths) != 1 || stub.paths[0] != "/internal/ctl/websites/operations/wo-3/fail" {
		t.Fatalf("expected a fail callback, got %v", stub.paths)
	}
}
