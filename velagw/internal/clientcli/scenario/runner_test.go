package scenario

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"git.woa.com/wisp/mono2/llmgateway/internal/client"
)

type fakeGateway struct {
	calls  []string
	failAt string
	key    string
}

func (f *fakeGateway) result(name string, data string) (client.Result, error) {
	f.calls = append(f.calls, name)
	if f.failAt == name {
		return client.Result{}, errors.New("boom")
	}
	return client.Result{StatusCode: 200, Data: json.RawMessage(data)}, nil
}

func (f *fakeGateway) EnsureUser(context.Context, client.EnsureUserInput) (client.Result, error) {
	return f.result("ensure", `{}`)
}
func (f *fakeGateway) GetAssignment(context.Context, string) (client.Result, error) {
	return f.result("assignment", `{}`)
}
func (f *fakeGateway) ApplySubscription(context.Context, client.ApplySubscriptionInput) (client.Result, error) {
	return f.result("apply", `{}`)
}
func (f *fakeGateway) CancelSubscription(context.Context, string) (client.Result, error) {
	return f.result("cancel", `{}`)
}
func (f *fakeGateway) GetSubscription(context.Context, string) (client.Result, error) {
	return f.result("subscription", `{}`)
}
func (f *fakeGateway) GetCredit(context.Context, string) (client.Result, error) {
	return f.result("credit", `{}`)
}
func (f *fakeGateway) SetBYOK(context.Context, string, client.BYOKSettingsInput) (client.Result, error) {
	return f.result("byok-set", `{}`)
}
func (f *fakeGateway) SyncBYOK(context.Context, string) (client.Result, error) {
	return f.result("byok-sync", `{}`)
}
func (f *fakeGateway) GetBYOK(context.Context, string) (client.Result, error) {
	return f.result("byok-get", `{}`)
}
func (f *fakeGateway) CreateAPIKey(context.Context, string, string) (client.Result, error) {
	return f.result("key", `{"api_key":"`+f.key+`"}`)
}
func (f *fakeGateway) Models(context.Context) (client.Result, error) {
	return f.result("models", `{}`)
}
func (f *fakeGateway) Chat(context.Context, client.ChatInput) (client.Result, error) {
	return f.result("chat", `{}`)
}

func TestTradeLifecycleRunsInBusinessOrder(t *testing.T) {
	fake := &fakeGateway{}
	runner := Runner{Gateway: fake}
	_, err := runner.TradeLifecycle(context.Background(), TradeLifecycleInput{
		UserID: "user-1", PlanID: "plan-pro", IdempotencyKey: "deal-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"ensure", "assignment", "apply", "subscription", "credit", "cancel", "subscription"}
	if !reflect.DeepEqual(fake.calls, want) {
		t.Fatalf("calls=%v want=%v", fake.calls, want)
	}
}

func TestScenarioStopsAtFirstFailure(t *testing.T) {
	fake := &fakeGateway{failAt: "apply"}
	runner := Runner{Gateway: fake}
	report, err := runner.Onboard(context.Background(), OnboardInput{UserID: "user-1", PlanID: "plan-pro"})
	if err == nil {
		t.Fatal("expected failure")
	}
	if want := []string{"ensure", "apply"}; !reflect.DeepEqual(fake.calls, want) {
		t.Fatalf("calls=%v want=%v", fake.calls, want)
	}
	if len(report.Steps) != 2 || report.Steps[1].Status != StepFailed {
		t.Fatalf("report=%+v", report)
	}
}

func TestFullUsesFreshlyIssuedKeyForTraffic(t *testing.T) {
	control := &fakeGateway{key: "sk-issued"}
	traffic := &fakeGateway{}
	var selected string
	runner := Runner{
		Gateway: control,
		TrafficForKey: func(key string) TrafficGateway {
			selected = key
			return traffic
		},
	}
	_, err := runner.Full(context.Background(), FullInput{
		Onboard: OnboardInput{UserID: "user-1", PlanID: "plan-pro"},
		BYOK:    BYOKInput{UserID: "user-1", Settings: client.BYOKSettingsInput{Routing: client.BYOKRoutingInput{Mode: "byok_first"}}},
		Chat:    client.ChatInput{Model: "auto", Prompt: "hello"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if selected != "sk-issued" {
		t.Fatalf("selected key=%q", selected)
	}
	if !reflect.DeepEqual(traffic.calls, []string{"models", "chat"}) {
		t.Fatalf("traffic calls=%v", traffic.calls)
	}
}
