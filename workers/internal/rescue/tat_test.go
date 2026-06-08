package rescue

import (
	"context"
	"encoding/base64"
	"testing"
	"time"
)

type fakeTATClient struct {
	runCalls      int
	describeCalls int
}

func (f *fakeTATClient) TAT(ctx context.Context, action string, payload map[string]any, dryRun bool) (map[string]any, error) {
	switch action {
	case "RunCommand":
		f.runCalls++
		return map[string]any{"CommandId": "cmd-test", "InvocationId": "inv-test"}, nil
	case "DescribeInvocationTasks":
		f.describeCalls++
		output := base64.StdEncoding.EncodeToString([]byte(`RESCUE_EXPORT_RESULT={"archive":"/tmp/a.tar.gz","device":"/dev/vda1","bytes":12,"sha256":"abc"}`))
		return map[string]any{
			"InvocationTaskSet": []any{
				map[string]any{
					"InvocationId":     "inv-test",
					"InvocationTaskId": "task-test",
					"CommandId":        "cmd-test",
					"TaskStatus":       "SUCCESS",
					"TaskResult": map[string]any{
						"ExitCode": 0,
						"Output":   output,
					},
				},
			},
		}, nil
	default:
		t := ctx.Value("t").(*testing.T)
		t.Fatalf("unexpected TAT action %s", action)
		return nil, nil
	}
}

func TestSubmitAndWaitTATCommandAreSeparate(t *testing.T) {
	client := &fakeTATClient{}
	ctx := context.WithValue(context.Background(), "t", t)
	req := ExportRequest{InstanceID: "ins-test", Execute: true, TATUsername: "root", TATWorkingDirectory: "/root"}

	submitted, err := SubmitTATCommand(ctx, client, req, "rescue-export-archive", "true", 60)
	if err != nil {
		t.Fatal(err)
	}
	if submitted.InvocationID != "inv-test" {
		t.Fatalf("unexpected invocation id: %s", submitted.InvocationID)
	}
	waited, err := WaitTATInvocation(ctx, client, submitted, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if waited.TaskStatus != "SUCCESS" {
		t.Fatalf("unexpected status: %s", waited.TaskStatus)
	}
	if client.runCalls != 1 || client.describeCalls != 1 {
		t.Fatalf("expected one submit and one poll, got submit=%d poll=%d", client.runCalls, client.describeCalls)
	}
}

func TestSleepContextHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	err := sleepContext(ctx, time.Hour)
	if err == nil {
		t.Fatal("expected cancellation error")
	}
	if elapsed := time.Since(start); elapsed > 100*time.Millisecond {
		t.Fatalf("sleep did not return promptly after cancellation: %s", elapsed)
	}
}
