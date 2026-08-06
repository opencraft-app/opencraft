package website

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
	"time"

	"github.com/tencentyun/cos-go-sdk-v5"
)

func artifact(releaseID, lastModified string, size int64) cos.Object {
	return cos.Object{
		Key:          siteArtifactKey("ws-1", releaseID),
		LastModified: lastModified,
		Size:         size,
	}
}

func sortedKeys(keys []string) []string {
	out := make([]string, len(keys))
	copy(out, keys)
	sort.Strings(out)
	return out
}

func assertSameKeys(t *testing.T, got, want []string) {
	t.Helper()
	g, w := sortedKeys(got), sortedKeys(want)
	if len(g) != len(w) {
		t.Fatalf("待删 key = %v，期望 %v", g, w)
	}
	for i := range g {
		if g[i] != w[i] {
			t.Fatalf("待删 key = %v，期望 %v", g, w)
		}
	}
}

// 默认只留最新一次发布的那一份：其余全部删掉，不留历史版本。
func TestKeepsOnlyTheCurrentArtifactByDefault(t *testing.T) {
	objects := []cos.Object{
		artifact("wr-old1", "2026-08-01T10:00:00.000Z", 100),
		artifact("wr-old2", "2026-08-02T10:00:00.000Z", 100),
		artifact("wr-current", "2026-08-06T10:00:00.000Z", 100),
	}
	got := selectArtifactsToDelete(objects, siteArtifactKey("ws-1", "wr-current"), 1)
	assertSameKeys(t, got, []string{
		siteArtifactKey("ws-1", "wr-old1"),
		siteArtifactKey("ws-1", "wr-old2"),
	})
}

// 只有一份制品时无事可做。
func TestSingleArtifactIsNeverDeleted(t *testing.T) {
	objects := []cos.Object{artifact("wr-only", "2026-08-06T10:00:00.000Z", 100)}
	if got := selectArtifactsToDelete(objects, siteArtifactKey("ws-1", "wr-only"), 1); len(got) != 0 {
		t.Fatalf("待删 key = %v，期望空", got)
	}
}

// 保留数配成 N 时，最近 N 个都要留住，只删超出的部分。
func TestKeepsNewestNWhenConfigured(t *testing.T) {
	objects := []cos.Object{
		artifact("wr-1", "2026-08-01T10:00:00.000Z", 100),
		artifact("wr-2", "2026-08-02T10:00:00.000Z", 100),
		artifact("wr-3", "2026-08-03T10:00:00.000Z", 100),
		artifact("wr-4", "2026-08-04T10:00:00.000Z", 100),
		artifact("wr-5", "2026-08-05T10:00:00.000Z", 100),
		artifact("wr-6", "2026-08-06T10:00:00.000Z", 100),
	}
	got := selectArtifactsToDelete(objects, siteArtifactKey("ws-1", "wr-6"), 5)
	// 只删掉最老的那一个，最近 5 个（wr-2..wr-6）原样保留。
	assertSameKeys(t, got, []string{siteArtifactKey("ws-1", "wr-1")})
}

// 按修改时间排序，而不是按 key。
//
// key 是 `wr-<随机 hex>.zip`，字典序和发布顺序毫无关系；按 key 排会随机删掉最新的那份。
func TestOrdersByLastModifiedNotByKey(t *testing.T) {
	objects := []cos.Object{
		// key 的字典序最小，但它是最新的一份。
		artifact("wr-aaaa", "2026-08-06T10:00:00.000Z", 100),
		artifact("wr-zzzz", "2026-08-01T10:00:00.000Z", 100),
		artifact("wr-mmmm", "2026-08-03T10:00:00.000Z", 100),
	}
	// keepKey 指向另一份，剩下三份里应当保留时间最新的 wr-aaaa。
	objects = append(objects, artifact("wr-current", "2026-08-07T10:00:00.000Z", 100))
	got := selectArtifactsToDelete(objects, siteArtifactKey("ws-1", "wr-current"), 2)
	assertSameKeys(t, got, []string{
		siteArtifactKey("ws-1", "wr-zzzz"),
		siteArtifactKey("ws-1", "wr-mmmm"),
	})
}

// 本次发布的制品无论如何都要保留：它是当前线上内容的来源，
// 而 LastModified 在时钟回拨或重放的场景下未必把它排在最前。
func TestCurrentArtifactSurvivesEvenIfNotNewest(t *testing.T) {
	objects := []cos.Object{
		artifact("wr-current", "2026-08-01T10:00:00.000Z", 100),
		artifact("wr-newer", "2026-08-06T10:00:00.000Z", 100),
	}
	got := selectArtifactsToDelete(objects, siteArtifactKey("ws-1", "wr-current"), 1)
	assertSameKeys(t, got, []string{siteArtifactKey("ws-1", "wr-newer")})
}

