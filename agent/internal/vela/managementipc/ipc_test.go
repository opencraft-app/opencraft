//go:build darwin || linux

package managementipc

import (
	"context"
	"encoding/binary"
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
)

const testRequestID = "018f0c9e-7b18-7abc-8def-0123456789ab"

func TestClientAndServerUseVersionedLengthPrefixedFrames(t *testing.T) {
	t.Parallel()

	socketPath := shortSocketPath(t)
	server, err := Listen(socketPath, HandlerFunc(
		func(
			_ context.Context,
			request Request,
			sender Sender,
		) error {
			if request.Method != "status.get" {
				t.Fatalf("method = %q", request.Method)
			}
			return sender.Result(map[string]any{
				"online": true,
				"agents": 2,
			})
		},
	))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	info, err := os.Stat(socketPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("socket mode = %o", info.Mode().Perm())
	}

	client := NewClient(socketPath, "test-version")
	var result struct {
		Online bool `json:"online"`
		Agents int  `json:"agents"`
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Call(
		ctx,
		testRequestID,
		"status.get",
		map[string]any{},
		&result,
	); err != nil {
		t.Fatal(err)
	}
	if !result.Online || result.Agents != 2 {
		t.Fatalf("result = %#v", result)
	}
}

func TestServerRejectsProtocolMismatchWithStableError(t *testing.T) {
	t.Parallel()

	socketPath := shortSocketPath(t)
	server, err := Listen(
		socketPath,
		HandlerFunc(func(context.Context, Request, Sender) error {
			t.Fatal("handler called for incompatible protocol")
			return nil
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })

	connection, err := net.Dial("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	request := Request{
		Protocol:      "vela.ipc.v0",
		RequestID:     testRequestID,
		ClientVersion: "test-version",
		Method:        "status.get",
	}
	data, err := common.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeRawFrame(connection, data); err != nil {
		t.Fatal(err)
	}
	var response Response
	if err := readFrame(connection, &response); err != nil {
		t.Fatal(err)
	}
	if response.Type != FrameError ||
		response.Error == nil ||
		response.Error.Code != "protocol_unsupported" ||
		response.RequestID != testRequestID {
		t.Fatalf("response = %#v", response)
	}
}

func TestReadFrameRejectsOversizedPayloadBeforeAllocation(t *testing.T) {
	t.Parallel()

	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()
	go func() {
		var prefix [4]byte
		binary.BigEndian.PutUint32(
			prefix[:],
			uint32(MaximumFrameBytes+1),
		)
		_, _ = server.Write(prefix[:])
	}()
	var destination map[string]any
	if err := readFrame(client, &destination); !errors.Is(
		err,
		ErrFrameTooLarge,
	) {
		t.Fatalf("error = %v, want ErrFrameTooLarge", err)
	}
}

func TestClientStreamsEventsUntilEnd(t *testing.T) {
	t.Parallel()

	socketPath := shortSocketPath(t)
	server, err := Listen(socketPath, HandlerFunc(
		func(
			_ context.Context,
			request Request,
			sender Sender,
		) error {
			if request.Method != "logs.tail" {
				t.Fatalf("method = %q", request.Method)
			}
			if err := sender.Event(map[string]string{
				"message": "第一行",
			}); err != nil {
				return err
			}
			if err := sender.Event(map[string]string{
				"message": "第二行",
			}); err != nil {
				return err
			}
			return sender.End()
		},
	))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	client := NewClient(socketPath, "test-version")
	var messages []string
	if err := client.Stream(
		context.Background(),
		testRequestID,
		"logs.tail",
		map[string]any{"lines": 2},
		func(response Response) error {
			var event struct {
				Message string `json:"message"`
			}
			if err := common.Unmarshal(response.Event, &event); err != nil {
				return err
			}
			messages = append(messages, event.Message)
			return nil
		},
	); err != nil {
		t.Fatal(err)
	}
	if len(messages) != 2 ||
		messages[0] != "第一行" ||
		messages[1] != "第二行" {
		t.Fatalf("messages = %#v", messages)
	}
}

func writeRawFrame(connection net.Conn, payload []byte) error {
	var prefix [4]byte
	binary.BigEndian.PutUint32(prefix[:], uint32(len(payload)))
	if _, err := connection.Write(prefix[:]); err != nil {
		return err
	}
	_, err := connection.Write(payload)
	return err
}

func shortSocketPath(t *testing.T) string {
	t.Helper()
	directory, err := os.MkdirTemp("", "vela-ipc-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	return filepath.Join(directory, "daemon.sock")
}
