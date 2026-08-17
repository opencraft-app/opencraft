package pass

import (
	"testing"
	"time"

	adapterfactory "ctl/pkg/adapter/factory"
	passmodel "ctl/pkg/model/pass"
	modelgateway "ctl/pkg/model/subscriptiongateway"
	taskmodel "ctl/pkg/model/task"
	modelwebsite "ctl/pkg/model/website"
	"ctl/pkg/resource"
	taskcommon "ctl/pkg/taskruntime/common"
	"ctl/test/testutil"

	"gorm.io/gorm"
)

// newPassWebsiteTestDB 搭一个够跑「pass 生命周期 + 站点联动」的最小库。
func newPassWebsiteTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	originalDB := resource.GormDB
	originalFactory := adapterfactory.DefaultAdapterFactory
	t.Cleanup(func() {
		resource.GormDB = originalDB
		adapterfactory.DefaultAdapterFactory = originalFactory
	})

	db := testutil.NewSQLiteDB(t, &passmodel.Entity{}, &taskmodel.Entity{}, &modelgateway.Entity{})
	// website_sites 用建表语句而不是 AutoMigrate：SQLite 的索引名是库级唯一的，
	// SiteEntity 和 pass Entity 都带 idx_status，一起 AutoMigrate 会撞名失败。
	if err := db.Exec(`CREATE TABLE website_sites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            site_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            pass_id TEXT NOT NULL DEFAULT '',
            bundle_id TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL DEFAULT '',
            idempotency_key TEXT,
            status TEXT NOT NULL,
            cloud_path TEXT NOT NULL DEFAULT '',
            public_url TEXT NOT NULL DEFAULT '',
            operation_generation INTEGER NOT NULL DEFAULT 1,
            storage_bytes INTEGER NOT NULL DEFAULT 0,
            deleted_time DATETIME,
            created_time DATETIME,
            updated_time DATETIME
        )`).Error; err != nil {
		t.Fatalf("create website_sites: %v", err)
	}
	adapterfactory.DefaultAdapterFactory = &destroyGatewayAdapterFactory{ai: &destroyFakeAiGatewayAdapter{}}
	return db
}

