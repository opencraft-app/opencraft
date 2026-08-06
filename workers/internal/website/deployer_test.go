package website

import (
	"strings"
	"testing"
)

func TestGetSitePublicURLUsesSiteSubdomain(t *testing.T) {
	d := &Deployer{siteRootDomain: "sites.lightclaw.tech"}

	got := d.getSitePublicURL(Operation{SiteID: "ws-test", ReleaseID: "wr-test"})
	want := "https://ws-test.sites.lightclaw.tech/"
	if got != want {
		t.Fatalf("getSitePublicURL() = %q, want %q", got, want)
	}
}

// 站点地址必须与 releaseID 无关：早期实现把公开 URL 指向
// releases/{releaseID}/index.html，导致每次重新发布用户拿到的链接就失效。
func TestGetSitePublicURLIsStableAcrossReleases(t *testing.T) {
	d := &Deployer{siteRootDomain: "sites.lightclaw.tech"}

	first := d.getSitePublicURL(Operation{SiteID: "ws-test", ReleaseID: "wr-1"})
	second := d.getSitePublicURL(Operation{SiteID: "ws-test", ReleaseID: "wr-2"})
	// 建站时还没有任何 release，也必须给出同一个最终地址。
	atCreate := d.getSitePublicURL(Operation{SiteID: "ws-test"})

	if first != second || first != atCreate {
		t.Fatalf("public URL must be stable, got %q / %q / %q", first, second, atCreate)
	}
}

// 公开地址不能暴露对象存储的真实地址：一旦用户能直连 COS，
// 限流、到期下线和违规封禁就都绕过去了。
func TestGetSitePublicURLNeverExposesBucket(t *testing.T) {
	d := &Deployer{siteRootDomain: "sites.lightclaw.tech", siteCos: &cosClient{bucket: "test-vela-user-sites-1388575217", region: "ap-beijing"}}

	got := d.getSitePublicURL(Operation{SiteID: "ws-test"})
	for _, leaked := range []string{"myqcloud.com", "cos.", d.siteCos.bucket} {
		if strings.Contains(got, leaked) {
			t.Fatalf("公开地址 %q 泄露了存储信息 %q", got, leaked)
		}
	}
}

func TestGetSitePublicURLRequiresRootDomain(t *testing.T) {
	d := &Deployer{}
	if got := d.getSitePublicURL(Operation{SiteID: "ws-test"}); got != "" {
		t.Fatalf("未配置根域时应返回空，实际 %q", got)
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

// 目录布局是 ctl、worker 和 site-gateway 三方之间的隐式契约：
// worker 往这里写，网关从这里读，任何一侧改动都会让站点 404 或让
// 「下线/恢复」删错对象，因此固定下来。
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
