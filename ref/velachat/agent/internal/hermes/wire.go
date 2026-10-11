package hermes

import (
	"context"
	"errors"
	"io"
	"sync/atomic"
)

var ErrAmbiguousFrameWrite = errors.New("Hermes ACP frame write was ambiguous")
var ErrTerminalFrameWrite = errors.New("Hermes ACP frame write terminated the transport")

type unsentPromptWriteError struct {
	cause error
}

func (err *unsentPromptWriteError) Error() string {
	if err == nil || err.cause == nil {
		return "Hermes ACP prompt was not written"
	}
	return "Hermes ACP prompt was not written: " + err.cause.Error()
}

func (err *unsentPromptWriteError) Unwrap() error {
	if err == nil {
		return nil
	}
	return err.cause
}

type ambiguousFrameWriteError struct {
	cause error
}

type terminalFrameWriteError struct {
	cause error
}

func (err *terminalFrameWriteError) Error() string {
	if err == nil || err.cause == nil {
		return ErrTerminalFrameWrite.Error()
	}
	return ErrTerminalFrameWrite.Error() + ": " + err.cause.Error()
}

func (err *terminalFrameWriteError) Unwrap() []error {
	if err == nil || err.cause == nil {
		return []error{ErrTerminalFrameWrite}
	}
	return []error{ErrTerminalFrameWrite, err.cause}
}

func (err *ambiguousFrameWriteError) Error() string {
	if err == nil || err.cause == nil {
		return ErrAmbiguousFrameWrite.Error()
	}
	return ErrAmbiguousFrameWrite.Error() + ": " + err.cause.Error()
}

func (err *ambiguousFrameWriteError) Unwrap() []error {
	if err == nil || err.cause == nil {
		return []error{ErrAmbiguousFrameWrite}
	}
	return []error{ErrAmbiguousFrameWrite, err.cause}
}

func isUnsentPromptWrite(err error) bool {
	var unsent *unsentPromptWriteError
	return errors.As(err, &unsent)
}

type frameWriteStatus uint8

const (
	frameWriteUnsent frameWriteStatus = iota
	frameWriteCommitted
	frameWriteAmbiguous
)

type frameWriteResult struct {
	Status       frameWriteStatus
	BytesWritten int
	Err          error
}

type contextualFrameWrite struct {
	frameWriteResult
	CancellationWon bool
}

func writeFrame(writer io.Writer, frame []byte) frameWriteResult {
	written := 0
	for written < len(frame) {
		n, err := writer.Write(frame[written:])
		if n < 0 || n > len(frame)-written {
			return classifyFrameWrite(written, io.ErrShortWrite, len(frame))
		}
		written += n
		if written == len(frame) {
			return frameWriteResult{
				Status:       frameWriteCommitted,
				BytesWritten: written,
				Err:          err,
			}
		}
		if err != nil {
			return classifyFrameWrite(written, err, len(frame))
		}
		if n == 0 {
			return classifyFrameWrite(written, io.ErrNoProgress, len(frame))
		}
	}
	return frameWriteResult{
		Status:       frameWriteCommitted,
		BytesWritten: written,
	}
}

func classifyFrameWrite(written int, err error, frameLength int) frameWriteResult {
	status := frameWriteAmbiguous
	switch {
	case written == 0:
		status = frameWriteUnsent
	case written == frameLength:
		status = frameWriteCommitted
	}
	return frameWriteResult{
		Status:       status,
		BytesWritten: written,
		Err:          err,
	}
}

func writeFrameContext(
	ctx context.Context,
	writer io.Writer,
	frame []byte,
	abort func(),
) contextualFrameWrite {
	const (
		writeInFlight uint32 = iota
		writeCompleted
		writeCancellationWon
	)
	var state atomic.Uint32
	result := make(chan frameWriteResult, 1)
	go func() {
		written := writeFrame(writer, frame)
		state.CompareAndSwap(writeInFlight, writeCompleted)
		result <- written
	}()

	select {
	case written := <-result:
		return contextualFrameWrite{frameWriteResult: written}
	case <-ctx.Done():
		if state.CompareAndSwap(writeInFlight, writeCancellationWon) {
			if abort != nil {
				abort()
			}
			written := <-result
			return contextualFrameWrite{
				frameWriteResult: written,
				CancellationWon:  true,
			}
		}
		written := <-result
		return contextualFrameWrite{frameWriteResult: written}
	}
}

type wireGate struct {
	token chan struct{}
}

func newWireGate() *wireGate {
	gate := &wireGate{token: make(chan struct{}, 1)}
	gate.token <- struct{}{}
	return gate
}

func (gate *wireGate) Acquire(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-gate.token:
		return nil
	}
}

func (gate *wireGate) Release() {
	gate.token <- struct{}{}
}
