package website

import "testing"

func TestPinFullstackReleasePreservesJavascriptIdentifier(t *testing.T) {
	input := []byte(`<script>globalThis.__LIGHTVELA_RELEASE_ID__="__LIGHTVELA_RELEASE_ID__";</script><script>fetch('/api/sum',{headers:{'X-Website-Release':globalThis.__LIGHTVELA_RELEASE_ID__}})</script>`)
	want := `<script>globalThis.__LIGHTVELA_RELEASE_ID__="wr-0123456789abcdef";</script><script>fetch('/api/sum',{headers:{'X-Website-Release':globalThis.__LIGHTVELA_RELEASE_ID__}})</script>`
	got, err := pinFullstackRelease(input, "wr-0123456789abcdef")
	if err != nil || string(got) != want {
		t.Fatalf("pin changed identifier or missed value: %s, %v", got, err)
	}
}
func TestPinFullstackReleaseRequiresQuotedValue(t *testing.T) {
	for _, input := range []string{"no marker", "globalThis.__LIGHTVELA_RELEASE_ID__=null"} {
		if _, err := pinFullstackRelease([]byte(input), "wr-0123456789abcdef"); err == nil {
			t.Fatalf("accepted missing quoted value: %s", input)
		}
	}
	got, err := pinFullstackRelease([]byte(`window.release='__LIGHTVELA_RELEASE_ID__'`), "wr-0123456789abcdef")
	if err != nil || string(got) != `window.release='wr-0123456789abcdef'` {
		t.Fatal("single quote placeholder not supported")
	}
}
