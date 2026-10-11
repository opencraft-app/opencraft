package tat

import (
	"context"
	"errors"
	"testing"
	"time"

	tencenttatport "chatserver/internal/ports/tencenttat"
)

type fakeSessionCloud struct {
	identity      cloudIdentity
	identityErr   error
	start         cloudStartSession
	startErr      error
	identityCalls int
	startCalls    int
	region        string
	instanceID    string
}

func (cloud *fakeSessionCloud) Identity(
	context.Context,
) (cloudIdentity, error) {
	cloud.identityCalls++
	return cloud.identity, cloud.identityErr
}

func (cloud *fakeSessionCloud) StartSession(
	_ context.Context,
	region string,
	instanceID string,
) (cloudStartSession, error) {
	cloud.startCalls++
	cloud.region = region
	cloud.instanceID = instanceID
	return cloud.start, cloud.startErr
}

func TestCloudSessionIssuerCreatesShortLivedDirectBootstrap(t *testing.T) {
	now := time.Date(2026, 8, 1, 3, 4, 5, 0, time.UTC)
	cloud := &fakeSessionCloud{
		identity: cloudIdentity{
			OwnerUIN: "100000000001",
			AppID:    1250000000,
		},
		start: cloudStartSession{
			SessionID: "session-test",
			StreamURL: "11.139.112.29:8900",
		},
	}
	issuer, err := newCloudSessionIssuer(cloud, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	target := tencenttatport.TerminalTarget{
		ComputerID:   adapterOperationID,
		Region:       "ap-beijing",
		InstanceKind: "managed",
		InstanceID:   "rins-test0001",
		OS:           tencenttatport.OSLinux,
	}

	got, err := issuer.Issue(context.Background(), target)
	if err != nil {
		t.Fatal(err)
	}
	if cloud.identityCalls != 1 || cloud.startCalls != 1 ||
		cloud.region != target.Region || cloud.instanceID != target.InstanceID {
		t.Fatalf("cloud calls = %#v", cloud)
	}
	if got.SessionID != "session-test" ||
		got.WebSocketURL != "wss://ap-beijing.forward.tat-tc.tencent.cn/ws" ||
		got.OwnerUIN != "100000000001" || got.AppID != 1250000000 ||
		got.InstanceID != target.InstanceID || got.Cols != 120 || got.Rows != 32 ||
		got.MaxIdleSeconds != 3600 ||
		!got.ExpiresAt.Equal(now.Add(time.Minute)) {
		t.Fatalf("session = %#v", got)
	}

	// 账号身份稳定且不含会话密钥；同一进程只查询一次，StartSession 每次重签。
	if _, err := issuer.Issue(context.Background(), target); err != nil {
		t.Fatal(err)
	}
	if cloud.identityCalls != 1 || cloud.startCalls != 2 {
		t.Fatalf("calls identity=%d start=%d", cloud.identityCalls, cloud.startCalls)
	}
}

func TestCloudSessionIssuerRejectsInvalidCloudBootstrap(t *testing.T) {
	tests := []struct {
		name     string
		identity cloudIdentity
		start    cloudStartSession
	}{
		{
			name: "missing owner",
			identity: cloudIdentity{
				AppID: 1250000000,
			},
			start: cloudStartSession{
				SessionID: "session-test",
				StreamURL: "wss://tat-tssh.tencentcloud.com/connect",
			},
		},
		{
			name: "missing session",
			identity: cloudIdentity{
				OwnerUIN: "100000000001",
				AppID:    1250000000,
			},
			start: cloudStartSession{
				StreamURL: "wss://tat-tssh.tencentcloud.com/connect",
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			issuer, err := newCloudSessionIssuer(
				&fakeSessionCloud{identity: test.identity, start: test.start},
				time.Now,
			)
			if err != nil {
				t.Fatal(err)
			}
			_, err = issuer.Issue(context.Background(), tencenttatport.TerminalTarget{
				ComputerID: adapterOperationID, Region: "ap-beijing",
				InstanceKind: "managed", InstanceID: "rins-test0001",
				OS: tencenttatport.OSLinux,
			})
			if err == nil || tencenttatport.CodeOf(err) != "terminal_response_invalid" {
				t.Fatalf("err = %v code=%q", err, tencenttatport.CodeOf(err))
			}
		})
	}
}

func TestTerminalForwardURLAcceptsOnlyTencentRegionLabels(t *testing.T) {
	got, ok := terminalForwardURL("ap-beijing")
	if !ok || got != "wss://ap-beijing.forward.tat-tc.tencent.cn/ws" {
		t.Fatalf("terminalForwardURL(ap-beijing) = (%q, %v)", got, ok)
	}
	for _, region := range []string{
		"", "ap-beijing.evil.test", "ap_beijing", "-ap-beijing", "AP-BEIJING",
	} {
		if got, ok := terminalForwardURL(region); ok || got != "" {
			t.Fatalf("terminalForwardURL(%q) = (%q, %v)", region, got, ok)
		}
	}
}

func TestCloudSessionIssuerClassifiesProviderFailure(t *testing.T) {
	issuer, err := newCloudSessionIssuer(&fakeSessionCloud{
		identity: cloudIdentity{OwnerUIN: "100000000001", AppID: 1250000000},
		startErr: errors.New("provider detail must not escape"),
	}, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	_, err = issuer.Issue(context.Background(), tencenttatport.TerminalTarget{
		ComputerID: adapterOperationID, Region: "ap-beijing",
		InstanceKind: "managed", InstanceID: "rins-test0001",
		OS: tencenttatport.OSLinux,
	})
	if err == nil || tencenttatport.CodeOf(err) != "terminal_session_unavailable" ||
		!tencenttatport.IsRetryable(err) ||
		err.Error() == "provider detail must not escape" {
		t.Fatalf("err = %#v", err)
	}
}
