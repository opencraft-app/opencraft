package sms

import "testing"

func TestNewRejectsMissingRequiredFields(t *testing.T) {
	if _, err := New(Config{}); err == nil {
		t.Fatal("expected missing config to fail")
	}
}

func TestMaskPhone(t *testing.T) {
	if got := maskPhone("13800138123"); got != "138****8123" {
		t.Fatalf("maskPhone returned %q", got)
	}
}
