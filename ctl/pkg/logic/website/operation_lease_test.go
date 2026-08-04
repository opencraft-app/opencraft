package website

import (
	"errors"
	"testing"
	"time"

	"ctl/pkg/errcode"
	websiteModel "ctl/pkg/model/website"
	"ctl/pkg/resource"
	"ctl/test/testutil"
)

func TestClaimedOperationRequiresMatchingLeaseToComplete(t *testing.T) {
	newWebsiteOperationTestDB(t)
	l := NewLogic().(*logic)

	site := &websiteModel.SiteEntity{SiteID: "ws-lease", Status: websiteModel.SiteStatusCreating, OperationGeneration: 1}
	site.UserID = "user-1"
	op := &websiteModel.OperationEntity{OperationID: "wo-lease", SiteID: site.SiteID, OperationType: websiteModel.OpTypeCreate, Status: websiteModel.OpStatusCreated, SiteGeneration: 1}
	op.UserID = site.UserID
	if err := l.siteDao.CreateSite(site); err != nil {
		t.Fatal(err)
	}
	if err := l.operationDao.CreateOperation(op); err != nil {
		t.Fatal(err)
	}

	claimed, ok, err := l.ClaimOperation(op.OperationID, "worker-a", time.Minute)
	if err != nil || !ok || claimed.LeaseToken == "" {
		t.Fatalf("first claim = (%+v, %v, %v), want lease", claimed, ok, err)
	}
	if _, ok, err := l.ClaimOperation(op.OperationID, "worker-b", time.Minute); err != nil || ok {
		t.Fatalf("second claim = (%v, %v), want not claimed", ok, err)
	}
	if err := l.CompleteOperation(op.OperationID, "wrong-token", "", ""); !errors.Is(err, errcode.ErrWebsiteOperationNotClaimed) {
		t.Fatalf("wrong lease complete error = %v", err)
	}
	if err := l.CompleteOperation(op.OperationID, claimed.LeaseToken, "", ""); err != nil {
		t.Fatal(err)
	}
	updated, err := l.siteDao.GetBySiteID(site.SiteID)
	if err != nil || updated.Status != websiteModel.SiteStatusActive {
		t.Fatalf("site after complete = %+v, %v", updated, err)
	}
}

func TestSupersededOperationCannotOverwriteCurrentSite(t *testing.T) {
	newWebsiteOperationTestDB(t)
	l := NewLogic().(*logic)

	site := &websiteModel.SiteEntity{SiteID: "ws-fence", Status: websiteModel.SiteStatusDeleted, OperationGeneration: 2}
	site.UserID = "user-1"
	op := &websiteModel.OperationEntity{OperationID: "wo-old", SiteID: site.SiteID, OperationType: websiteModel.OpTypeDeploy, Status: websiteModel.OpStatusRunning, LeaseToken: "lease-old", SiteGeneration: 1}
	op.UserID = site.UserID
	if err := l.siteDao.CreateSite(site); err != nil {
		t.Fatal(err)
	}
	if err := l.operationDao.CreateOperation(op); err != nil {
		t.Fatal(err)
	}

	if err := l.CompleteOperation(op.OperationID, op.LeaseToken, "sites/ws-fence/releases/wr-old/", "https://old.example"); err != nil {
		t.Fatalf("complete stale operation error = %v", err)
	}
	updatedSite, err := l.siteDao.GetBySiteID(site.SiteID)
	if err != nil || updatedSite.Status != websiteModel.SiteStatusDeleted || updatedSite.PublicURL != "" {
		t.Fatalf("site was unexpectedly overwritten: %+v, %v", updatedSite, err)
	}
	updatedOp, err := l.operationDao.GetByOperationID(op.OperationID)
	if err != nil || updatedOp.Status != websiteModel.OpStatusFailed {
		t.Fatalf("superseded operation = %+v, %v", updatedOp, err)
	}
}

func newWebsiteOperationTestDB(t *testing.T) {
	t.Helper()
	db := testutil.NewSQLiteDB(t)
	for _, statement := range []string{
		`CREATE TABLE website_sites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            site_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            pass_id TEXT NOT NULL DEFAULT '',
            bundle_id TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL,
            cloud_path TEXT NOT NULL DEFAULT '',
            tcb_env_id TEXT NOT NULL DEFAULT '',
            public_url TEXT NOT NULL DEFAULT '',
            operation_generation INTEGER NOT NULL DEFAULT 1,
            deleted_time DATETIME,
            created_time DATETIME,
            updated_time DATETIME
        )`,
		`CREATE TABLE website_operations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            operation_id TEXT NOT NULL,
            site_id TEXT NOT NULL,
            release_id TEXT NOT NULL DEFAULT '',
            user_id TEXT NOT NULL,
            operation_type TEXT NOT NULL,
            status TEXT NOT NULL,
            error_message TEXT NOT NULL DEFAULT '',
            lease_token TEXT NOT NULL DEFAULT '',
            lease_expires_at DATETIME,
            attempt INTEGER NOT NULL DEFAULT 0,
            site_generation INTEGER NOT NULL DEFAULT 1,
            created_time DATETIME,
            updated_time DATETIME
        )`,
	} {
		if err := db.Exec(statement).Error; err != nil {
			t.Fatal(err)
		}
	}
	resource.GormDB = db
}