// 存量历史制品必须在下一次发布时被一并收敛：清理逻辑不区分新旧，
// 每次都对整个 _artifacts/{siteID}/ 前缀重新判断，不需要一次性清理脚本。
func TestPreExistingBacklogConvergesOnNextPublish(t *testing.T) {
	// 模拟策略上线前已经攒了 3 份的站点，本次是第 4 次发布。
	objects := []cos.Object{
		artifact("wr-legacy1", "2026-07-01T10:00:00.000Z", 100),
		artifact("wr-legacy2", "2026-07-15T10:00:00.000Z", 100),
		artifact("wr-legacy3", "2026-08-01T10:00:00.000Z", 100),
		artifact("wr-new", "2026-08-06T10:00:00.000Z", 100),
	}
	got := selectArtifactsToDelete(objects, siteArtifactKey("ws-1", "wr-new"), 1)
	if len(got) != 3 {
		t.Fatalf("待删 %d 份，期望 3 份存量历史制品一并清掉：%v", len(got), got)
	}
}

// 保留数为 0 或负数时收敛成 1，绝不能把当前制品也删掉——
// 那会让「续费恢复」和任何未来的版本追溯彻底失去依据。
func TestKeepCountIsClampedToAtLeastOne(t *testing.T) {
	objects := []cos.Object{
		artifact("wr-current", "2026-08-06T10:00:00.000Z", 100),
		artifact("wr-old", "2026-08-01T10:00:00.000Z", 100),
	}
	for _, keep := range []int{0, -1, -100} {
		got := selectArtifactsToDelete(objects, siteArtifactKey("ws-1", "wr-current"), keep)
		assertSameKeys(t, got, []string{siteArtifactKey("ws-1", "wr-old")})
	}
}

// 同一秒内连发两次时排序必须稳定，否则同样的输入会给出不同的删除结果。
func TestSameTimestampOrderingIsDeterministic(t *testing.T) {
	objects := []cos.Object{
		artifact("wr-a", "2026-08-06T10:00:00.000Z", 100),
		artifact("wr-b", "2026-08-06T10:00:00.000Z", 100),
		artifact("wr-c", "2026-08-06T10:00:00.000Z", 100),
	}
	first := selectArtifactsToDelete(objects, siteArtifactKey("ws-1", "wr-a"), 2)
	for i := 0; i < 20; i++ {
		got := selectArtifactsToDelete(objects, siteArtifactKey("ws-1", "wr-a"), 2)
		assertSameKeys(t, got, first)
	}
}

// 空前缀不该崩，也不该产生删除动作。
func TestEmptyArtifactPrefixIsNoop(t *testing.T) {
	if got := selectArtifactsToDelete(nil, siteArtifactKey("ws-1", "wr-x"), 1); len(got) != 0 {
		t.Fatalf("待删 key = %v，期望空", got)
	}
}

// 保留数默认值必须是 1：产品明确「只留最后一次发布的，不用历史版本」。
func TestArtifactKeepVersionsDefaultsToOne(t *testing.T) {
	t.Setenv("WEBSITE_ARTIFACT_KEEP_VERSIONS", "")
	if got := artifactKeepVersions(); got != 1 {
		t.Fatalf("默认保留数 = %d，期望 1", got)
	}
}

// 保留数可配置：将来想留历史只改配置不改代码。
func TestArtifactKeepVersionsIsConfigurable(t *testing.T) {
	t.Setenv("WEBSITE_ARTIFACT_KEEP_VERSIONS", "5")
	if got := artifactKeepVersions(); got != 5 {
		t.Fatalf("保留数 = %d，期望 5", got)
	}
	// 非法值回落到默认，不能变成 0（那会连当前制品都删掉）。
	for _, raw := range []string{"0", "-3", "abc"} {
		t.Setenv("WEBSITE_ARTIFACT_KEEP_VERSIONS", raw)
		if got := artifactKeepVersions(); got != 1 {
			t.Fatalf("WEBSITE_ARTIFACT_KEEP_VERSIONS=%q 时保留数 = %d，期望回落到 1", raw, got)
		}
	}
}

// ---- 存储用量 ----

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
	// 负数（不该出现，但别让它把合计拉低）忽略。
	if got := sumObjectSizes([]cos.Object{{Key: "x", Size: -5}, {Key: "y", Size: 10}}); got != 10 {
		t.Fatalf("含负数时合计 = %d，期望 10", got)
	}
}

// 存储上报走内部 token，且上报的是绝对值——deployer 每次都重新列一遍全部对象，
// 所以这个接口天然幂等，重试不会让用量翻倍。
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

// 非 2xx 必须报错，否则调用方看不到上报失败、用量会静默停在旧值。
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

// 上报失败不能让一次成功的发布或删除翻转成失败：用量晚一轮更新会在下次发布时
// 自然纠正，而把发布标记为失败是用户立刻能看到的损害。
func TestRefreshSiteStorageSwallowsFailures(t *testing.T) {
	d := &Deployer{ctlBaseURL: "http://127.0.0.1:1", httpClient: &http.Client{Timeout: time.Second}}
	// siteCos 为 nil 时直接返回，不能 panic。
	d.refreshSiteStorage(nil, "ws-1")
	d.refreshSiteStorage(&cosClient{}, "")
}
