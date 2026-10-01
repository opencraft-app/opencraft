package website

import (
	"errors"
	"testing"
	"time"

	"ctl/pkg/errcode"
	model "ctl/pkg/model/website"
	"ctl/pkg/resource"
)

func TestRollbackIsFencedAndRejectsCrossOwner(t *testing.T) {
	l := setupCreateReleaseTest(t, 1000)
	seedRelease(t, "wr-old", "ws-a", "user-1", 1, model.ReleaseStatusSuperseded)
	result, err := l.RollbackRelease("other", "ws-a", "wr-old")
	if result != nil || !errors.Is(err, errcode.ErrWebsiteNotFound) {
		t.Fatal("cross owner rollback accepted")
	}
	result, err = l.RollbackRelease("user-1", "ws-a", "wr-old")
	if err != nil {
		t.Fatal(err)
	}
	op, err := l.GetOperationInternal(result.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	if op.OperationType != "rollback" || op.ReleaseID != "wr-old" || op.SiteGeneration != 2 {
		t.Fatalf("bad rollback op: %+v", op)
	}
	if _, err := l.CreateRelease("user-1", "ws-a", validReleaseRequest(10)); !errors.Is(err, errcode.ErrWebsiteReleaseInProgress) {
		t.Fatalf("publish raced rollback: %v", err)
	}
	claimed, ok, err := l.ClaimOperation(op.OperationID, "worker", time.Minute)
	if err != nil || !ok {
		t.Fatal("claim failed")
	}
	if err := l.CompleteOperation(op.OperationID, claimed.LeaseToken, "sites/ws-a/releases/wr-old/", "https://ws-a.example"); err != nil {
		t.Fatal(err)
	}
	var site model.SiteEntity
	if err := resource.GormDB.Where("site_id = ?", "ws-a").First(&site).Error; err != nil {
		t.Fatal(err)
	}
	if site.ActiveReleaseID != "wr-old" || site.CloudPath != "sites/ws-a/releases/wr-old/" {
		t.Fatal("rollback pointer was not switched")
	}
}
