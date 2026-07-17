package observability

import (
	"errors"
	"io"
	"sync"
	"sync/atomic"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

type DropCounters struct {
	Encode   atomic.Uint64
	Oversize atomic.Uint64
	Write    atomic.Uint64
}

type jsonLineWriter struct {
	mu       sync.Mutex
	output   io.Writer
	maxBytes int
	drops    *DropCounters
	marshal  protojson.MarshalOptions
}

func newJSONLineWriter(output io.Writer, maxBytes int, drops *DropCounters) *jsonLineWriter {
	if maxBytes <= 0 {
		maxBytes = 32 * 1024
	}
	return &jsonLineWriter{
		output:   output,
		maxBytes: maxBytes,
		drops:    drops,
		marshal: protojson.MarshalOptions{
			UseEnumNumbers: true,
		},
	}
}

func (w *jsonLineWriter) WriteProto(message proto.Message) error {
	if w == nil || w.output == nil {
		return errors.New("OTLP JSON writer is not configured")
	}
	raw, err := w.marshal.Marshal(message)
	if err != nil {
		if w.drops != nil {
			w.drops.Encode.Add(1)
		}
		return err
	}
	if len(raw)+1 > w.maxBytes {
		if w.drops != nil {
			w.drops.Oversize.Add(1)
		}
		return errors.New("OTLP JSON record exceeds configured line limit")
	}
	raw = append(raw, '\n')
	w.mu.Lock()
	defer w.mu.Unlock()
	_, err = w.output.Write(raw)
	if err != nil && w.drops != nil {
		w.drops.Write.Add(1)
	}
	return err
}
