package accesslog

import (
	"encoding/json"
	"io"
	"sync"
)

type StdoutLogger struct {
	mu  sync.Mutex
	enc *json.Encoder
}

func NewStdoutLogger(w io.Writer) *StdoutLogger {
	return &StdoutLogger{
		enc: json.NewEncoder(w),
	}
}

func (l *StdoutLogger) Log(entry Entry) {
	if l == nil || l.enc == nil {
		return
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	_ = l.enc.Encode(entry)
}
