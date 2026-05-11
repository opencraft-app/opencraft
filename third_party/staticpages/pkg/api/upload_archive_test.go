package api

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/SpechtLabs/StaticPages/pkg/config"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSaveArtifactsToTempStreamsTarGzipArchive(t *testing.T) {
	gin.SetMode(gin.TestMode)
	api := NewRestApi(config.StaticPagesConfig{})
	body := buildTarGzip(t, map[string]string{
		"index.html":       "<html></html>",
		"assets/app.js":    "console.log('ok')",
		"./assets/app.css": "body{}",
	})
	request := httptest.NewRequest(http.MethodPost, "/api/upload", bytes.NewReader(body))
	request.Header.Set("Content-Type", staticPagesTarGzipMediaType)
	ct, _ := gin.CreateTestContext(httptest.NewRecorder())
	ct.Request = request

	uploadPath, fileCount, size, err := api.saveArtifactsToTemp(context.Background(), ct, "abc123")
	defer func() { _ = os.RemoveAll(uploadPath) }()

	require.NoError(t, err)
	assert.Equal(t, 3, fileCount)
	assert.Equal(t, int64(len("<html></html>")+len("console.log('ok')")+len("body{}")), size)
	assert.Equal(t, "<html></html>", readFile(t, uploadPath, "index.html"))
	assert.Equal(t, "console.log('ok')", readFile(t, uploadPath, "assets/app.js"))
	assert.Equal(t, "body{}", readFile(t, uploadPath, "assets/app.css"))
}

func TestSaveArtifactsToTempRejectsArchivePathTraversal(t *testing.T) {
	gin.SetMode(gin.TestMode)
	api := NewRestApi(config.StaticPagesConfig{})
	body := buildTarGzip(t, map[string]string{
		"../index.html": "bad",
	})
	request := httptest.NewRequest(http.MethodPost, "/api/upload", bytes.NewReader(body))
	request.Header.Set(staticPagesUploadFormatHeader, "tar.gz")
	ct, _ := gin.CreateTestContext(httptest.NewRecorder())
	ct.Request = request

	uploadPath, _, _, err := api.saveArtifactsToTemp(context.Background(), ct, "abc123")
	defer func() { _ = os.RemoveAll(uploadPath) }()

	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid archive path")
}

func TestRequestUsesTarGzipUploadAcceptsUploadFormatHeader(t *testing.T) {
	for _, format := range []string{"tar.gz", "tgz"} {
		request := httptest.NewRequest(http.MethodPost, "/api/upload", nil)
		request.Header.Set(staticPagesUploadFormatHeader, format)
		ct, _ := gin.CreateTestContext(httptest.NewRecorder())
		ct.Request = request

		assert.True(t, requestUsesTarGzipUpload(ct))
	}
}

func buildTarGzip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var body bytes.Buffer
	gz := gzip.NewWriter(&body)
	tarWriter := tar.NewWriter(gz)
	for name, content := range files {
		err := tarWriter.WriteHeader(&tar.Header{
			Name: name,
			Mode: 0o664,
			Size: int64(len(content)),
		})
		require.NoError(t, err)
		_, err = tarWriter.Write([]byte(content))
		require.NoError(t, err)
	}
	require.NoError(t, tarWriter.Close())
	require.NoError(t, gz.Close())
	return body.Bytes()
}

func readFile(t *testing.T, root string, rel string) string {
	t.Helper()
	content, err := os.ReadFile(filepath.Join(root, rel))
	require.NoError(t, err)
	return string(content)
}
