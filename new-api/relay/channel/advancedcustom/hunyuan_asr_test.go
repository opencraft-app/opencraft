package advancedcustom

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/dto"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/service/relayconvert"
	"github.com/QuantumNous/new-api/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func asrWAV(samples int) []byte {
	data := make([]byte, 44+samples*2)
	copy(data, "RIFF")
	copy(data[8:], "WAVEfmt ")
	copy(data[36:], "data")
	for offset, value := range map[int]uint32{4: uint32(len(data) - 8), 16: 16, 24: 16000, 28: 32000, 40: uint32(samples * 2)} {
		binary.LittleEndian.PutUint32(data[offset:], value)
	}
	for offset, value := range map[int]uint16{20: 1, 22: 1, 32: 2, 34: 16} {
		binary.LittleEndian.PutUint16(data[offset:], value)
	}
	return data
}

func asrMP3() []byte {
	// MPEG-1 Layer III frame headers: 128kbps, 44.1kHz, stereo; these exercise
	// the existing duration parser, not a real supplier decoder.
	frame := make([]byte, 417)
	copy(frame, []byte{0xff, 0xfb, 0x90, 0x00})
	return bytes.Repeat(frame, 20)
}

func asrContext(t *testing.T, audio []byte, fields map[string]string) (*gin.Context, *httptest.ResponseRecorder) {
	return asrNamedContext(t, audio, fields, "dictation.wav")
}

func asrNamedContext(t *testing.T, audio []byte, fields map[string]string, filename string) (*gin.Context, *httptest.ResponseRecorder) {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	require.NoError(t, w.WriteField("model", "asr-alias"))
	for name, value := range fields {
		require.NoError(t, w.WriteField(name, value))
	}
	f, err := w.CreateFormFile("file", filename)
	require.NoError(t, err)
	_, err = f.Write(audio)
	require.NoError(t, err)
	require.NoError(t, w.Close())
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest("POST", "/v1/audio/transcriptions", &body)
	c.Request.Header.Set("Content-Type", w.FormDataContentType())
	t.Cleanup(func() { common.CleanupBodyStorage(c) })
	return c, recorder
}

func asrInfo(baseURL string) *relaycommon.RelayInfo {
	info := advancedCustomRelayInfo(&dto.AdvancedCustomConfig{Routes: []dto.AdvancedCustomRoute{{
		IncomingPath: "/v1/audio/transcriptions", UpstreamPath: "/v1/wand/asrproxy/sync_transcribe", Converter: relayconvert.ConverterHunyuanASR,
	}}})
	info.RelayMode = relayconstant.RelayModeAudioTranscription
	info.RequestURLPath = "/v1/audio/transcriptions"
	info.ChannelBaseUrl = baseURL
	info.SetEstimatePromptTokens(17)
	return info
}

func TestHunyuanASRRoundTrip(t *testing.T) {
	service.InitHttpClient()
	audio := asrWAV(16000)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/v1/wand/asrproxy/sync_transcribe", r.URL.Path)
		require.Equal(t, "application/json", r.Header.Get("Content-Type"))
		require.Equal(t, "Bearer sk-test", r.Header.Get("Authorization"))
		require.Positive(t, r.ContentLength)
		require.Empty(t, r.TransferEncoding, "must not require chunked uploads")
		var payload map[string]string
		require.NoError(t, json.NewDecoder(r.Body).Decode(&payload))
		require.Len(t, payload, 4)
		require.Equal(t, "ep-test-mapped", payload["model"])
		require.Equal(t, "zh", payload["source"])
		require.Equal(t, "auto", payload["voice_encode_format"])
		decoded, err := base64.StdEncoding.DecodeString(payload["data"])
		require.NoError(t, err)
		require.Equal(t, audio, decoded)
		io.WriteString(w, `{"data":{"status":"completed","output":{"text":"你好"}}}`)
	}))
	defer server.Close()
	for _, format := range []string{"json", "text"} {
		c, recorder := asrContext(t, audio, map[string]string{"language": "zh", "response_format": format})
		info := asrInfo(server.URL)
		a := &Adaptor{}
		body, err := a.ConvertAudioRequest(c, info, dto.AudioRequest{Model: "ep-test-mapped", ResponseFormat: format})
		require.NoError(t, err)
		response, err := a.DoRequest(c, info, body)
		require.NoError(t, err)
		usage, apiError := a.DoResponse(c, response.(*http.Response), info)
		require.Nil(t, apiError)
		require.Equal(t, 17, usage.(*dto.Usage).PromptTokens)
		require.Equal(t, 0, usage.(*dto.Usage).CompletionTokens)
		if format == "json" {
			require.JSONEq(t, `{"text":"你好"}`, recorder.Body.String())
		} else {
			require.Equal(t, "你好", recorder.Body.String())
		}
	}
}

