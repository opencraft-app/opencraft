package tunnelcap

import (
	"bytes"
	"testing"
)

func TestCapabilityBindsUINAndPersistsOnlyDigest(t *testing.T) {
	token, digest, err := Issue("450860000013", bytes.NewReader(bytes.Repeat([]byte{7}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	if token == digest || !ValidDigest(digest) || !MatchesDigest(token, digest) {
		t.Fatalf("token=%q digest=%q", token, digest)
	}
	if uin, ok := UIN(token); !ok || uin != "450860000013" {
		t.Fatalf("uin=%q ok=%v", uin, ok)
	}
	if MatchesDigest(token+"x", digest) {
		t.Fatal("modified capability matched stored digest")
	}
}

func TestCapabilityRejectsMalformedValues(t *testing.T) {
	for _, token := range []string{"", "lvdt1.0.bad", "lvdt1.450860000013.bad", "other.450860000013.AAAA"} {
		if _, ok := UIN(token); ok {
			t.Fatalf("accepted malformed token %q", token)
		}
	}
}
