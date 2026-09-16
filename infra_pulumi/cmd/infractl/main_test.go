package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestScopedUpdateDoesNotSyncFullPlatformOutputs(t *testing.T) {
	if shouldSyncAfterUp("notify") {
		t.Fatal("notify-only update must not sync full platform outputs")
	}
}

func TestFullUpdateStillSyncsPlatformOutputs(t *testing.T) {
	if !shouldSyncAfterUp("") {
		t.Fatal("full update must continue syncing platform outputs")
	}
}

func TestParseReferralBootstrapArgs(t *testing.T) {
	stack, apply, allow, err := parseReferralBootstrapArgs([]string{"--stack", "shprod", "--apply", "--allow-token-change"})
	if err != nil {
		t.Fatal(err)
	}
	if stack != "shprod" || !apply || !allow {
		t.Fatalf("stack=%q apply=%v allow=%v", stack, apply, allow)
	}
}

func TestParseReferralBootstrapArgsDefaultsToBeijing(t *testing.T) {
	stack, apply, allow, err := parseReferralBootstrapArgs(nil)
	if err != nil {
		t.Fatal(err)
	}
	if stack != defaultStack || apply || allow {
		t.Fatalf("stack=%q apply=%v allow=%v", stack, apply, allow)
	}
}

func TestParseCollaborationBootstrapArgs(t *testing.T) {
	options, err := parseCollaborationBootstrapArgs([]string{
		"--stack", "beijing-sandbox", "--im-material-file", "/secure/im.json", "--apply",
	})
	if err != nil {
		t.Fatal(err)
	}
	if options.stack != "beijing-sandbox" || options.imMaterialFile != "/secure/im.json" || !options.apply || options.allowDatabasePasswordReset || options.allowIMSecretRotation {
		t.Fatalf("options = %+v", options)
	}
}

func TestParseCollaborationBootstrapArgsRejectsApplyWithoutIMMaterial(t *testing.T) {
	if _, err := parseCollaborationBootstrapArgs([]string{"--apply"}); err == nil {
		t.Fatal("apply without --im-material-file was accepted")
	}
}

func TestReadCollaborationIMMaterialRequiresSecureExactJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "im.json")
	if err := os.WriteFile(path, []byte(`{"sdkAppId":1600000000,"adminUserId":"administrator","secretKey":"im-secret-value-for-test-only"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	material, err := readCollaborationIMMaterial(path)
	if err != nil {
		t.Fatal(err)
	}
	if material.SDKAppID != 1600000000 || material.AdminUserID != "administrator" || material.SecretKey != "im-secret-value-for-test-only" {
		t.Fatalf("material = %+v", material)
	}
	if err := os.Chmod(path, 0o604); err != nil {
		t.Fatal(err)
	}
	if _, err := readCollaborationIMMaterial(path); err == nil {
		t.Fatal("world-readable IM material was accepted")
	}
	if err := os.Chmod(path, 0o660); err != nil {
		t.Fatal(err)
	}
	if _, err := readCollaborationIMMaterial(path); err == nil {
		t.Fatal("group-writable IM material was accepted")
	}
	if err := os.WriteFile(path, []byte(`{"sdkAppId":1600000000,"adminUserId":"administrator","secretKey":"im-secret-value-for-test-only","extra":"rejected"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readCollaborationIMMaterial(path); err == nil {
		t.Fatal("unknown IM material field was accepted")
	}
}
