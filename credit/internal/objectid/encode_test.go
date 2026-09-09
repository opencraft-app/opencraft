package objectid

import (
	"regexp"
	"testing"
)

func TestGenerateCreditPackageIDMatchesPassEncoding(t *testing.T) {
	got, err := GenerateCreditPackageID(1, "passmonlocal_dev", "ap-beijing")
	if err != nil {
		t.Fatalf("GenerateCreditPackageID: %v", err)
	}
	if got != "cpkg-jyxpuid0" {
		t.Fatalf("package ID = %q, want cpkg-jyxpuid0", got)
	}
}

func TestGenerateCreditPackageIDUsesEightLowercaseBase36Characters(t *testing.T) {
	got, err := GenerateCreditPackageID(42, "creditmonsandbox_bj_7", "ap-beijing")
	if err != nil {
		t.Fatalf("GenerateCreditPackageID: %v", err)
	}
	if !regexp.MustCompile(`^cpkg-[0-9a-z]{8}$`).MatchString(got) {
		t.Fatalf("package ID = %q, want cpkg-xxxxxxxx", got)
	}
}

func TestGenerateCreditPackageIDRejectsInvalidInput(t *testing.T) {
	for _, tt := range []struct {
		name     string
		autoID   int64
		password string
		region   string
	}{
		{name: "zero auto ID", password: "creditmonsandbox_bj_7", region: "ap-beijing"},
		{name: "empty password", autoID: 1, region: "ap-beijing"},
		{name: "unknown region", autoID: 1, password: "creditmonsandbox_bj_7", region: "unknown"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := GenerateCreditPackageID(tt.autoID, tt.password, tt.region); err == nil {
				t.Fatal("GenerateCreditPackageID must reject invalid input")
			}
		})
	}
}
