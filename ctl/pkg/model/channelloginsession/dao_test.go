//go:build integration

package channelloginsession_test

import (
	"errors"
	"testing"
	"time"

	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	"ctl/pkg/model/channelloginsession"
	modelfactory "ctl/pkg/model/factory"
	"ctl/test/testutil"
)

func TestCreateRejectsSecondActiveSessionForSameInstanceAndChannel(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "..", "migrations")

	ctx := pctx.NewContext(nil).WithUserID("user-1")
	dao := modelfactory.DefaultDaoFactory.ChannelLoginSessionDao(ctx)
	now := time.Now()

	first := &channelloginsession.Entity{
		SessionID:  "sess-1",
		InstanceID: "ins-1",
		Channel:    channelloginsession.ChannelWeixin,
		Status:     channelloginsession.StatusStarting,
		StartedAt:  now,
		ExpiresAt:  now.Add(5 * time.Minute),
	}
	if err := dao.Create(ctx, first); err != nil {
		t.Fatalf("create first active session: %v", err)
	}

	second := &channelloginsession.Entity{
		SessionID:  "sess-2",
		InstanceID: "ins-1",
		Channel:    channelloginsession.ChannelWeixin,
		Status:     channelloginsession.StatusWaitingQR,
		StartedAt:  now.Add(time.Second),
		ExpiresAt:  now.Add(5 * time.Minute),
	}
	err := dao.Create(ctx, second)
	if !errors.Is(err, errcode.ErrChannelLoginConflict) {
		t.Fatalf("expected active-session conflict, got %v", err)
	}
}