func TestHunyuanASRRejectsUnsupportedInput(t *testing.T) {
	for _, format := range []string{"srt", "verbose_json", "vtt"} {
		c, _ := asrContext(t, asrWAV(16000), nil)
		_, err := (&Adaptor{}).ConvertAudioRequest(c, asrInfo("http://unused"), dto.AudioRequest{Model: "asr", ResponseFormat: format})
		require.Error(t, err)
		var apiError *types.NewAPIError
		require.ErrorAs(t, err, &apiError)
		require.Equal(t, http.StatusBadRequest, apiError.StatusCode)
		require.True(t, types.IsSkipRetryError(apiError))
	}
	for _, fields := range []map[string]string{{"stream": "true"}, {"prompt": "hint"}, {"language": "fr"}, {"timestamp_granularities[]": "word"}} {
		c, _ := asrContext(t, asrWAV(16000), fields)
		_, err := (&Adaptor{}).ConvertAudioRequest(c, asrInfo("http://unused"), dto.AudioRequest{Model: "asr"})
		require.Error(t, err)
	}
	for _, audio := range [][]byte{nil, []byte("mp3"), asrWAV(0)} {
		require.Error(t, validateHunyuanAudio(context.Background(), audio, "test.wav"))
	}
	for _, samples := range []int{3999, 4000, 16000, 16000*120 + 1} {
		require.NoError(t, validateHunyuanAudio(context.Background(), asrWAV(samples), "test.wav"))
	}
	broken := asrWAV(16000)
	broken[0] = 0
	require.Error(t, validateHunyuanAudio(context.Background(), broken, "test.wav"))
	require.Error(t, validateHunyuanAudio(context.Background(), asrWAV(16000), "test.pcm"))
	require.Error(t, validateHunyuanAudio(context.Background(), []byte{0x1a, 0x45, 0xdf, 0xa3}, "test.webm"))
	require.NoError(t, validateHunyuanAudio(context.Background(), asrMP3(), "test.mp3"))
	// WAV is no longer constrained to OpenCraft's mono/16kHz profile.
	stereo := asrWAV(48000)
	binary.LittleEndian.PutUint16(stereo[22:], 2)
	binary.LittleEndian.PutUint16(stereo[32:], 4)
	binary.LittleEndian.PutUint32(stereo[24:], 48000)
	binary.LittleEndian.PutUint32(stereo[28:], 192000)
	require.NoError(t, validateHunyuanAudio(context.Background(), stereo, "test.wav"))
	for _, path := range []string{"/v1/chat/completions", "/v1/audio/translations", "/v1/audio/speech"} {
		config := asrInfo("").ChannelOtherSettings.AdvancedCustom
		config.Routes[0].IncomingPath = path
		require.Error(t, config.Validate())
	}
}

