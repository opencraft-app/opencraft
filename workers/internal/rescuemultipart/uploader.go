package rescuemultipart

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"time"
)

var (
	ErrEmptyArchive = errors.New("archive stream is empty")
	ErrTooManyParts = errors.New("archive exceeds multipart part limit")
)

const (
	StageArchive    = "archive"
	StageUploadPart = "upload_part"
	StageComplete   = "complete"
)

type UploadError struct {
	Stage      string
	PartNumber int
	Err        error
}

func (e *UploadError) Error() string {
	if e.PartNumber > 0 {
		return fmt.Sprintf("%s part_number=%d: %v", e.Stage, e.PartNumber, e.Err)
	}
	return fmt.Sprintf("%s: %v", e.Stage, e.Err)
}

func (e *UploadError) Unwrap() error {
	return e.Err
}

type Client interface {
	UploadPart(ctx context.Context, number int, data []byte) (etag string, err error)
	Complete(ctx context.Context, parts []CompletedPart) error
}

type CompletedPart struct {
	Number int
	ETag   string
}

type Options struct {
	PartSize    int
	MaxParts    int
	MaxAttempts int
	Sleep       func(ctx context.Context, attempt int) error
}

type Result struct {
	Bytes         int64
	UploadedBytes int64
	SHA256        string
	PartCount     int
}

type countingHashWriter struct {
	out  io.Writer
	hash io.Writer
	n    int64
}

func (w *countingHashWriter) Write(data []byte) (int, error) {
	n, err := w.out.Write(data)
	if n > 0 {
		_, _ = w.hash.Write(data[:n])
		w.n += int64(n)
	}
	return n, err
}

func Upload(
	ctx context.Context,
	client Client,
	writeArchive func(io.Writer) error,
	options Options,
) (Result, error) {
	if client == nil || writeArchive == nil {
		return Result{}, errors.New("multipart client and archive writer are required")
	}
	if options.PartSize <= 0 || options.MaxParts <= 0 || options.MaxAttempts <= 0 {
		return Result{}, errors.New("multipart options must be positive")
	}
	if options.Sleep == nil {
		options.Sleep = sleepBackoff
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	reader, writer := io.Pipe()
	hash := sha256.New()
	counting := &countingHashWriter{out: writer, hash: hash}
	producerDone := make(chan error, 1)
	go func() {
		err := writeArchive(counting)
		_ = writer.CloseWithError(err)
		producerDone <- err
	}()

	stopProducer := func(cause error) error {
		cancel()
		_ = reader.CloseWithError(cause)
		producerErr := <-producerDone
		if producerErr != nil && !errors.Is(producerErr, io.ErrClosedPipe) {
			return producerErr
		}
		return cause
	}

	buffer := make([]byte, options.PartSize)
	parts := make([]CompletedPart, 0)
	var generatedBytes int64
	var uploadedBytes int64
	for {
		n, readErr := io.ReadFull(reader, buffer)
		generatedBytes += int64(n)
		if readErr != nil && !errors.Is(readErr, io.EOF) && !errors.Is(readErr, io.ErrUnexpectedEOF) {
			cause := stopProducer(readErr)
			return resultFrom(generatedBytes, uploadedBytes, len(parts), hash), cause
		}
		if n > 0 {
			if len(parts) >= options.MaxParts {
				cause := stopProducer(ErrTooManyParts)
				return resultFrom(generatedBytes, uploadedBytes, len(parts), hash), cause
			}
			partNumber := len(parts) + 1
			etag, err := uploadPart(ctx, client, partNumber, buffer[:n], options)
			if err != nil {
				cause := stopProducer(err)
				return resultFrom(generatedBytes, uploadedBytes, len(parts), hash), cause
			}
			parts = append(parts, CompletedPart{Number: partNumber, ETag: etag})
			uploadedBytes += int64(n)
		}
		if readErr != nil {
			break
		}
	}

	if producerErr := <-producerDone; producerErr != nil {
		return resultFrom(generatedBytes, uploadedBytes, len(parts), hash), producerErr
	}
	if len(parts) == 0 {
		return resultFrom(generatedBytes, uploadedBytes, 0, hash), ErrEmptyArchive
	}
	if err := client.Complete(ctx, parts); err != nil {
		return resultFrom(generatedBytes, uploadedBytes, len(parts), hash), &UploadError{
			Stage: StageComplete,
			Err:   fmt.Errorf("complete multipart upload: %w", err),
		}
	}
	return resultFrom(generatedBytes, uploadedBytes, len(parts), hash), nil
}

func uploadPart(ctx context.Context, client Client, number int, data []byte, options Options) (string, error) {
	var lastErr error
	for attempt := 1; attempt <= options.MaxAttempts; attempt++ {
		etag, err := client.UploadPart(ctx, number, data)
		if err == nil {
			if etag == "" {
				return "", fmt.Errorf("upload part %d returned empty ETag", number)
			}
			return etag, nil
		}
		lastErr = err
		if attempt == options.MaxAttempts {
			break
		}
		if err := options.Sleep(ctx, attempt); err != nil {
			return "", err
		}
	}
	return "", &UploadError{
		Stage:      StageUploadPart,
		PartNumber: number,
		Err:        fmt.Errorf("upload part after %d attempts: %w", options.MaxAttempts, lastErr),
	}
}

func resultFrom(generatedBytes, uploadedBytes int64, partCount int, hash interface{ Sum([]byte) []byte }) Result {
	return Result{
		Bytes:         generatedBytes,
		UploadedBytes: uploadedBytes,
		SHA256:        hex.EncodeToString(hash.Sum(nil)),
		PartCount:     partCount,
	}
}

func sleepBackoff(ctx context.Context, attempt int) error {
	delay := time.Duration(1<<(attempt-1)) * time.Second
	if delay > 8*time.Second {
		delay = 8 * time.Second
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
