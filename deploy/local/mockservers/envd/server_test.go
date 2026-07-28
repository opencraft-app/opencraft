package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"
	envdprocess "ctl/pkg/adapter/sandbox/envdprocess"
	"ctl/pkg/adapter/sandbox/envdprocessconnect"
)

type recordingStore struct {
	started  []processInvocation
	finished []processResult
}

func (s *recordingStore) Start(_ context.Context, invocation processInvocation) (int64, error) {
	s.started = append(s.started, invocation)
	return int64(len(s.started)), nil
}

func (s *recordingStore) Finish(_ context.Context, id int64, result processResult) error {
	result.ID = id
	s.finished = append(s.finished, result)
	return nil
}

func TestStartStreamsSuccessfulLifecycle(t *testing.T) {
	store := &recordingStore{}
	server := httptest.NewServer(newHTTPHandler(store))
	t.Cleanup(server.Close)

	client := envdprocessconnect.NewProcessClient(
		http.DefaultClient,
		server.URL,
		connect.WithGRPCWeb(),
	)
	req := connect.NewRequest(&envdprocess.StartRequest{
		Process: &envdprocess.ProcessConfig{
			Cmd:  "/bin/bash",
			Args: []string{"-lc", "echo secret-value"},
		},
	})
	req.Header().Set("Host", "49983-sandbox-local-00000000.e2b.app")

	stream, err := client.Start(context.Background(), req)
	if err != nil {
		t.Fatalf("start process: %v", err)
	}

	var pid uint32
	var ended bool
	for stream.Receive() {
		event := stream.Msg().GetEvent()
		if start := event.GetStart(); start != nil {
			pid = start.GetPid()
		}
		if end := event.GetEnd(); end != nil {
			ended = true
			if end.GetExitCode() != 0 || end.GetStatus() != "SUCCESS" {
				t.Fatalf("unexpected terminal event: %+v", end)
			}
		}
	}
	if err := stream.Err(); err != nil {
		t.Fatalf("receive stream: %v", err)
	}
	if pid == 0 || !ended {
		t.Fatalf("missing lifecycle events: pid=%d ended=%t", pid, ended)
	}
}

func TestStartPersistsOnlySanitizedCommandMetadata(t *testing.T) {
	store := &recordingStore{}
	server := httptest.NewServer(newHTTPHandler(store))
	t.Cleanup(server.Close)

	client := envdprocessconnect.NewProcessClient(
		http.DefaultClient,
		server.URL,
		connect.WithGRPCWeb(),
	)
	req := connect.NewRequest(&envdprocess.StartRequest{
		Process: &envdprocess.ProcessConfig{
			Cmd:  "/bin/bash",
			Args: []string{"-lc", "echo secret-value"},
		},
	})
	req.Header().Set("Host", "49983-sandbox-local-00000000.e2b.app")

	stream, err := client.Start(context.Background(), req)
	if err != nil {
		t.Fatalf("start process: %v", err)
	}
	for stream.Receive() {
	}
	if err := stream.Err(); err != nil {
		t.Fatalf("receive stream: %v", err)
	}

	if len(store.started) != 1 || len(store.finished) != 1 {
		t.Fatalf("unexpected lifecycle records: started=%d finished=%d", len(store.started), len(store.finished))
	}
	got := store.started[0]
	if got.SandboxID != "sandbox-local" || got.Executable != "/bin/bash" || got.ArgCount != 2 {
		t.Fatalf("unexpected invocation metadata: %+v", got)
	}
	if got.CommandSHA256 == "" || got.CommandSHA256 == "echo secret-value" {
		t.Fatalf("command was not safely fingerprinted: %q", got.CommandSHA256)
	}
	if store.finished[0].Status != "SUCCESS" || store.finished[0].ExitCode != 0 {
		t.Fatalf("unexpected persisted result: %+v", store.finished[0])
	}
}
