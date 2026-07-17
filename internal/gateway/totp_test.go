package gateway

import (
	"testing"
	"time"
)

func TestGenerateTOTPCodeMatchesRFC6238SHA1Vector(t *testing.T) {
	code, err := generateTOTPCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", time.Unix(59, 0))
	if err != nil {
		t.Fatal(err)
	}
	if code != "287082" {
		t.Fatalf("code = %q, want 287082", code)
	}
}
