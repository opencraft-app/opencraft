package website

import (
	"sort"
	"testing"

	"github.com/tencentyun/cos-go-sdk-v5"
)

func assertSameKeys(t *testing.T, got, want []string) {
	t.Helper()
	got = append([]string(nil), got...)
	want = append([]string(nil), want...)
	sort.Strings(got)
	sort.Strings(want)
	if len(got) != len(want) {
		t.Fatalf("keys = %v, want %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("keys = %v, want %v", got, want)
		}
	}
}

func releaseObject(releaseID, name, modified string, size int64) cos.Object {
	return cos.Object{
		Key:          "sites/ws-1/releases/" + releaseID + "/" + name,
		LastModified: modified,
		Size:         size,
	}
}

func TestSelectReleaseObjectsKeepsCandidateAndActualPreviousActiveRelease(t *testing.T) {
	objects := []cos.Object{
		releaseObject("wr-oldest", "index.html", "2026-08-01T00:00:00.000Z", 1),
		releaseObject("wr-previous", "index.html", "2026-08-03T00:00:00.000Z", 1),
		releaseObject("wr-previous", "app.js", "2026-08-03T00:00:01.000Z", 1),
		releaseObject("wr-candidate", "index.html", "2026-08-02T00:00:00.000Z", 1),
		// A failed historical candidate can be newer than the real previous active;
		// timestamps must not make it the retained rollback generation.
		releaseObject("wr-stray", "index.html", "2026-08-04T12:00:00.000Z", 1),
	}

	got := selectReleaseObjectsToDelete(objects,
		"sites/ws-1/releases/",
		"sites/ws-1/releases/wr-candidate/",
		"sites/ws-1/releases/wr-previous/")
	assertSameKeys(t, got, []string{
		"sites/ws-1/releases/wr-oldest/index.html",
		"sites/ws-1/releases/wr-stray/index.html",
	})
}

func TestSelectReleaseObjectsKeepsOnlyCandidateWithoutPreviousActive(t *testing.T) {
	objects := []cos.Object{
		releaseObject("wr-active", "index.html", "2026-08-01T00:00:00.000Z", 1),
		releaseObject("wr-other", "index.html", "2026-08-02T00:00:00.000Z", 1),
	}
	got := selectReleaseObjectsToDelete(objects,
		"sites/ws-1/releases/", "sites/ws-1/releases/wr-active/", "")
	assertSameKeys(t, got, []string{"sites/ws-1/releases/wr-other/index.html"})
}
