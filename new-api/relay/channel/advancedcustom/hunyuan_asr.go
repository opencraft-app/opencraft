package advancedcustom

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/relay/channel"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/types"
	"github.com/gin-gonic/gin"
)

// TokenHub sync ASR documents at most 75 MB before Base64 (100 MB encoded),
// and at most 30 minutes. These are supplier limits, not OpenCraft's recorder
// policy. The relay's own upload/admission limits still apply first.
const hunyuanMaxAudioBytes = 75_000_000
const hunyuanMaxResponseBytes = 128 << 10

type hunyuanASRRequest struct {
	Model             string `json:"model"`
	Data              string `json:"data"`
	VoiceEncodeFormat string `json:"voice_encode_format"`
	Source            string `json:"source,omitempty"`
}

func (a *Adaptor) convertHunyuanASR(c *gin.Context, info *relaycommon.RelayInfo, request dto.AudioRequest) (io.Reader, error) {
	if !common.IsMemoryOnlyTranscription(c) || info.RelayMode != relayconstant.RelayModeAudioTranscription || info.IsStream {
		return nil, errors.New("Hunyuan ASR supports synchronous audio transcriptions only")
	}
	format := request.ResponseFormat
	if format == "" {
		format = "json"
	}
	if format != "json" && format != "text" {
		return nil, errors.New("Hunyuan ASR supports response_format json or text only")
	}
	form, err := common.ParseMultipartFormReusable(c)
	if err != nil {
		return nil, errors.New("invalid transcription multipart body")
	}
	defer form.RemoveAll()
	// Do not silently discard semantics that this synchronous protocol cannot
	// represent (timestamps, streaming, prompts, etc.).
	for name, values := range form.Value {
		switch name {
		case "model", "language", "response_format":
			if len(values) != 1 {
				return nil, errors.New("duplicate transcription field")
			}
		default:
			return nil, errors.New("unsupported Hunyuan ASR transcription field")
		}
	}
	if len(form.File) != 1 || len(form.File["file"]) != 1 {
		return nil, errors.New("exactly one transcription file is required")
	}
	header := form.File["file"][0]
	if header.Size > hunyuanMaxAudioBytes {
		return nil, errors.New("Hunyuan ASR audio exceeds 75 MB")
	}
	file, err := header.Open()
	if err != nil {
		return nil, errors.New("cannot read transcription file")
	}
	transferred := false
	defer func() {
		if !transferred {
			file.Close()
		}
	}()
	if err := validateHunyuanAudioReader(c.Request.Context(), file, header.Size, header.Filename); err != nil {
		return nil, err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, errors.New("cannot rewind transcription file")
	}
	source := ""
	if values := form.Value["language"]; len(values) == 1 {
		source = values[0]
		if source != "" && source != "zh" && source != "en" {
			return nil, errors.New("Hunyuan ASR language must be zh or en")
		}
	}
	if strings.TrimSpace(request.Model) == "" {
		return nil, errors.New("transcription model is required")
	}
	body, err := newHunyuanASRBody(c.Request.Context(), file, header.Size, request.Model, source)
	if err != nil {
		return nil, errors.New("cannot encode Hunyuan ASR request")
	}
	a.hunyuanResponseFormat = format
	transferred = true
	return body, nil
}

// Accept self-describing containers supported by NewAPI's existing pure-Go
// duration estimators, without decode/re-encode or disk. Supplier detection is
// requested via "auto"; browser support is not proof of supplier codec support.
// Raw PCM is not admitted: this public multipart API has no sample-rate/layout
// metadata with which to validate or bill it safely.
func validateHunyuanAudio(ctx context.Context, audio []byte, filename string) error {
	return validateHunyuanAudioReader(ctx, bytes.NewReader(audio), int64(len(audio)), filename)
}

func validateHunyuanAudioReader(ctx context.Context, audio io.ReadSeeker, size int64, filename string) error {
	if size <= 0 || size > hunyuanMaxAudioBytes {
		return errors.New("Hunyuan ASR audio must be nonempty and at most 75 MB")
	}
	ext := strings.ToLower(filepath.Ext(filename))
	switch ext {
	case ".webm", ".wav", ".mp3", ".ogg", ".oga", ".opus", ".mp4", ".m4a", ".flac", ".aac", ".aiff", ".aif", ".aifc":
	default:
		return errors.New("unsupported transcription audio container")
	}
	duration, err := common.GetAudioDuration(ctx, audio, ext)
	if err != nil || math.IsNaN(duration) || math.IsInf(duration, 0) || duration <= 0 || duration > 1800 {
		return errors.New("invalid transcription audio or duration exceeds 30 minutes")
	}
	return nil
}

