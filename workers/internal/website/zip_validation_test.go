package website

import (
	"archive/zip"
	"bytes"
	"testing"
)

func TestValidateZipEntriesRejectsDeclaredLimitByActualArchiveContents(t *testing.T) {
	archive := makeZipForTest(t, map[string]string{
		"index.html": "hello",
		"app.js":     "console.log('hello')",
	})

	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatal(err)
	}
	if err := validateZipEntries(reader.File, 1, 1024); err == nil {
		t.Fatal("expected actual file count to be enforced")
	}
}

func TestValidateZipEntriesRejectsUncompressedSizeOverLimit(t *testing.T) {
	archive := makeZipForTest(t, map[string]string{"index.html": "1234567890"})
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatal(err)
	}
	if err := validateZipEntries(reader.File, 10, 9); err == nil {
		t.Fatal("expected uncompressed byte limit to be enforced")
	}
}

func makeZipForTest(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for name, body := range files {
		entry, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
