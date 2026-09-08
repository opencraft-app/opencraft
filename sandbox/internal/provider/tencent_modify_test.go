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

// Run the real SDK/provider against a CVM-shaped endpoint, including billing
// mode transitions. No real cloud credentials or network mutations are used.
func resizeTestProvider(t *testing.T, state, mode, instanceType string, settleStates ...string) (*TencentCloudProvider, *[]string) {
	t.Helper()
	mutations := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in map[string]any
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			t.Error(err)
		}
		action := r.Header.Get("X-TC-Action")
		response := map[string]any{"RequestId": "req-test"}
		switch action {
		case "DescribeInstances":
			response["InstanceSet"] = []any{map[string]any{"InstanceId": "ins-test", "InstanceType": instanceType, "InstanceState": state, "StopChargingMode": mode, "SystemDisk": map[string]any{"DiskSize": 50}}}
			if len(settleStates) > 0 {
				state, settleStates = settleStates[0], settleStates[1:]
			}
		case "DescribeInstancesStatus":
			response["InstanceStatusSet"] = []any{map[string]any{"InstanceId": "ins-test", "InstanceState": state}}
		case "StartInstances":
			mutations = append(mutations, action)
			state = "RUNNING"
			mode = "NOT_APPLICABLE"
		case "StopInstances":
			mutations = append(mutations, action+":"+in["StoppedMode"].(string))
			state = "STOPPED"
			mode = in["StoppedMode"].(string)
		case "ResetInstancesType":
			mutations = append(mutations, action)
			if mode == "STOP_CHARGING" {
				response["Error"] = map[string]any{"Code": "UnsupportedOperation.StoppedModeStopChargingSameFamily", "Message": "cannot resize stop-charging instance"}
			} else {
				instanceType = in["InstanceType"].(string)
				state = "RUNNING"
				mode = "NOT_APPLICABLE"
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
	return &TencentCloudProvider{client: client}, &mutations
}

func TestResizeInstanceTypeRecoversStoppedBillingMode(t *testing.T) {
	p, calls := resizeTestProvider(t, "STOPPED", "STOP_CHARGING", "SA5.MEDIUM4")
	if err := p.ResizeInstanceType(context.Background(), "ins-test", "SA5.LARGE8"); err != nil {
		t.Fatal(err)
	}
	want := []string{"StartInstances", "StopInstances:KEEP_CHARGING", "ResetInstancesType"}
	if !reflect.DeepEqual(*calls, want) {
		t.Fatalf("mutations=%v want=%v", *calls, want)
	}
	if err := p.ResizeInstanceType(context.Background(), "ins-test", "SA5.LARGE8"); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(*calls, want) {
		t.Fatalf("completed retry mutated cloud: %v", *calls)
	}
}

func TestResizeInstanceTypeRecoversRestartedAttempt(t *testing.T) {
	p, calls := resizeTestProvider(t, "RUNNING", "NOT_APPLICABLE", "SA5.MEDIUM4")
	if err := p.ResizeInstanceType(context.Background(), "ins-test", "SA5.LARGE8"); err != nil {
		t.Fatal(err)
	}
	want := []string{"StopInstances:KEEP_CHARGING", "ResetInstancesType"}
	if !reflect.DeepEqual(*calls, want) {
		t.Fatalf("mutations=%v want=%v", *calls, want)
	}
}

func TestOrdinaryPauseStillStopsCharging(t *testing.T) {
	p, calls := resizeTestProvider(t, "RUNNING", "NOT_APPLICABLE", "SA5.MEDIUM4")
	if err := p.StopInstance(context.Background(), "ins-test"); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(*calls, []string{"StopInstances:STOP_CHARGING"}) {
		t.Fatalf("pause mutated billing semantics: %v", *calls)
	}
}

func TestResizeStoppedUnknownBillingModeDoesNotMutateCloud(t *testing.T) {
	for _, mode := range []string{"", "FUTURE_UNKNOWN_MODE"} {
		t.Run(mode, func(t *testing.T) {
			p, calls := resizeTestProvider(t, "STOPPED", mode, "SA5.MEDIUM4")
			if err := p.ResizeInstanceType(context.Background(), "ins-test", "SA5.LARGE8"); err == nil {
				t.Fatal("unknown stopped billing mode was accepted")
			}
			if len(*calls) != 0 {
				t.Fatalf("unknown mode mutated cloud: %v", *calls)
			}
		})
	}
}

func TestResizeStopResumesTransientState(t *testing.T) {
	for _, tc := range []struct {
		state, mode, settled string
		want                 []string
	}{
		{"STARTING", "NOT_APPLICABLE", "RUNNING", []string{"StopInstances:KEEP_CHARGING"}},
		{"STOPPING", "KEEP_CHARGING", "STOPPED", []string{}},
		{"STOPPING", "STOP_CHARGING", "STOPPED", []string{"StartInstances", "StopInstances:KEEP_CHARGING"}},
	} {
		t.Run(tc.state+tc.mode, func(t *testing.T) {
			p, calls := resizeTestProvider(t, tc.state, tc.mode, "SA5.MEDIUM4", tc.settled)
			if err := p.StopInstanceForResize(context.Background(), "ins-test"); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(*calls, tc.want) {
				t.Fatalf("mutations=%v want=%v", *calls, tc.want)
			}
		})
	}
}

func TestResizeTargetAlreadyReachedNeverRestartsInstance(t *testing.T) {
	for _, tc := range []struct{ state, mode string }{
		{"RUNNING", "NOT_APPLICABLE"}, {"STOPPED", "KEEP_CHARGING"},
		{"STOPPED", "STOP_CHARGING"}, {"STOPPED", ""},
	} {
		t.Run(tc.state+tc.mode, func(t *testing.T) {
			p, calls := resizeTestProvider(t, tc.state, tc.mode, "SA5.LARGE8")
			if err := p.ResizeInstanceType(context.Background(), "ins-test", "SA5.LARGE8"); err != nil {
				t.Fatal(err)
			}
			if len(*calls) != 0 {
				t.Fatalf("completed resize mutated cloud: %v", *calls)
			}
		})
	}
}
