package avatar

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/tencentyun/cos-go-sdk-v5"
)

func TestCOSBucketClientSignedGetURLIncludesSecretID(t *testing.T) {
	t.Parallel()

	bucketURL, err := url.Parse("https://example-1250000000.cos.ap-beijing.myqcloud.com")
	if err != nil {
		t.Fatalf("parse bucket url: %v", err)
	}

	client := cos.NewClient(&cos.BaseURL{BucketURL: bucketURL}, &http.Client{
		Transport: &cos.AuthorizationTransport{
			SecretID:  "AKIDTEST",
			SecretKey: "SKTEST",
		},
	})

	url, err := (&cosBucketClient{client: client}).SignedGetURL(context.Background(), "avatars/usr_123/current.jpg", 5*time.Minute)
	if err != nil {
		t.Fatalf("signed get url failed: %v", err)
	}
	if !strings.Contains(url, "q-ak=AKIDTEST") {
		t.Fatalf("expected signed url to include secret id, got %q", url)
	}
}
