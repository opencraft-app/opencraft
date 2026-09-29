package provider

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	tcerrors "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/errors"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"
	cvm "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/cvm/v20170312"
)

func TestClassifyStopInstanceError(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want stopInstanceErrorAction
	}{
		{
			name: "instance not found",
			err:  tcerrors.NewTencentCloudSDKError("InvalidInstanceId.NotFound", "missing", "req-test"),
			want: stopInstanceErrorNotFound,
		},
		{
			name: "already stopped",
			err:  tcerrors.NewTencentCloudSDKError("UnsupportedOperation.InstanceStateStopped", "stopped", "req-test"),
			want: stopInstanceErrorAlreadyStopped,
		},
		{
			name: "operation in progress",
			err:  tcerrors.NewTencentCloudSDKError("OperationDenied.InstanceOperationInProgress", "busy", "req-test"),
			want: stopInstanceErrorRetryRequest,
		},
		{
			name: "instance stopping",
			err:  tcerrors.NewTencentCloudSDKError("UnsupportedOperation.InstanceStateStopping", "stopping", "req-test"),
			want: stopInstanceErrorPollStatus,
		},
		{
			name: "already stop charging",
			err:  tcerrors.NewTencentCloudSDKError("UnsupportedOperation.StoppedModeStopCharging", "stop charging", "req-test"),
			want: stopInstanceErrorPollStatus,
		},
		{
			name: "unknown sdk error",
			err:  tcerrors.NewTencentCloudSDKError("InternalError", "unknown", "req-test"),
			want: stopInstanceErrorUnhandled,
		},
		{
			name: "plain error",
			err:  errors.New("plain error"),
			want: stopInstanceErrorUnhandled,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := classifyStopInstanceError(test.err); got != test.want {
				t.Fatalf("classifyStopInstanceError()=%v want=%v", got, test.want)
			}
		})
	}
}

func TestStopInstanceChecksStatusBeforeSubmitting(t *testing.T) {
	tests := []struct {
		name          string
		initialState  string
		stopErrorCode string
		wantActions   []string
		wantError     bool
	}{
		{
			name:         "stopped returns idempotent success",
			initialState: "STOPPED",
			wantActions:  []string{"DescribeInstancesStatus"},
		},
		{
			name:         "stopping is already accepted",
			initialState: "STOPPING",
			wantActions:  []string{"DescribeInstancesStatus"},
		},
		{
			name:         "running submits asynchronous stop",
			initialState: "RUNNING",
			wantActions:  []string{"DescribeInstancesStatus", "StopInstances"},
		},
		{
			name:         "unsupported transitional state fails",
			initialState: "PENDING",
			wantActions:  []string{"DescribeInstancesStatus"},
			wantError:    true,
		},
		{
			name:          "running race to stopping is accepted",
			initialState:  "RUNNING",
			stopErrorCode: "UnsupportedOperation.StoppedModeStopCharging",
			wantActions:   []string{"DescribeInstancesStatus", "StopInstances"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			actions := []string{}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				action := r.Header.Get("X-TC-Action")
				actions = append(actions, action)
				response := map[string]any{"RequestId": "req-test"}
				switch action {
				case "StopInstances":
					if test.stopErrorCode != "" {
						response["Error"] = map[string]any{"Code": test.stopErrorCode, "Message": "test stop state"}
					}
				case "DescribeInstancesStatus":
					response["InstanceStatusSet"] = []any{map[string]any{
						"InstanceId":    "ins-test",
						"InstanceState": test.initialState,
					}}
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

			err = provider.StopInstance(context.Background(), CloudInstanceRef{CloudID: "ins-test", Region: "ap-seoul"})
			if (err != nil) != test.wantError {
				t.Fatalf("StopInstance() error=%v wantError=%v", err, test.wantError)
			}
			if !reflect.DeepEqual(actions, test.wantActions) {
				t.Fatalf("actions=%v want=%v", actions, test.wantActions)
			}
		})
	}
}

func TestStopInstanceWithModeWaitsForStopped(t *testing.T) {
	actions := []string{}
	statusCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		action := r.Header.Get("X-TC-Action")
		actions = append(actions, action)
		response := map[string]any{"RequestId": "req-test"}
		switch action {
		case "StopInstances":
		case "DescribeInstancesStatus":
			state := "RUNNING"
			if statusCalls > 0 {
				state = "STOPPED"
			}
			statusCalls++
			response["InstanceStatusSet"] = []any{map[string]any{
				"InstanceId":    "ins-test",
				"InstanceState": state,
			}}
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
	cloud := &TencentCloudProvider{client: client, cfg: TencentConfig{Region: "ap-seoul"}}

	err = cloud.stopInstanceWithMode(
		context.Background(),
		CloudInstanceRef{CloudID: "ins-test", Region: "ap-seoul"},
		"KEEP_CHARGING",
	)
	if err != nil {
		t.Fatalf("stopInstanceWithMode() error=%v", err)
	}
	want := []string{"DescribeInstancesStatus", "StopInstances", "DescribeInstancesStatus"}
	if !reflect.DeepEqual(actions, want) {
		t.Fatalf("actions=%v want=%v", actions, want)
	}
}
