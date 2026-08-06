package website

import (
	"errors"
	"testing"
	"time"

	"ctl/pkg/errcode"
	quota "ctl/pkg/model/userresourcequota"
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

func TestDeleteReleasesQuotaOnlyAfterCleanupCompletes(t *testing.T) {
	newWebsiteOperationTestDB(t)
	l := NewLogic().(*logic)

	site := &websiteModel.SiteEntity{
		SiteID:              "ws-delete",
		BundleID:            "bundle-1",
		Status:              websiteModel.SiteStatusDeleting,
		CloudPath:           "sites/ws-delete/releases/wr-1/",
		PublicURL:           "https://example.tcloudbaseapp.com/sites/ws-delete/releases/wr-1/index.html",
		OperationGeneration: 2,
	}
	site.UserID = "user-1"
	op := &websiteModel.OperationEntity{
		OperationID:    "wo-delete",
		SiteID:         site.SiteID,
		OperationType:  websiteModel.OpTypeDelete,
		Status:         websiteModel.OpStatusRunning,
		LeaseToken:     "lease-delete",
		Attempt:        1,
		SiteGeneration: 2,
	}
	op.UserID = site.UserID
	quotaRow := &quota.Entity{
		UserID:                 site.UserID,
		ResourceName:           websiteModel.ResourceNameWebsiteSite,
		ResourceKey:            site.BundleID,
		ResourceQuotaAvailable: 0,
		ResourceQuotaTotal:     1,
	}
	if err := l.siteDao.CreateSite(site); err != nil {
		t.Fatal(err)
	}
	if err := l.operationDao.CreateOperation(op); err != nil {
		t.Fatal(err)
	}
	if err := resource.GormDB.Table(quota.TableName).Create(quotaRow).Error; err != nil {
		t.Fatal(err)
	}

	if err := l.FailOperation(op.OperationID, op.LeaseToken, "COS unavailable"); err != nil {
		t.Fatal(err)
	}
	failedSite, err := l.siteDao.GetBySiteID(site.SiteID)
	if err != nil || failedSite.Status != websiteModel.SiteStatusDeleting || failedSite.DeletedTime != nil {
		t.Fatalf("site after failed cleanup = %+v, %v", failedSite, err)
	}
	failedOp, err := l.operationDao.GetByOperationID(op.OperationID)
	if err != nil || failedOp.Status != websiteModel.OpStatusCreated || failedOp.NextRetryAt == nil {
		t.Fatalf("operation after failed cleanup = %+v, %v", failedOp, err)
	}
	var quotaAfterFailure quota.Entity
	if err := resource.GormDB.Table(quota.TableName).Where("user_id = ?", site.UserID).First(&quotaAfterFailure).Error; err != nil {
		t.Fatal(err)
	}
	if quotaAfterFailure.ResourceQuotaAvailable != 0 {
		t.Fatalf("quota after failed cleanup = %d, want 0", quotaAfterFailure.ResourceQuotaAvailable)
	}

	readyAt := time.Now().UTC().Add(-time.Second)
	if err := resource.GormDB.Table(websiteModel.OperationsTable).Where("operation_id = ?", op.OperationID).
		Update("next_retry_at", readyAt).Error; err != nil {
		t.Fatal(err)
	}
	claimed, ok, err := l.ClaimOperation(op.OperationID, "worker-retry", time.Minute)
	if err != nil || !ok {
		t.Fatalf("retry claim = (%+v, %v, %v), want claimed", claimed, ok, err)
	}
	if err := l.CompleteOperation(op.OperationID, claimed.LeaseToken, "", ""); err != nil {
		t.Fatal(err)
	}
	deletedSite, err := l.siteDao.GetBySiteID(site.SiteID)
	if err != nil || deletedSite.Status != websiteModel.SiteStatusDeleted || deletedSite.DeletedTime == nil || deletedSite.PublicURL != "" || deletedSite.CloudPath != "" {
		t.Fatalf("site after completed cleanup = %+v, %v", deletedSite, err)
	}
	var quotaAfterSuccess quota.Entity
	if err := resource.GormDB.Table(quota.TableName).Where("user_id = ?", site.UserID).First(&quotaAfterSuccess).Error; err != nil {
		t.Fatal(err)
	}
	if quotaAfterSuccess.ResourceQuotaAvailable != 1 {
		t.Fatalf("quota after completed cleanup = %d, want 1", quotaAfterSuccess.ResourceQuotaAvailable)
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
            idempotency_key TEXT,
            status TEXT NOT NULL,
            cloud_path TEXT NOT NULL DEFAULT '',
            tcb_env_id TEXT NOT NULL DEFAULT '',
            public_url TEXT NOT NULL DEFAULT '',
            operation_generation INTEGER NOT NULL DEFAULT 1,
            storage_bytes INTEGER NOT NULL DEFAULT 0,
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
	            next_retry_at DATETIME,
	            attempt INTEGER NOT NULL DEFAULT 0,
            site_generation INTEGER NOT NULL DEFAULT 1,
            created_time DATETIME,
            updated_time DATETIME
		)`,
		`CREATE TABLE website_releases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            release_id TEXT NOT NULL,
            site_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL,
            artifact_hash TEXT NOT NULL DEFAULT '',
            artifact_size INTEGER NOT NULL DEFAULT 0,
            file_count INTEGER NOT NULL DEFAULT 0,
            error_message TEXT NOT NULL DEFAULT '',
            created_time DATETIME,
            updated_time DATETIME
        )`,
		`CREATE TABLE user_resource_quota (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id TEXT NOT NULL,
			resource_name TEXT NOT NULL,
			resource_key TEXT NOT NULL,
			resource_quota_available INTEGER NOT NULL,
			resource_quota_total INTEGER NOT NULL,
			created_time DATETIME,
			updated_time DATETIME
		)`,
		// 唯一键必须建出来：流量累加靠 ON CONFLICT (site_id, usage_date) 实现，
		// 缺了约束的话每个上报窗口都会插一行新记录，当月合计会翻好几倍。
		`CREATE TABLE website_usage_daily (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			site_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			usage_date TEXT NOT NULL,
			traffic_bytes INTEGER NOT NULL DEFAULT 0,
			request_count INTEGER NOT NULL DEFAULT 0,
			created_time DATETIME,
			updated_time DATETIME,
			UNIQUE (site_id, usage_date)
		)`,
	} {
		if err := db.Exec(statement).Error; err != nil {
			t.Fatal(err)
		}
	}
	resource.GormDB = db
}
