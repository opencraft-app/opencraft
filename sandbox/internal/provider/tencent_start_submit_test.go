package provider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"
	cvm "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/cvm/v20170312"
)

func TestSubmitStartInstanceOnlySubmitsWhenStopped(t *testing.T) {
	for _, tc := range []struct {
		name, state, startError, afterState string
		wantActions                         []string
		wantError                           bool
	}{
		{name: "running", state: "RUNNING", wantActions: []string{"DescribeInstancesStatus"}},
		{name: "starting", state: "STARTING", wantActions: []string{"DescribeInstancesStatus"}},
		{name: "stopped", state: "STOPPED", wantActions: []string{"DescribeInstancesStatus", "StartInstances"}},
		{name: "in progress", state: "STOPPED", startError: "OperationDenied.InstanceOperationInProgress", afterState: "STARTING", wantActions: []string{"DescribeInstancesStatus", "StartInstances", "DescribeInstancesStatus"}},
		{name: "unsupported", state: "STOPPING", wantActions: []string{"DescribeInstancesStatus"}, wantError: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var actions []string
			statusCalls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				action := r.Header.Get("X-TC-Action")
				actions = append(actions, action)
				response := map[string]any{"RequestId": "req-test"}
				switch action {
				case "DescribeInstancesStatus":
					state := tc.state
					if statusCalls > 0 && tc.afterState != "" {
						state = tc.afterState
					}
					statusCalls++
					response["InstanceStatusSet"] = []any{map[string]any{"InstanceId": "ins-test", "InstanceState": state}}
				case "StartInstances":
					if tc.startError != "" {
						response["Error"] = map[string]any{"Code": tc.startError, "Message": "operation in progress"}
					}
				default:
					t.Errorf("unexpected CVM action %s", action)
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{"Response": response})
			}))
			t.Cleanup(server.Close)
			cp := profile.NewClientProfile()
			cp.HttpProfile.Endpoint = strings.TrimPrefix(server.URL, "http://")
			cp.HttpProfile.Scheme = "http"
			client, err := cvm.NewClient(common.NewCredential("test-only-id", "test-only-key"), "ap-seoul", cp)
			if err != nil {
				t.Fatal(err)
			}
			provider := &TencentCloudProvider{client: client, cfg: TencentConfig{Region: "ap-seoul"}}
			err = provider.SubmitStartInstance(context.Background(), CloudInstanceRef{CloudID: "ins-test", Region: "ap-seoul"})
			if (err != nil) != tc.wantError || !reflect.DeepEqual(actions, tc.wantActions) {
				t.Fatalf("SubmitStartInstance err=%v actions=%v want=%v", err, actions, tc.wantActions)
			}
		})
	}
}