func TestHunyuanASRResponseBoundsAndSafeErrors(t *testing.T) {
	for _, body := range []string{`{`, `{"data":{"status":"pending","output":{"text":"secret"}}}`, `{"data":{"status":"completed","output":{}}}`, strings.Repeat("x", hunyuanMaxResponseBytes+1)} {
		c, recorder := asrContext(t, asrWAV(16000), nil)
		_, err := (&Adaptor{hunyuanResponseFormat: "json"}).doHunyuanASRResponse(c, &http.Response{Body: io.NopCloser(strings.NewReader(body))}, asrInfo(""))
		require.NotNil(t, err)
		require.Empty(t, recorder.Body.String())
		require.NotContains(t, err.Error(), "secret")
	}
	// Silence is a valid completed transcription, not a retryable failure.
	c, recorder := asrContext(t, asrWAV(16000), nil)
	_, err := (&Adaptor{}).doHunyuanASRResponse(c, &http.Response{Body: io.NopCloser(strings.NewReader(`{"data":{"status":"completed","output":{"text":""}}}`))}, asrInfo(""))
	require.Nil(t, err)
	require.JSONEq(t, `{"text":""}`, recorder.Body.String())
	// The official synchronous API returns top-level status/output.
	c, recorder = asrContext(t, asrWAV(16000), nil)
	_, err = (&Adaptor{}).doHunyuanASRResponse(c, &http.Response{Body: io.NopCloser(strings.NewReader(`{"status":"completed","output":{"text":"官方格式"}}`))}, asrInfo(""))
	require.Nil(t, err)
	require.JSONEq(t, `{"text":"官方格式"}`, recorder.Body.String())
	// Never let a nested success mask an explicit top-level failure.
	c, _ = asrContext(t, asrWAV(16000), nil)
	_, err = (&Adaptor{}).doHunyuanASRResponse(c, &http.Response{Body: io.NopCloser(strings.NewReader(`{"status":"failed","data":{"status":"completed","output":{"text":"wrong"}}}`))}, asrInfo(""))
	require.NotNil(t, err)
}

func TestHunyuanASRDoesNotRedirectOrExposeSupplierErrors(t *testing.T) {
	service.InitHttpClient()
	var redirected atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Add(1) }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", target.URL)
		w.WriteHeader(http.StatusTemporaryRedirect)
		io.WriteString(w, "secret audio echo")
	}))
	defer server.Close()
	c, _ := asrContext(t, asrWAV(16000), nil)
	a := &Adaptor{}
	info := asrInfo(server.URL)
	body, err := a.ConvertAudioRequest(c, info, dto.AudioRequest{Model: "asr"})
	require.NoError(t, err)
	response, err := a.DoRequest(c, info, body)
	require.NoError(t, err)
	resp := response.(*http.Response)
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.NotContains(t, string(raw), "secret")
	require.Equal(t, int32(0), redirected.Load())
	ctx, cancel := context.WithCancel(c.Request.Context())
	cancel()
	c.Request = c.Request.WithContext(ctx)
	_, err = a.DoRequest(c, info, bytes.NewBufferString("{}"))
	require.Error(t, err)
	var apiError *types.NewAPIError
	require.ErrorAs(t, err, &apiError)
	require.True(t, types.IsSkipRetryError(apiError))
}

func TestHunyuanASRTimeoutIncludesBodyRead(t *testing.T) {
	service.InitHttpClient()
	client := service.GetHttpClient()
	previous := client.Timeout
	client.Timeout = 50 * time.Millisecond
	t.Cleanup(func() { client.Timeout = previous })
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	c, recorder := asrContext(t, asrWAV(16000), nil)
	a := &Adaptor{}
	info := asrInfo(server.URL)
	body, err := a.ConvertAudioRequest(c, info, dto.AudioRequest{Model: "asr"})
	require.NoError(t, err)
	response, err := a.DoRequest(c, info, body)
	require.NoError(t, err)
	_, apiError := a.DoResponse(c, response.(*http.Response), info)
	require.NotNil(t, apiError)
	require.True(t, types.IsSkipRetryError(apiError))
	require.Empty(t, recorder.Body.String())
}
