package website

import (
	"testing"
	"time"
)

func injectTestTCBEnv(t *testing.T) {
	t.Helper()
	tcbEnvs = []TCBEnvConfig{
		{
			EnvID:     "test-env",
			AppID:     "1251810746",
			COSBucket: "test-bucket",
			COSRegion: "ap-shanghai",
		},
	}
	tcbEnvsTime = time.Now()
}

func TestGetSitePublicURLUsesTCBStaticHostingDomain(t *testing.T) {
	injectTestTCBEnv(t)
	d := &Deployer{}

	got := d.getSitePublicURL(Operation{
		SiteID:    "ws-test",
		ReleaseID: "wr-test",
		TCBEnvID:  "test-env",
	})
	want := "https://test-env-1251810746.tcloudbaseapp.com/sites/ws-test/current/index.html"
	if got != want {
		t.Fatalf("getSitePublicURL() = %q, want %q", got, want)
	}
}

// 站点地址必须与 releaseID 无关：早期实现把公开 URL 指向
// releases/{releaseID}/index.html，导致每次重新发布用户拿到的链接就失效。
func TestGetSitePublicURLIsStableAcrossReleases(t *testing.T) {
	injectTestTCBEnv(t)
	d := &Deployer{}

	first := d.getSitePublicURL(Operation{SiteID: "ws-test", ReleaseID: "wr-1", TCBEnvID: "test-env"})
	second := d.getSitePublicURL(Operation{SiteID: "ws-test", ReleaseID: "wr-2", TCBEnvID: "test-env"})
	// 建站时还没有任何 release，也必须给出同一个最终地址。
	atCreate := d.getSitePublicURL(Operation{SiteID: "ws-test", TCBEnvID: "test-env"})

	if first != second || first != atCreate {
		t.Fatalf("public URL must be stable, got %q / %q / %q", first, second, atCreate)
	}
}

// COS 在请求缺少 Content-Type 时按 application/octet-stream 存储，
// 浏览器会把 index.html 当附件下载而不是渲染，站点等于不可用。
func TestContentTypeForKeyCoversWebAssets(t *testing.T) {
	tests := map[string]string{
		"index.html":       "text/html; charset=utf-8",
		"nested/page.htm":  "text/html; charset=utf-8",
		"assets/app.css":   "text/css; charset=utf-8",
		"assets/app.js":    "application/javascript; charset=utf-8",
		"assets/app.mjs":   "application/javascript; charset=utf-8",
		"data.json":        "application/json; charset=utf-8",
		"logo.svg":         "image/svg+xml",
		"robots.txt":       "text/plain; charset=utf-8",
		"site.webmanifest": "application/manifest+json",
		"unknown.bin":      "application/octet-stream",
		"noextensionatall": "application/octet-stream",
	}
	for key, want := range tests {
		if got := contentTypeForKey(key); got != want {
			t.Errorf("contentTypeForKey(%q) = %q, want %q", key, got, want)
		}
	}
}

// 目录布局是ctl 与 worker 之间的隐式契约，任何一侧改动都会让
// 「下线/恢复」删错或漏删对象，因此固定下来。
func TestSitePrefixLayout(t *testing.T) {
	if got, want := sitePublishedPrefix("ws-1"), "sites/ws-1/current/"; got != want {
		t.Errorf("sitePublishedPrefix() = %q, want %q", got, want)
	}
	if got, want := siteReleasePrefix("ws-1", "wr-9"), "sites/ws-1/releases/wr-9/"; got != want {
		t.Errorf("siteReleasePrefix() = %q, want %q", got, want)
	}
	if got, want := siteArtifactKey("ws-1", "wr-9"), "_artifacts/ws-1/wr-9.zip"; got != want {
		t.Errorf("siteArtifactKey() = %q, want %q", got, want)
	}
}

func TestParseTCBBucketName(t *testing.T) {
	tests := []struct {
		bucket  string
		wantEnv string
		wantApp string
		wantOK  bool
	}{
		{"022a-static-xiamitcb-db-lab-d5fofz8t62c5140d-1251810746", "xiamitcb-db-lab-d5fofz8t62c5140d", "1251810746", true},
		{"myapp-static-my-env-1234567890", "my-env", "1234567890", true},
		{"regular-bucket-12345", "", "", false},
		{"no-static-here-1251810746", "here", "1251810746", true}, // matches pattern: prefix=no, env_id=here
		{"static-only-1251810746", "", "", false},
		{"", "", "", false},
	}
	for _, tt := range tests {
		envID, appID, ok := parseTCBBucketName(tt.bucket)
		if ok != tt.wantOK || envID != tt.wantEnv || appID != tt.wantApp {
			t.Errorf("parseTCBBucketName(%q) = (%q, %q, %v), want (%q, %q, %v)",
				tt.bucket, envID, appID, ok, tt.wantEnv, tt.wantApp, tt.wantOK)
		}
	}
}
