package advancedcustom

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"os"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/service"
	"github.com/stretchr/testify/require"
)

// Explicit opt-in, stdin-only synthetic audio/key. Normal test/CI runs never
// contact a supplier. Never write audio or credentials to fixtures or logs.
func TestHunyuanWebMStdinSmoke(t *testing.T) {
	if os.Getenv("HUNYUAN_ASR_SMOKE_STDIN") != "1" {
		t.Skip("explicit stdin smoke only")
	}
	var input struct {
		Audio  string `json:"audio"`
		Model  string `json:"model"`
		APIKey string `json:"api_key"`
		Send   bool   `json:"send"`
	}
	require.NoError(t, json.NewDecoder(io.LimitReader(os.Stdin, 1<<20)).Decode(&input))
	audio, err := base64.StdEncoding.DecodeString(input.Audio)
	require.NoError(t, err)
	require.Less(t, len(audio), 128<<10)
	duration, err := common.GetAudioDuration(context.Background(), bytes.NewReader(audio), ".webm")
	require.NoError(t, err)
	require.Greater(t, duration, 1.0)
	require.Less(t, duration, 10.0)
	c, recorder := asrNamedContext(t, audio, map[string]string{"language": "en"}, "synthetic.webm")
	info := asrInfo("https://tokenhub.tencentmaas.com")
	info.ApiKey = input.APIKey
	info.SetEstimatePromptTokens(common.QuotaRound(math.Ceil(duration) / 60 * 1000))
	a := &Adaptor{}
	body, err := a.ConvertAudioRequest(c, info, dto.AudioRequest{Model: input.Model})
	require.NoError(t, err)
	streaming, ok := body.(*hunyuanASRBody)
	require.True(t, ok, "live smoke must exercise incremental encoding")
	defer streaming.Close()
	t.Logf("synthetic WebM/Opus bytes=%d estimated_duration_seconds=%.6f memory_only=true", len(audio), duration)
	t.Logf("incremental_base64_json=true content_length=%d", streaming.length)
	if !input.Send {
		return
	}
	require.NotEmpty(t, input.APIKey, "supplier key required")
	service.InitHttpClient()
	response, err := a.DoRequest(c, info, body)
	require.NoError(t, err)
	resp := response.(*http.Response)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode, "supplier HTTP status")
	_, apiError := a.DoResponse(c, resp, info)
	require.Nil(t, apiError)
	var output dto.AudioResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &output))
	require.NotEmpty(t, output.Text, "synthetic speech should produce text")
	t.Logf("supplier completed; synthesized speech transcription: %q", output.Text)
}
