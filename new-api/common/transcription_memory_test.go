package common

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/QuantumNous/new-api/constant"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestTranscriptionNeverUsesDiskStorage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dir := t.TempDir()
	t.Setenv("TMPDIR", dir)
	previous := GetDiskCacheConfig()
	SetDiskCacheConfig(DiskCacheConfig{Enabled: true, ThresholdMB: 0, MaxSizeMB: 1024, Path: dir})
	t.Cleanup(func() { SetDiskCacheConfig(previous) })
	previousLimit := constant.MaxFileDownloadMB
	constant.MaxFileDownloadMB = 1
	t.Cleanup(func() { constant.MaxFileDownloadMB = previousLimit })
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	require.NoError(t, w.WriteField("model", "asr"))
	f, err := w.CreateFormFile("file", "test.wav")
	require.NoError(t, err)
	_, err = f.Write(bytes.Repeat([]byte{0}, 2<<20))
	require.NoError(t, err)
	require.NoError(t, w.Close())
	for _, legacy := range []bool{false, true} {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest("POST", "/v1/audio/transcriptions", bytes.NewReader(body.Bytes()))
		c.Request.Header.Set("Content-Type", w.FormDataContentType())
		if legacy {
			c.Set(KeyRequestBody, body.Bytes())
		}
		storage, err := GetBodyStorage(c)
		require.NoError(t, err)
		require.False(t, storage.IsDisk())
		var request struct {
			Model string `json:"model"`
		}
		require.NoError(t, UnmarshalBodyReusable(c, &request))
		require.Equal(t, "asr", request.Model)
		form, err := ParseMultipartFormReusable(c)
		require.NoError(t, err)
		part, err := form.File["file"][0].Open()
		require.NoError(t, err)
		_, onDisk := part.(*os.File)
		require.False(t, onDisk)
		part.Close()
		form.RemoveAll()
		CleanupBodyStorage(c)
	}
	files, err := os.ReadDir(dir)
	require.NoError(t, err)
	require.Empty(t, files)
	// A regular LLM JSON request still follows the configured disk-cache policy.
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/chat/completions", bytes.NewBufferString(`{"model":"chat"}`))
	storage, err := GetBodyStorage(c)
	require.NoError(t, err)
	require.True(t, storage.IsDisk())
	CleanupBodyStorage(c)
}

func TestTranscriptionMemoryBodyRetainsSizeLimit(t *testing.T) {
	previous := constant.MaxRequestBodyMB
	constant.MaxRequestBodyMB = 1
	t.Cleanup(func() { constant.MaxRequestBodyMB = previous })
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/audio/transcriptions", io.NopCloser(bytes.NewReader(make([]byte, (1<<20)+1))))
	_, err := GetBodyStorage(c)
	require.True(t, IsRequestBodyTooLargeError(err))
	_, exists := c.Get(KeyBodyStorage)
	require.False(t, exists)
}
