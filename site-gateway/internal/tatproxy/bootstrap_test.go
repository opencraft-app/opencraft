package tatproxy

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
)

type recordedCloudCall struct {
	service    string
	action     string
	region     string
	endpoint   string
	parameters map[string]any
}

type fakeCloudCaller struct {
	mu    sync.Mutex
	calls []recordedCloudCall
}

func (c *fakeCloudCaller) Call(_ context.Context, service, _, action, region, endpoint string, parameters map[string]any, response any) error {
	c.mu.Lock()
	c.calls = append(c.calls, recordedCloudCall{service: service, action: action, region: region, endpoint: endpoint, parameters: parameters})
	c.mu.Unlock()
	var raw []byte
	switch action {
	case "DescribeAccountInfo":
		raw = []byte(`{"Response":{"OwnerUin":10001,"AppId":1250000000}}`)
	case "StartSession":
		raw = []byte(`{"Response":{"SessionId":"session-1"}}`)
	default:
		return fmt.Errorf("unexpected action %s", action)
	}
	return json.Unmarshal(raw, response)
}

func TestCloudStarterCachesAccountAndStartsRequestedTarget(t *testing.T) {
	caller := &fakeCloudCaller{}
	starter := &CloudStarter{caller: caller}
	target := Target{Region: "ap-beijing", InstanceID: "ins-test123"}
	for range 2 {
		got, err := starter.Start(context.Background(), target)
		if err != nil {
			t.Fatalf("Start() error = %v", err)
		}
		if got.SessionID != "session-1" || got.OwnerUIN != "10001" || got.AppID != 1250000000 || got.WSURL != "wss://ap-beijing.forward.tat-tc.tencent.cn/ws" {
			t.Fatalf("bootstrap = %+v", got)
		}
	}
	caller.mu.Lock()
	defer caller.mu.Unlock()
	if len(caller.calls) != 3 {
		t.Fatalf("calls = %d, want one account call and two StartSession calls", len(caller.calls))
	}
	if caller.calls[0].service != accountService || caller.calls[0].region != accountRegion || caller.calls[0].endpoint != accountEndpoint {
		t.Fatalf("account call = %+v", caller.calls[0])
	}
	for _, call := range caller.calls[1:] {
		if call.action != "StartSession" || call.region != target.Region || call.parameters["InstanceId"] != target.InstanceID {
			t.Fatalf("StartSession call = %+v", call)
		}
	}
}
