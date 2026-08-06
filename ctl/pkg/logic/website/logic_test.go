package website

import (
	"errors"
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

	url := generateUploadURL("ws-test", "wr-test")
	if url != "" {
		t.Errorf("expected empty URL when COS not configured, got %s", url)
	}
}

// 预签名 URL 的 key 由服务端拼接，Agent 拿到它也只能写自己站点的制品路径。
func TestGenerateUploadURLScopedToSiteArtifact(t *testing.T) {
	t.Setenv("WEBSITE_COS_BUCKET", "test-vela-user-sites-1388575217")
	t.Setenv("WEBSITE_COS_REGION", "ap-beijing")
	t.Setenv("TENCENT_SECRET_ID", "AKIDTESTTESTTESTTESTTESTTESTTEST")
	t.Setenv("TENCENT_SECRET_KEY", "testtesttesttesttesttesttesttest")

	got := generateUploadURL("ws-test", "wr-test")
	if got == "" {
		t.Fatal("配置齐全时应返回预签名 URL")
	}
	if !strings.Contains(got, "_artifacts/ws-test/wr-test.zip") {
		t.Fatalf("预签名 URL 未指向本站点的制品路径: %s", got)
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
