package api

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestValidateReleaseManifestRejectsDuplicateAndUnsafePaths(t *testing.T) {
	manifest := ReleaseManifest{
		FormatVersion:          1,
		FileCount:              2,
		TotalUncompressedBytes: 6,
		Packs: []ReleasePack{{
			Name:           "pack-0001-0123456789abcdef.tar.gz",
			CompressedSize: 100,
			SHA256:         repeatedHex("a"),
			FileCount:      2,
		}},
		Files: []ReleaseFile{
			{Path: "../index.html", Size: 3, SHA256: repeatedHex("b"), Pack: "pack-0001-0123456789abcdef.tar.gz"},
			{Path: "../index.html", Size: 3, SHA256: repeatedHex("b"), Pack: "pack-0001-0123456789abcdef.tar.gz"},
		},
	}

	err := validateReleaseManifest(manifest)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid file path")
}

func TestExtractReleasePacksVerifiesPackAndFileDigests(t *testing.T) {
	first := buildReleasePack(t, map[string]string{"index.html": "home"})
	second := buildReleasePack(t, map[string]string{"assets/app.js": "app"})
	manifest := ReleaseManifest{
		FormatVersion:          1,
		FileCount:              2,
		TotalUncompressedBytes: 7,
		Packs: []ReleasePack{
			{Name: "pack-0001-0123456789abcdef.tar.gz", CompressedSize: int64(len(first)), SHA256: digestBytes(first), FileCount: 1},
			{Name: "pack-0002-fedcba9876543210.tar.gz", CompressedSize: int64(len(second)), SHA256: digestBytes(second), FileCount: 1},
		},
		Files: []ReleaseFile{
			{Path: "index.html", Size: 4, SHA256: digestBytes([]byte("home")), Pack: "pack-0001-0123456789abcdef.tar.gz"},
			{Path: "assets/app.js", Size: 3, SHA256: digestBytes([]byte("app")), Pack: "pack-0002-fedcba9876543210.tar.gz"},
		},
	}
	packs := map[string][]byte{
		manifest.Packs[0].Name: first,
		manifest.Packs[1].Name: second,
	}
	root := t.TempDir()

	count, size, err := extractReleasePacks(
		context.Background(),
		manifest,
		root,
		func(_ context.Context, name string) (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(packs[name])), nil
		},
	)

	require.NoError(t, err)
	assert.Equal(t, 2, count)
	assert.Equal(t, int64(7), size)
	assert.Equal(t, "home", readReleaseFile(t, root, "index.html"))
	assert.Equal(t, "app", readReleaseFile(t, root, "assets/app.js"))
}

func TestExtractReleasePacksRejectsCorruptedPack(t *testing.T) {
	body := buildReleasePack(t, map[string]string{"index.html": "home"})
	manifest := ReleaseManifest{
		FormatVersion:          1,
		FileCount:              1,
		TotalUncompressedBytes: 4,
		Packs: []ReleasePack{{
			Name:           "pack-0001-0123456789abcdef.tar.gz",
			CompressedSize: int64(len(body)),
			SHA256:         repeatedHex("f"),
			FileCount:      1,
		}},
		Files: []ReleaseFile{{
			Path: "index.html", Size: 4, SHA256: digestBytes([]byte("home")), Pack: "pack-0001-0123456789abcdef.tar.gz",
		}},
	}

	_, _, err := extractReleasePacks(
		context.Background(),
		manifest,
		t.TempDir(),
		func(_ context.Context, _ string) (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(body)), nil
		},
	)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "pack checksum mismatch")
}

func buildReleasePack(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var body bytes.Buffer
	gzipWriter := gzip.NewWriter(&body)
	archive := tar.NewWriter(gzipWriter)
	for name, content := range files {
		require.NoError(t, archive.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(content))}))
		_, err := archive.Write([]byte(content))
		require.NoError(t, err)
	}
	require.NoError(t, archive.Close())
	require.NoError(t, gzipWriter.Close())
	return body.Bytes()
}

func repeatedHex(value string) string {
	return strings.Repeat(value, 64)
}

func digestBytes(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func readReleaseFile(t *testing.T, root string, name string) string {
	t.Helper()
	value, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(name)))
	require.NoError(t, err)
	return string(value)
}
