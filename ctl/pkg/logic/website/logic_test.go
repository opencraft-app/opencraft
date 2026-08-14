package website

import (
	"errors"
	"net/url"
	"strings"
	"testing"

	"ctl/pkg/errcode"
	modelwebsite "ctl/pkg/model/website"
	"ctl/pkg/resource"
)

// validSHA256 is the SHA-256 hash of empty string, 64 hex chars
const validSHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

func TestValidateArtifactHash(t *testing.T) {
	tests := []struct {
		name string
		hash string
		want bool
	}{
		{"empty", "", false},
		{"valid_sha256_prefix", "sha256:" + validSHA256, true},
		{"valid_hex", validSHA256, true},
		{"too_short", "abc123", false},
		{"invalid_hex_64", "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", false},
		{"wrong_length", "abc123", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := validateArtifactHash(tt.hash)
			if got != tt.want {
				t.Errorf("validateArtifactHash(%q) = %v, want %v", tt.hash, got, tt.want)
			}
		})
	}
}

func TestValidateFilePath(t *testing.T) {
	tests := []struct {
		name string
		path string
		want bool
	}{
		{"normal", "index.html", true},
		{"nested", "css/style.css", true},
		{"deep_nested", "assets/images/logo.png", true},
		{"path_traversal", "../etc/passwd", false},
		{"absolute", "/etc/passwd", false},
		{"windows_abs", "\\windows\\system32", false},
		{"dotdot_slash", "../../secret", false},
		{"valid_dot", "./index.html", true},
		{"empty", "", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := validateFilePath(tt.path)
			if got != tt.want {
				t.Errorf("validateFilePath(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestGenerateUploadURL_NoConfig(t *testing.T) {
	t.Setenv("WEBSITE_COS_BUCKET", "")
	t.Setenv("WEBSITE_COS_REGION", "")
	t.Setenv("WEBSITE_COS_SECRET_ID", "")
	t.Setenv("WEBSITE_COS_SECRET_KEY", "")
	t.Setenv("TENCENT_SECRET_ID", "")
	t.Setenv("TENCENT_SECRET_KEY", "")

	uploadURL, headers, err := generateUploadURL("ws-test", "wr-test", 123, validSHA256)
	if !errors.Is(err, errcode.ErrWebsiteUploadUnavailable) {
		t.Fatalf("generateUploadURL error = %v, want ErrWebsiteUploadUnavailable", err)
	}
	if uploadURL != "" {
		t.Errorf("expected empty URL when COS not configured, got %s", uploadURL)
	}
	if len(headers) != 0 {
		t.Fatalf("expected no required headers without a signed URL, got %#v", headers)
	}
}

// 预签名 URL 的 key 由服务端拼接，Agent 拿到它也只能写自己站点的制品路径。
func TestGenerateUploadURLScopedToSiteArtifact(t *testing.T) {
	t.Setenv("WEBSITE_COS_BUCKET", "test-vela-user-sites-1388575217")
	t.Setenv("WEBSITE_COS_REGION", "ap-beijing")
	t.Setenv("TENCENT_SECRET_ID", "AKIDTESTTESTTESTTESTTESTTESTTEST")
	t.Setenv("TENCENT_SECRET_KEY", "testtesttesttesttesttesttesttest")

	got, headers, err := generateUploadURL("ws-test", "wr-test", 123, "sha256:"+strings.ToUpper(validSHA256))
	if err != nil {
		t.Fatalf("generateUploadURL: %v", err)
	}
	if got == "" {
		t.Fatal("配置齐全时应返回预签名 URL")
	}
	if !strings.Contains(got, "_artifacts/ws-test/wr-test.zip") {
		t.Fatalf("预签名 URL 未指向本站点的制品路径: %s", got)
	}
	if headers["Content-Length"] != "123" {
		t.Fatalf("Content-Length = %q, want 123", headers["Content-Length"])
	}
	if headers["x-cos-meta-artifact-sha256"] != validSHA256 {
		t.Fatalf("x-cos-meta-artifact-sha256 = %q, want normalized SHA-256", headers["x-cos-meta-artifact-sha256"])
	}
	parsed, err := url.Parse(got)
	if err != nil {
		t.Fatalf("parse signed URL: %v", err)
	}
	signedHeaders := parsed.Query().Get("q-header-list")
	if !strings.Contains(signedHeaders, "content-length") || !strings.Contains(signedHeaders, "x-cos-meta-artifact-sha256") {
		t.Fatalf("q-header-list = %q, want signed length and SHA-256 metadata", signedHeaders)
	}
}

// 预签名 URL 直接交到用户手上，签名的 AK 权限越小越好：只要站点专用凭据配上了，
// 就不能再用能操作全部业务桶的共享平台凭据签名。
func TestSiteCOSSecretsPrefersWebsiteScopedCredentials(t *testing.T) {
	t.Setenv("TENCENT_SECRET_ID", "AKIDPLATFORM")
	t.Setenv("TENCENT_SECRET_KEY", "platform-key")
	t.Setenv("WEBSITE_COS_SECRET_ID", "AKIDSITESCOPED")
	t.Setenv("WEBSITE_COS_SECRET_KEY", "site-key")

	id, key := siteCOSSecrets()
	if id != "AKIDSITESCOPED" || key != "site-key" {
		t.Fatalf("siteCOSSecrets() = %q/%q, want AKIDSITESCOPED/site-key", id, key)
	}
}

// 站点专用凭据尚未下发的环境仍然要能签名，否则发布链路直接断掉。
func TestSiteCOSSecretsFallsBackToPlatformCredentials(t *testing.T) {
	t.Setenv("WEBSITE_COS_SECRET_ID", "")
	t.Setenv("WEBSITE_COS_SECRET_KEY", "")
	t.Setenv("TENCENT_SECRET_ID", "AKIDPLATFORM")
	t.Setenv("TENCENT_SECRET_KEY", "platform-key")

	id, key := siteCOSSecrets()
	if id != "AKIDPLATFORM" || key != "platform-key" {
		t.Fatalf("siteCOSSecrets() = %q/%q, want AKIDPLATFORM/platform-key", id, key)
	}
}

// 只配了一半的专用凭据不能用半套签名，必须整体回落。
func TestSiteCOSSecretsIgnoresPartialWebsiteCredentials(t *testing.T) {
	t.Setenv("WEBSITE_COS_SECRET_ID", "AKIDSITESCOPED")
	t.Setenv("WEBSITE_COS_SECRET_KEY", "")
	t.Setenv("TENCENT_SECRET_ID", "AKIDPLATFORM")
	t.Setenv("TENCENT_SECRET_KEY", "platform-key")

	id, key := siteCOSSecrets()
	if id != "AKIDPLATFORM" || key != "platform-key" {
		t.Fatalf("siteCOSSecrets() = %q/%q, want AKIDPLATFORM/platform-key", id, key)
	}
}

func TestCreateSiteDerivesActivePassBundleWhenOmitted(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedPassAndBundle(t, "user-1", "bundle-1", testQuotaJSON)

	result, err := NewLogic().CreateSite("user-1", "", "site", "")
	if err != nil {
		t.Fatalf("CreateSite: %v", err)
	}
	var site modelwebsite.SiteEntity
	if err := resource.GormDB.Table(modelwebsite.SitesTable).
		Where("site_id = ?", result.SiteID).First(&site).Error; err != nil {
		t.Fatalf("load created site: %v", err)
	}
	if site.BundleID != "bundle-1" {
		t.Fatalf("created site bundle_id = %q, want bundle-1", site.BundleID)
	}
}

func TestCreateSiteRejectsExplicitWrongBundle(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedPassAndBundle(t, "user-1", "bundle-1", testQuotaJSON)

	_, err := NewLogic().CreateSite("user-1", "bundle-other", "site", "")
	if !errors.Is(err, errcode.ErrWebsiteInvalidParam) {
		t.Fatalf("CreateSite error = %v, want ErrWebsiteInvalidParam", err)
	}
}
