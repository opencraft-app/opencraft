package hermes

import (
	"context"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	"velachat/agent/internal/runtimeapi"
)

var errWireTest = errors.New("wire test failure")

type scriptedWriter struct {
	n   int
	err error
}

func (writer scriptedWriter) Write(payload []byte) (int, error) {
	n := writer.n
	if n > len(payload) {
		n = len(payload)
	}
	return n, writer.err
}

func TestWriteFrameClassifiesDeliveryCertainty(t *testing.T) {
	t.Parallel()

	frame := []byte("{\"jsonrpc\":\"2.0\"}\n")
	tests := []struct {
		name       string
		writer     io.Writer
		wantStatus frameWriteStatus
		wantBytes  int
	}{
		{
			name:       "unsent",
			writer:     scriptedWriter{err: errWireTest},
			wantStatus: frameWriteUnsent,
		},
		{
			name:       "ambiguous",
			writer:     scriptedWriter{n: 5, err: errWireTest},
			wantStatus: frameWriteAmbiguous,
			wantBytes:  5,
		},
		{
			name:       "committed with error",
			writer:     scriptedWriter{n: len(frame), err: errWireTest},
			wantStatus: frameWriteCommitted,
			wantBytes:  len(frame),
		},
		{
			name:       "committed",
			writer:     &chunkWriter{maximum: 3},
			wantStatus: frameWriteCommitted,
			wantBytes:  len(frame),
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			result := writeFrame(test.writer, frame)
			if result.Status != test.wantStatus ||
				result.BytesWritten != test.wantBytes {
				t.Fatalf("writeFrame = %#v", result)
			}
		})
	}
}

type chunkWriter struct {
	maximum int
}

func (writer *chunkWriter) Write(payload []byte) (int, error) {
	if len(payload) > writer.maximum {
		payload = payload[:writer.maximum]
	}
	return len(payload), nil
}

func TestWireGateHonorsCancellationBeforeAcquisition(t *testing.T) {
	t.Parallel()

	gate := newWireGate()
	if err := gate.Acquire(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := gate.Acquire(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Acquire error = %v", err)
	}
	gate.Release()
}

type blockingWriter struct {
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (writer *blockingWriter) Write(payload []byte) (int, error) {
	writer.once.Do(func() { close(writer.started) })
	<-writer.release
	return 0, errWireTest
}

func TestWriteFrameContextJoinsCancelledWriter(t *testing.T) {
	t.Parallel()

	writer := &blockingWriter{
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	ctx, cancel := context.WithCancel(context.Background())
	aborted := make(chan struct{})
	result := make(chan contextualFrameWrite, 1)
	go func() {
		result <- writeFrameContext(ctx, writer, []byte("frame\n"), func() {
			close(aborted)
			close(writer.release)
		})
	}()
	<-writer.started
	cancel()
	select {
	case <-aborted:
	case <-time.After(time.Second):
		t.Fatal("cancel did not abort the blocked Writer")
	}
	select {
	case got := <-result:
		if !got.CancellationWon || got.Status != frameWriteUnsent {
			t.Fatalf("cancelled write = %#v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("writeFrameContext returned with a detached Writer")
	}
}

type closingBlockingWriter struct {
	started chan struct{}
	closed  chan struct{}
	once    sync.Once
}

func (writer *closingBlockingWriter) Write([]byte) (int, error) {
	writer.once.Do(func() { close(writer.started) })
	<-writer.closed
	return 0, io.ErrClosedPipe
}

func (writer *closingBlockingWriter) Close() error {
	select {
	case <-writer.closed:
	default:
		close(writer.closed)
	}
	return nil
}

func TestCancelledInFlightPromptIsNotRetryable(t *testing.T) {
	t.Parallel()

	writer := &closingBlockingWriter{
		started: make(chan struct{}),
		closed:  make(chan struct{}),
	}
	session := &session{
		stdin:   writer,
		wire:    newWireGate(),
		events:  make(chan runtimeapi.Event, 4),
		pending: make(map[int64]pendingCall),
		done:    make(chan struct{}),
	}
	session.initActionDispatcher()
	defer session.closeEvents()
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		result <- session.sendPrompt(ctx, map[string]any{"prompt": []any{}}, false)
	}()
	<-writer.started
	cancel()
	err := <-result
	if err == nil {
		t.Fatal("cancelled in-flight prompt returned success")
	}
	if isUnsentPromptWrite(err) {
		t.Fatalf("cancelled in-flight prompt became retryable: %v", err)
	}
}
