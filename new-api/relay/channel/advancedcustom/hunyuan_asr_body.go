package advancedcustom

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"strings"
	"sync"
)

// A pull-based encoder: no producer goroutine/pipe, no complete Base64 or JSON
// buffer. The validated multipart file remains the only audio source.
type hunyuanASRBody struct {
	ctx       context.Context
	reader    io.Reader
	file      io.Closer
	length    int64
	closeOnce sync.Once
	closeErr  error
}

func newHunyuanASRBody(ctx context.Context, file io.ReadCloser, size int64, model, source string) (*hunyuanASRBody, error) {
	metadata, err := json.Marshal(struct {
		Model             string `json:"model"`
		VoiceEncodeFormat string `json:"voice_encode_format"`
		Source            string `json:"source,omitempty"`
	}{model, "auto", source})
	if err != nil {
		return nil, err
	}
	prefix := string(metadata[:len(metadata)-1]) + `,"data":"`
	suffix := `"}`
	encoder := &hunyuanBase64Reader{source: io.LimitReader(file, size)}
	return &hunyuanASRBody{
		ctx: ctx, file: file,
		reader: io.MultiReader(strings.NewReader(prefix), encoder, strings.NewReader(suffix)),
		length: int64(len(prefix)+len(suffix)) + ((size+2)/3)*4,
	}, nil
}

func (b *hunyuanASRBody) Read(p []byte) (int, error) {
	if err := b.ctx.Err(); err != nil {
		return 0, err
	}
	return b.reader.Read(p)
}

func (b *hunyuanASRBody) Close() error {
	b.closeOnce.Do(func() { b.closeErr = b.file.Close() })
	return b.closeErr
}

type hunyuanBase64Reader struct {
	source   io.Reader
	raw      [24 * 1024]byte // Multiple of three: padding only appears at EOF.
	encoded  [32 * 1024]byte
	pending  []byte
	terminal error
}

func (r *hunyuanBase64Reader) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if len(r.pending) == 0 {
		if r.terminal != nil {
			return 0, r.terminal
		}
		n, err := io.ReadFull(r.source, r.raw[:])
		if err == io.ErrUnexpectedEOF {
			err = io.EOF
		}
		r.terminal = err
		base64.StdEncoding.Encode(r.encoded[:], r.raw[:n])
		r.pending = r.encoded[:base64.StdEncoding.EncodedLen(n)]
		if n == 0 {
			return 0, err
		}
	}
	n := copy(p, r.pending)
	r.pending = r.pending[n:]
	return n, nil
}