func (a *Adaptor) doHunyuanASRRequest(c *gin.Context, info *relaycommon.RelayInfo, body io.Reader) (*http.Response, error) {
	if streaming, ok := body.(*hunyuanASRBody); ok {
		defer streaming.Close()
	}
	requestURL, err := a.GetRequestURL(info)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, requestURL, body)
	if err != nil {
		return nil, errors.New("cannot build Hunyuan ASR request")
	}
	if streaming, ok := body.(*hunyuanASRBody); ok {
		req.ContentLength = streaming.length
	}
	if err := a.SetupRequestHeader(c, &req.Header, info); err != nil {
		return nil, err
	}
	overrides, err := channel.ResolveHeaderOverride(info, c)
	if err != nil {
		return nil, err
	}
	for key, value := range overrides {
		req.Header.Set(key, value)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	client := service.GetHttpClient()
	if info.ChannelSetting.Proxy != "" {
		client, err = service.GetHttpClientWithProxy(info.ChannelSetting.Proxy)
		if err != nil {
			return nil, errors.New("cannot initialize Hunyuan ASR proxy")
		}
	}
	if client == nil {
		return nil, errors.New("Hunyuan ASR HTTP client unavailable")
	}
	// Clone, never mutate the shared LLM client. Timeout includes response body
	// reads; caller cancellation propagates. Never forward credentials on redirect.
	isolated := *client
	if isolated.Timeout == 0 || isolated.Timeout > 90*time.Second {
		isolated.Timeout = 90 * time.Second
	}
	isolated.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := isolated.Do(req)
	if err != nil {
		// Submission may have reached the supplier. An ambiguous transport
		// failure must not automatically charge for a second transcription.
		return nil, types.NewOpenAIError(errors.New("Hunyuan ASR upstream request failed"), types.ErrorCodeDoRequestFailed, http.StatusBadGateway, types.ErrOptionWithSkipRetry())
	}
	if resp.StatusCode != http.StatusOK {
		// Existing audio relay handles the status/quotas/retry. Do not expose or
		// log arbitrary supplier error bodies (which may echo submitted data).
		resp.Body.Close()
		resp.Body = io.NopCloser(strings.NewReader(`{"error":{"message":"Hunyuan ASR upstream rejected the request","type":"upstream_error"}}`))
	}
	return resp, nil
}

func (a *Adaptor) doHunyuanASRResponse(c *gin.Context, resp *http.Response, info *relaycommon.RelayInfo) (any, *types.NewAPIError) {
	fail := func() (any, *types.NewAPIError) {
		return nil, types.NewOpenAIError(errors.New("invalid Hunyuan ASR upstream response"), types.ErrorCodeBadResponse, http.StatusBadGateway, types.ErrOptionWithSkipRetry())
	}
	if resp == nil || resp.Body == nil {
		return fail()
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, hunyuanMaxResponseBytes+1))
	if err != nil || len(body) > hunyuanMaxResponseBytes {
		return fail()
	}
	type transcriptionResult struct {
		Status string `json:"status"`
		Output struct {
			Text *string `json:"text"`
		} `json:"output"`
	}
	var envelope struct {
		transcriptionResult
		Data *transcriptionResult `json:"data"`
	}
	if json.Unmarshal(body, &envelope) != nil {
		return fail()
	}
	result := envelope.transcriptionResult
	// Official docs use top-level status/output. The existing OpenCraft supplier
	// integration also handles a data envelope; accept it only when top-level
	// fields are absent, not as a fallback around a top-level failure.
	if result.Status == "" && result.Output.Text == nil && envelope.Data != nil {
		result = *envelope.Data
	}
	if result.Status != "completed" || result.Output.Text == nil || len(*result.Output.Text) > 32000 {
		return fail()
	}
	info.SetFirstResponseTime()
	if a.hunyuanResponseFormat == "text" {
		c.Data(http.StatusOK, "text/plain; charset=utf-8", []byte(*result.Output.Text))
	} else {
		c.JSON(http.StatusOK, dto.AudioResponse{Text: *result.Output.Text})
	}
	// Same time-based estimate as existing transcription billing. Supplier does
	// not report tokens; never fabricate LLM/audio token detail usage.
	return &dto.Usage{PromptTokens: info.GetEstimatePromptTokens(), TotalTokens: info.GetEstimatePromptTokens()}, nil
}
