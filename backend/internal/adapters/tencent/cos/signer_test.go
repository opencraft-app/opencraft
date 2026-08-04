package cos

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestSignerCreatesHostBoundShortGETURL(t *testing.T) {
	signer, err := NewSigner(Config{
		Bucket: "an-computer-1388575217", Region: "ap-beijing",
		SecretID: "AKIDEXAMPLE", SecretKey: "secret-example",
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := signer.PresignGet(
		context.Background(),
		"computer/releases/0.1.0/darwin-arm64/install.sh",
		5*time.Minute,
	)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Scheme != "https" ||
		parsed.Host != "an-computer-1388575217.cos.ap-beijing.myqcloud.com" ||
		parsed.Path != "/computer/releases/0.1.0/darwin-arm64/install.sh" ||
		parsed.Query().Get("q-signature") == "" ||
		!strings.Contains(parsed.Query().Get("q-header-list"), "host") {
		t.Fatalf("presigned URL shape = %s", parsed.Redacted())
	}
}

func TestSignerRejectsUnsafeObjectAndOverlongTTL(t *testing.T) {
	signer, err := NewSigner(Config{
		Bucket: "an-computer-1388575217", Region: "ap-beijing",
		SecretID: "AKIDEXAMPLE", SecretKey: "secret-example",
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		key string
		ttl time.Duration
	}{
		{key: "../secret", ttl: time.Minute},
		{key: "/absolute", ttl: time.Minute},
		{key: "valid/object", ttl: 5*time.Minute + time.Second},
	} {
		if _, err := signer.PresignGet(context.Background(), test.key, test.ttl); err == nil {
			t.Fatalf("PresignGet(%q, %s) unexpectedly succeeded", test.key, test.ttl)
		}
	}
}
