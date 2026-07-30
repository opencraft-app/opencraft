package shadowbinding

import (
	"context"
	"testing"
	"time"
)

func TestSaveBasicAuthPersistsCorrelationAndSkipsDuplicateCloudCall(t *testing.T) {
	now := time.Date(2026, 7, 13, 10, 0, 0, 0, time.UTC)
	client := &recordingClient{result: CloudRegisterResult{Uin: 300000000060, OwnerUin: 300000000060, AppID: 1250000000}}
	svc := New(NewMemoryStore(), client, Options{Enabled: true, Now: func() time.Time { return now }})

	if _, err := svc.BindShadowAccount(context.Background(), BindInput{UserID: "usr_1", Phone: "13800138000"}); err != nil {
		t.Fatalf("bind shadow account: %v", err)
	}
	input := BasicAuthInput{
		UserID:          "usr_1",
		AccountType:     0,
		Name:            "张三",
		IDCard:          "11010519491231002X",
		ClientIP:        "127.0.0.1",
		ClientUA:        "agent",
		SourceAttemptID: "attempt-1",
		IdentityHash:    "identity-hash-1",
		PhoneHash:       "phone-hash-1",
	}
	if err := svc.SaveBasicAuth(context.Background(), input); err != nil {
		t.Fatalf("save basic auth: %v", err)
	}
	if err := svc.SaveBasicAuth(context.Background(), input); err != nil {
		t.Fatalf("repeat save basic auth: %v", err)
	}
	if client.basicAuthCalls != 1 {
		t.Fatalf("expected duplicate correlation to skip cloud call, calls=%d", client.basicAuthCalls)
	}

	binding, err := svc.GetBindingByUserID(context.Background(), "usr_1")
	if err != nil {
		t.Fatalf("get binding: %v", err)
	}
	if binding.BasicAuthSourceAttemptID != "attempt-1" || binding.BasicAuthIdentityHash != "identity-hash-1" || binding.BasicAuthPhoneHash != "phone-hash-1" {
		t.Fatalf("unexpected stored correlation: %+v", binding)
	}
}
