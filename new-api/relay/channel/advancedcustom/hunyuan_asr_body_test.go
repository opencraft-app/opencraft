package advancedcustom

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"testing"
	"testing/iotest"

	"github.com/stretchr/testify/require"
)

func TestHunyuanStreamingBody(t *testing.T) {
	for _, size := range []int{0, 1, 2, 3, 24575, 24576, 24577, 49153} {
		audio := bytes.Repeat([]byte{0xff}, size)
		body, err := newHunyuanASRBody(context.Background(), io.NopCloser(iotest.OneByteReader(bytes.NewReader(audio))), int64(size), "model\"\\\n你好", "zh")
		require.NoError(t, err)
		var result bytes.Buffer
		// Small reads exercise pending encoded bytes and final padding.
		for {
			var chunk [7]byte
			n, readErr := body.Read(chunk[:])
			result.Write(chunk[:n])
			if readErr == io.EOF {
				break
			}
			require.NoError(t, readErr)
		}
		require.Equal(t, body.length, int64(result.Len()))
		var decoded hunyuanASRRequest
		require.NoError(t, json.Unmarshal(result.Bytes(), &decoded))
		require.Equal(t, "model\"\\\n你好", decoded.Model)
		require.Equal(t, "auto", decoded.VoiceEncodeFormat)
		require.Equal(t, "zh", decoded.Source)
		require.Equal(t, base64.StdEncoding.EncodeToString(audio), decoded.Data)
		require.NoError(t, body.Close())
	}
}

type failingASRSource struct{ reads, closes int }

func (s *failingASRSource) Read([]byte) (int, error) { s.reads++; return 0, io.ErrClosedPipe }
func (s *failingASRSource) Close() error             { s.closes++; return nil }

func TestHunyuanStreamingBodyCancellationAndError(t *testing.T) {
	source := &failingASRSource{}
	ctx, cancel := context.WithCancel(context.Background())
	body, err := newHunyuanASRBody(ctx, source, 123, "asr", "")
	require.NoError(t, err)
	require.Zero(t, source.reads, "construction must not read audio")
	cancel()
	_, err = io.Copy(io.Discard, body)
	require.ErrorIs(t, err, context.Canceled)
	require.Zero(t, source.reads)
	require.NoError(t, body.Close())
	require.NoError(t, body.Close())
	require.Equal(t, 1, source.closes)

	body, err = newHunyuanASRBody(context.Background(), &failingASRSource{}, 123, "asr", "")
	require.NoError(t, err)
	output, err := io.ReadAll(body)
	require.True(t, errors.Is(err, io.ErrClosedPipe))
	require.NotContains(t, string(output), `"}`)
	require.NoError(t, body.Close())
}

func BenchmarkHunyuanStreamingBody(b *testing.B) {
	for name, size := range map[string]int{"1MiB": 1 << 20, "8MiB": 8 << 20, "32MiB": 32 << 20} {
		b.Run(name, func(b *testing.B) {
			audio := make([]byte, size)
			b.ReportAllocs()
			b.SetBytes(int64(len(audio)))
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				body, err := newHunyuanASRBody(context.Background(), io.NopCloser(bytes.NewReader(audio)), int64(len(audio)), "asr", "")
				if err != nil {
					b.Fatal(err)
				}
				if _, err = io.Copy(io.Discard, body); err != nil {
					b.Fatal(err)
				}
				body.Close()
			}
		})
	}
}