func seedGatewayRoute(t *testing.T, userID string) {
	t.Helper()
	if err := modelgateway.NewDao().Upsert(&modelgateway.Entity{
		UserID:         userID,
		Gateway:        modelgateway.GatewayAIGateway,
		SubscriptionID: "sub-1",
		PlanID:         "plan-1",
		Source:         modelgateway.SourceDetectActiveSubscription,
		LastObservedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("seed gateway route: %v", err)
	}
}

func seedPassWorkerTask(t *testing.T, taskID, taskName string) {
	t.Helper()
	if err := resource.GormDB.Table(taskmodel.TableName).Create(&taskmodel.Entity{
		TaskId:          taskID,
		TaskName:        taskName,
		TaskState:       taskmodel.StateRunning,
		MaxExecuteCount: 1 << 30,
	}).Error; err != nil {
		t.Fatalf("seed task: %v", err)
	}
}

func seedLifecycleSite(t *testing.T, siteID, userID, status string) {
	t.Helper()
	site := &modelwebsite.SiteEntity{
		SiteID:              siteID,
		Status:              status,
		OperationGeneration: 1,
	}
	site.UserID = userID
	if err := resource.GormDB.Table(modelwebsite.SitesTable).Create(site).Error; err != nil {
		t.Fatalf("seed site: %v", err)
	}
}

func siteStatusOf(t *testing.T, siteID string) string {
	t.Helper()
	var site modelwebsite.SiteEntity
	if err := resource.GormDB.Table(modelwebsite.SitesTable).
		Where("site_id = ?", siteID).First(&site).Error; err != nil {
		t.Fatalf("load site: %v", err)
	}
	return site.Status
}

func taskStateOf(t *testing.T, taskID string) string {
	t.Helper()
	var entity taskmodel.Entity
	if err := resource.GormDB.Table(taskmodel.TableName).
		Where("task_id = ?", taskID).First(&entity).Error; err != nil {
		t.Fatalf("load task: %v", err)
	}
	return entity.TaskState
}

func newIsolateTaskForTest(taskID, passID, userID string) *isolatePassTask {
	task := newIsolatePassTask()
	task.TaskId = taskID
	task.in = &taskcommon.IsolatePassTaskPayload{PassID: passID, UserID: userID}
	return task
}

func newDestroyTaskForTest(taskID, passID, userID string) *destroyPassTask {
	task := newDestroyPassTask()
	task.TaskId = taskID
	task.in = &taskcommon.DestroyPassTaskPayload{PassID: passID, UserID: userID}
	return task
}

// pass 已 isolated 的短路分支也必须把站点推到 suspended：这条分支直接 markSuccess，
// 跳过整个 execute 主体，漏掉钩子就再没有别的机会补上。
func TestIsolateShortCircuitSuspendsSites(t *testing.T) {
	newPassWebsiteTestDB(t)
	seedGatewayRoute(t, "user-iso")
	seedPassWorkerTask(t, "task-iso-1", taskcommon.TaskNameIsolatePass)
	seedLifecycleSite(t, "ws-iso-1", "user-iso", modelwebsite.SiteStatusActive)
	if err := passmodel.NewDao().Create(&passmodel.Entity{
		PassID: "pass-iso-1", UserID: "user-iso", Status: passmodel.StatusIsolated,
	}); err != nil {
		t.Fatalf("seed pass: %v", err)
	}

	task := newIsolateTaskForTest("task-iso-1", "pass-iso-1", "user-iso")
	if _, err := task.execute(testutil.NewContext(t, "user-iso")); err != nil {
		t.Fatalf("execute: %v", err)
	}

	if got := siteStatusOf(t, "ws-iso-1"); got != modelwebsite.SiteStatusSuspended {
		t.Fatalf("site status = %q, want %q", got, modelwebsite.SiteStatusSuspended)
	}
	if got := taskStateOf(t, "task-iso-1"); got != taskmodel.StateSuccess {
		t.Fatalf("task state = %q, want %q", got, taskmodel.StateSuccess)
	}
}

// 站点隔离失败必须让父 task 返错重试，而不是静默 markSuccess。
//
// 这是本次改造的核心：站点隔离已从 best-effort 尾巴升级成与实例隔离同等地位的
// 阻塞步骤。静默成功会留下「pass 已隔离、站点仍对外服务」的永久不一致。
func TestIsolateFailsTaskWhenSiteHookFails(t *testing.T) {
	db := newPassWebsiteTestDB(t)
	seedGatewayRoute(t, "user-iso")
	seedPassWorkerTask(t, "task-iso-2", taskcommon.TaskNameIsolatePass)
	if err := passmodel.NewDao().Create(&passmodel.Entity{
		PassID: "pass-iso-2", UserID: "user-iso", Status: passmodel.StatusIsolated,
	}); err != nil {
		t.Fatalf("seed pass: %v", err)
	}
	// 站点表不可用模拟钩子失败：真实场景里对应 DB 抖动。
	if err := db.Exec("DROP TABLE website_sites").Error; err != nil {
		t.Fatalf("drop site table: %v", err)
	}

	task := newIsolateTaskForTest("task-iso-2", "pass-iso-2", "user-iso")
	if _, err := task.execute(testutil.NewContext(t, "user-iso")); err == nil {
		t.Fatal("expected execute to fail so the parent task retries")
	}
	if got := taskStateOf(t, "task-iso-2"); got == taskmodel.StateSuccess {
		t.Fatal("task must not be marked SUCCESS when site isolation failed")
	}
}

// 锁竞争路径（idempotentCheck）同样要执行站点钩子。
func TestIsolateIdempotentCheckSuspendsSites(t *testing.T) {
	newPassWebsiteTestDB(t)
	seedGatewayRoute(t, "user-iso")
	seedPassWorkerTask(t, "task-iso-3", taskcommon.TaskNameIsolatePass)
	seedLifecycleSite(t, "ws-iso-3", "user-iso", modelwebsite.SiteStatusActive)
	if err := passmodel.NewDao().Create(&passmodel.Entity{
		PassID: "pass-iso-3", UserID: "user-iso", Status: passmodel.StatusIsolated,
	}); err != nil {
		t.Fatalf("seed pass: %v", err)
	}

	task := newIsolateTaskForTest("task-iso-3", "pass-iso-3", "user-iso")
	if _, err := task.idempotentCheck(testutil.NewContext(t, "user-iso")); err != nil {
		t.Fatalf("idempotentCheck: %v", err)
	}
	if got := siteStatusOf(t, "ws-iso-3"); got != modelwebsite.SiteStatusSuspended {
		t.Fatalf("site status = %q, want %q", got, modelwebsite.SiteStatusSuspended)
	}
}

// 销毁侧的防御性分支：pass 状态不是 terminating 时直接 markSuccess，
// 这条分支原先完全跳过站点钩子，站点会以 active 继续对外服务。
func TestDestroyUnexpectedStatusStillSuspendsSites(t *testing.T) {
	newPassWebsiteTestDB(t)
	seedPassWorkerTask(t, "task-des-1", taskcommon.TaskNameDestroyPass)
	seedLifecycleSite(t, "ws-des-1", "user-des", modelwebsite.SiteStatusActive)
	if err := passmodel.NewDao().Create(&passmodel.Entity{
		PassID: "pass-des-1", UserID: "user-des", Status: passmodel.StatusActive,
	}); err != nil {
		t.Fatalf("seed pass: %v", err)
	}

	task := newDestroyTaskForTest("task-des-1", "pass-des-1", "user-des")
	if _, err := task.execute(testutil.NewContext(t, "user-des")); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if got := siteStatusOf(t, "ws-des-1"); got != modelwebsite.SiteStatusSuspended {
		t.Fatalf("site status = %q, want %q", got, modelwebsite.SiteStatusSuspended)
	}
	if got := taskStateOf(t, "task-des-1"); got != taskmodel.StateSuccess {
		t.Fatalf("task state = %q, want %q", got, taskmodel.StateSuccess)
	}
}

// 销毁侧另一条防御性分支：pass 不在表且 PassDeleted=false。
func TestDestroyMissingPassStillSuspendsSites(t *testing.T) {
	newPassWebsiteTestDB(t)
	seedPassWorkerTask(t, "task-des-2", taskcommon.TaskNameDestroyPass)
	seedLifecycleSite(t, "ws-des-2", "user-des", modelwebsite.SiteStatusActive)

	task := newDestroyTaskForTest("task-des-2", "pass-missing", "user-des")
	if _, err := task.execute(testutil.NewContext(t, "user-des")); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if got := siteStatusOf(t, "ws-des-2"); got != modelwebsite.SiteStatusSuspended {
		t.Fatalf("site status = %q, want %q", got, modelwebsite.SiteStatusSuspended)
	}
}

// 销毁侧锁竞争路径同样要执行站点钩子。
func TestDestroyIdempotentCheckSuspendsSites(t *testing.T) {
	newPassWebsiteTestDB(t)
	seedPassWorkerTask(t, "task-des-3", taskcommon.TaskNameDestroyPass)
	seedLifecycleSite(t, "ws-des-3", "user-des", modelwebsite.SiteStatusActive)

	task := newDestroyTaskForTest("task-des-3", "pass-missing", "user-des")
	if _, err := task.idempotentCheck(testutil.NewContext(t, "user-des")); err != nil {
		t.Fatalf("idempotentCheck: %v", err)
	}
	if got := siteStatusOf(t, "ws-des-3"); got != modelwebsite.SiteStatusSuspended {
		t.Fatalf("site status = %q, want %q", got, modelwebsite.SiteStatusSuspended)
	}
}

// 销毁不删任何东西：站点行必须留着（它是桶里对象的归属依据），也不登记 delete 操作。
func TestDestroyNeverHardDeletesSiteRow(t *testing.T) {
	newPassWebsiteTestDB(t)
	seedPassWorkerTask(t, "task-des-4", taskcommon.TaskNameDestroyPass)
	seedLifecycleSite(t, "ws-des-4", "user-des", modelwebsite.SiteStatusActive)

	task := newDestroyTaskForTest("task-des-4", "pass-missing", "user-des")
	if _, err := task.execute(testutil.NewContext(t, "user-des")); err != nil {
		t.Fatalf("execute: %v", err)
	}
	var site modelwebsite.SiteEntity
	if err := resource.GormDB.Table(modelwebsite.SitesTable).
		Where("site_id = ?", "ws-des-4").First(&site).Error; err != nil {
		t.Fatalf("site row must survive pass destroy: %v", err)
	}
	if site.DeletedTime != nil {
		t.Fatalf("deleted_time = %v, want NULL", site.DeletedTime)
	}
}
