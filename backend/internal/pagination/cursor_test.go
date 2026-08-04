package pagination

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestCursorRoundTripAndBindings(t *testing.T) {
	token, err := Encode("listTasks", "server=s1&owner=m1", "2026-08-02T00:00:00Z", "id-1")
	if err != nil {
		t.Fatal(err)
	}
	values, err := Decode(token, "listTasks", "server=s1&owner=m1", 2)
	if err != nil {
		t.Fatalf("Decode()：%v", err)
	}
	if strings.Join(values, ",") != "2026-08-02T00:00:00Z,id-1" {
		t.Fatalf("sort = %v", values)
	}
	for _, test := range []struct{ operation, filter string }{
		{"listMembers", "server=s1&owner=m1"},
		{"listTasks", "server=s2&owner=m1"},
	} {
		if _, err := Decode(token, test.operation, test.filter, 2); err == nil {
			t.Errorf("Decode(%s,%s) 未拒绝绑定变化", test.operation, test.filter)
		}
	}
}

func TestCursorRejectsMalformedUnknownAndTrailingData(t *testing.T) {
	for _, token := range []string{
		"not-base64",
		base64.RawURLEncoding.EncodeToString([]byte(`{"v":2,"op":"x","filter":"x","sort":["a"]}`)),
		base64.RawURLEncoding.EncodeToString([]byte(`{"v":1,"op":"x","filter":"x","sort":["a"],"extra":true}`)),
		base64.RawURLEncoding.EncodeToString([]byte(`{"v":1,"op":"x","filter":"x","sort":["a"]}{}`)),
	} {
		if _, err := Decode(token, "x", "filter", 1); err == nil {
			t.Errorf("Decode(%q) 未失败", token)
		}
	}
}
