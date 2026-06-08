package rescue

import (
	"net/url"
	"strings"
	"testing"
)

func TestSignCOSURLIncludesMethodScopedQuerySignature(t *testing.T) {
	signed := signCOSURL("AKIDexample", "secret", "bucket-1250000000.cos.ap-beijing.myqcloud.com", "/rescue/a.tar.gz", 3600, "PUT")
	parsed, err := url.Parse(signed)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	for _, key := range []string{"q-sign-algorithm", "q-ak", "q-sign-time", "q-key-time", "q-header-list", "q-url-param-list", "q-signature"} {
		if _, ok := query[key]; !ok {
			t.Fatalf("missing query key %s in %s", key, signed)
		}
	}
	if query.Get("q-header-list") != "host" {
		t.Fatalf("unexpected signed headers: %s", query.Get("q-header-list"))
	}
	if !strings.HasPrefix(signed, "https://bucket-1250000000.cos.ap-beijing.myqcloud.com/rescue/a.tar.gz?") {
		t.Fatalf("unexpected url: %s", signed)
	}
}
