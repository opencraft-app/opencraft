package middleware

import (
	"errors"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type unreadTranscriptionBody struct{ reads atomic.Int32 }

func (b *unreadTranscriptionBody) Read([]byte) (int, error) {
	b.reads.Add(1)
	return 0, errors.New("must not read")
}
func (*unreadTranscriptionBody) Close() error { return nil }

func TestMemoryTranscriptionAdmissionRejectsBeforeReadAndReleases(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(memoryTranscriptionAdmission(1))
	entered, release := make(chan struct{}), make(chan struct{})
	var first sync.Once
	router.POST("/v1/audio/transcriptions", func(c *gin.Context) {
		first.Do(func() { close(entered); <-release })
		c.Status(204)
	})
	router.POST("/v1/chat/completions", func(c *gin.Context) { c.Status(204) })
	done := make(chan struct{})
	go func() {
		defer close(done)
		router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/v1/audio/transcriptions", nil))
	}()
	<-entered
	body := &unreadTranscriptionBody{}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest("POST", "/v1/audio/transcriptions", body))
	require.Equal(t, 429, recorder.Code)
	require.Equal(t, "1", recorder.Header().Get("Retry-After"))
	require.Zero(t, body.reads.Load())
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest("POST", "/v1/chat/completions", nil))
	require.Equal(t, 204, recorder.Code)
	close(release)
	<-done
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest("POST", "/v1/audio/transcriptions", nil))
	require.Equal(t, 204, recorder.Code)
}
