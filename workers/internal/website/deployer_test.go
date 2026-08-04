package website

import (
	"testing"
	"time"
)

func TestGetSitePublicURLUsesTCBStaticHostingDomain(t *testing.T) {
	// Inject a fake discovered TCB env into the cache
	tcbEnvs = []TCBEnvConfig{
		{
			EnvID:     "test-env",
			AppID:     "1251810746",
			COSBucket: "test-bucket",
			COSRegion: "ap-shanghai",
		},
	}
	tcbEnvsTime = time.Now()

	d := &Deployer{}

	got := d.getSitePublicURL(Operation{
		SiteID:    "ws-test",
		ReleaseID: "wr-test",
		TCBEnvID:  "test-env",
	})
	want := "https://test-env-1251810746.tcloudbaseapp.com/sites/ws-test/releases/wr-test/index.html"
	if got != want {
		t.Fatalf("getSitePublicURL() = %q, want %q", got, want)
	}
}

func TestParseTCBBucketName(t *testing.T) {
	tests := []struct {
		bucket   string
		wantEnv  string
		wantApp  string
		wantOK   bool
	}{
		{"022a-static-xiamitcb-db-lab-d5fofz8t62c5140d-1251810746", "xiamitcb-db-lab-d5fofz8t62c5140d", "1251810746", true},
		{"myapp-static-my-env-1234567890", "my-env", "1234567890", true},
		{"regular-bucket-12345", "", "", false},
		{"no-static-here-1251810746", "here", "1251810746", true},  // matches pattern: prefix=no, env_id=here
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
