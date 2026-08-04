package hermesgateway

import (
	"bufio"
	"context"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
)

func TestTransportCorrelatesOutOfOrderResponses(t *testing.T) {
	t.Parallel()

	client, server := newTransportPipe(t, 1024*1024)
	type callResult struct {
		value string
		err   error
	}
	results := make(chan callResult, 2)
	for _, method := range []string{"first", "second"} {
		method := method
		go func() {
			var result struct {
				Value string `json:"value"`
			}
			err := client.Call(context.Background(), method, nil, &result)
			results <- callResult{value: result.Value, err: err}
		}()
	}

	requests := readRequests(t, server.reader, 2)
	writeFrame(t, server.writer, map[string]any{
		"jsonrpc": "2.0",
		"id":      requests[1].ID,
		"result":  map[string]any{"value": requests[1].Method},
	})
	writeFrame(t, server.writer, map[string]any{
		"jsonrpc": "2.0",
		"id":      requests[0].ID,
		"result":  map[string]any{"value": requests[0].Method},
	})

	got := map[string]bool{}
	for range 2 {
		result := <-results
		if result.err != nil {
			t.Fatal(result.err)
		}
		got[result.value] = true
	}
	if !got["first"] || !got["second"] {
		t.Fatalf("out-of-order results = %#v", got)
	}
}

func TestTransportPublishesGatewayEventsAndIgnoresUnknownNotifications(t *testing.T) {
	t.Parallel()

	client, server := newTransportPipe(t, 1024*1024)
	writeFrame(t, server.writer, map[string]any{
		"jsonrpc": "2.0",
		"method":  "unknown.notification",
		"params":  map[string]any{"future": true},
	})
	writeFrame(t, server.writer, map[string]any{
		"jsonrpc": "2.0",
		"method":  "event",
		"params": map[string]any{
			"type":       "message.complete",
			"session_id": "session-1",
			"payload":    map[string]any{"text": "done"},
		},
	})

	select {
	case event := <-client.Events():
		if event.Type != "message.complete" ||
			event.SessionID != "session-1" {
			t.Fatalf("event = %#v", event)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Gateway event was not published")
	}
	select {
	case <-client.Done():
		t.Fatalf("unknown notification stopped transport: %v", client.Err())
	default:
	}
}

func TestTransportRejectsMalformedJSONAndOversizedFrames(t *testing.T) {
	t.Parallel()

	for _, testCase := range []struct {
		name            string
		limit           int
		line            string
		allowWriteError bool
	}{
		{name: "malformed object", limit: 1024, line: "{\"jsonrpc\":"},
		{
			name:            "oversized",
			limit:           32,
			line:            `{"jsonrpc":"2.0","method":"event","params":{"type":"too-large"}}`,
			allowWriteError: true,
		},
	} {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			client, server := newTransportPipe(t, testCase.limit)
			if _, err := io.WriteString(
				server.writer,
				testCase.line+"\n",
			); err != nil && !testCase.allowWriteError {
				t.Fatal(err)
			}
			select {
			case <-client.Done():
				if client.Err() == nil {
					t.Fatal("protocol failure has no terminal error")
				}
			case <-time.After(3 * time.Second):
				t.Fatal("protocol failure did not stop transport")
			}
		})
	}
}

func TestTransportTreatsPlainStdoutAsDiagnostic(t *testing.T) {
	t.Parallel()

	client, server := newTransportPipe(t, 1024)
	if _, err := io.WriteString(server.writer, "Hermes startup diagnostic\n"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(25 * time.Millisecond)
	select {
	case <-client.Done():
		t.Fatalf("plain diagnostic stopped transport: %v", client.Err())
	default:
	}
}

func TestTransportCancelledCallIgnoresOneLateResponse(t *testing.T) {
	t.Parallel()

	client, server := newTransportPipe(t, 1024*1024)
	ctx, cancel := context.WithCancel(context.Background())
	callDone := make(chan error, 1)
	go func() {
		callDone <- client.Call(ctx, "cancelled", nil, nil)
	}()
	request := readRequests(t, server.reader, 1)[0]
	cancel()
	if err := <-callDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("Call() error = %v", err)
	}
	writeFrame(t, server.writer, map[string]any{
		"jsonrpc": "2.0",
		"id":      request.ID,
		"result":  map[string]any{},
	})
	time.Sleep(25 * time.Millisecond)
	select {
	case <-client.Done():
		t.Fatalf("late cancelled response stopped transport: %v", client.Err())
	default:
	}
}

func TestTransportUnknownOrDuplicateResponseStopsConnection(t *testing.T) {
	t.Parallel()

	t.Run("unknown", func(t *testing.T) {
		t.Parallel()

		client, server := newTransportPipe(t, 1024)
		writeFrame(t, server.writer, map[string]any{
			"jsonrpc": "2.0",
			"id":      9001,
			"result":  map[string]any{},
		})
		waitForTransportFailure(t, client)
	})

	t.Run("duplicate", func(t *testing.T) {
		t.Parallel()

		client, server := newTransportPipe(t, 1024)
		callDone := make(chan error, 1)
		go func() {
			callDone <- client.Call(context.Background(), "once", nil, nil)
		}()
		request := readRequests(t, server.reader, 1)[0]
		frame := map[string]any{
			"jsonrpc": "2.0",
			"id":      request.ID,
			"result":  map[string]any{},
		}
		writeFrame(t, server.writer, frame)
		if err := <-callDone; err != nil {
			t.Fatal(err)
		}
		writeFrame(t, server.writer, frame)
		waitForTransportFailure(t, client)
	})
}

type transportPipeServer struct {
	reader io.Reader
	writer io.Writer
}

func newTransportPipe(
	t *testing.T,
	maximumFrameBytes int,
) (*transport, transportPipeServer) {
	t.Helper()

	clientReader, serverWriter := io.Pipe()
	serverReader, clientWriter := io.Pipe()
	client := newTransport(
		clientReader,
		clientWriter,
		transportOptions{MaximumFrameBytes: maximumFrameBytes},
	)
	t.Cleanup(func() {
		client.Close()
		_ = clientReader.Close()
		_ = clientWriter.Close()
		_ = serverReader.Close()
		_ = serverWriter.Close()
	})
	return client, transportPipeServer{
		reader: serverReader,
		writer: serverWriter,
	}
}

type testRequest struct {
	ID     int64  `json:"id"`
	Method string `json:"method"`
}

func readRequests(t *testing.T, reader io.Reader, count int) []testRequest {
	t.Helper()

	requests := make([]testRequest, 0, count)
	scanner := bufio.NewScanner(reader)
	for len(requests) < count && scanner.Scan() {
		var request testRequest
		if err := common.UnmarshalJsonStr(scanner.Text(), &request); err != nil {
			t.Fatal(err)
		}
		requests = append(requests, request)
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if len(requests) != count {
		t.Fatalf("read %d requests, want %d", len(requests), count)
	}
	return requests
}

var testWriteMu sync.Mutex

func writeFrame(t *testing.T, writer io.Writer, frame any) {
	t.Helper()

	data, err := common.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}
	testWriteMu.Lock()
	defer testWriteMu.Unlock()
	if _, err := writer.Write(append(data, '\n')); err != nil {
		t.Fatal(err)
	}
}

func waitForTransportFailure(t *testing.T, client *transport) {
	t.Helper()

	select {
	case <-client.Done():
		if client.Err() == nil {
			t.Fatal("transport stopped without a terminal error")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("transport did not stop")
	}
}
