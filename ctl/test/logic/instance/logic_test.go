//go:build integration

package instance_test

import (
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	psandbox "ctl/pkg/adapter/sandbox"
	"ctl/pkg/config"
	"ctl/pkg/errcode"
	instancelogic "ctl/pkg/instance"
	modelfactory "ctl/pkg/model/factory"
	modelinstance "ctl/pkg/model/instance"
	quota "ctl/pkg/model/userresourcequota"
	"ctl/pkg/resource"
	"ctl/pkg/transport"
	"ctl/test/testutil"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

func TestInstanceLogicIntegration(t *testing.T) {
	container := testutil.StartMySQLContainer(t)
	defer container.Close(t)

	sqlDB, err := sql.Open("mysql", container.DSN)
	if err != nil {
		t.Fatalf("open mysql db: %v", err)
	}
	defer sqlDB.Close()

	testutil.ApplyMigrations(t, sqlDB, filepath.Join("..", "..", "..", "migrations"))

	gdb, err := gorm.Open(mysql.Open(container.DSN), &gorm.Config{})
	if err != nil {
		t.Fatalf("open gorm mysql db: %v", err)
	}
	resource.GormDB = gdb

	successServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/sandboxes":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"sandboxID":"sbx-integration-1","templateID":"tpl-integration","envdVersion":"1.0.0"}`))
		case r.Method == http.MethodPost && r.URL.Path == "/sandboxes/sbx-pause-ok/pause":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && r.URL.Path == "/sandboxes/sbx-pause-conflict/pause":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"code":409,"message":"sandbox already paused"}`))
		case r.Method == http.MethodPost && r.URL.Path == "/sandboxes/sbx-resume-ok/resume":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"sandboxID":"sbx-resume-ok","templateID":"tpl-integration","envdVersion":"1.0.0"}`))
		case r.Method == http.MethodPost && r.URL.Path == "/sandboxes/sbx-resume-conflict/resume":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"code":409,"message":"sandbox already running"}`))
		case r.Method == http.MethodPost && r.URL.Path == "/sandboxes/sbx-timeout-ok/timeout":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && r.URL.Path == "/sandboxes/sbx-timeout-paused/timeout":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodDelete && r.URL.Path == "/sandboxes/sbx-delete-ok":
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer successServer.Close()

	failServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/sandboxes":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"code":500,"message":"upstream failed"}`))
		case r.Method == http.MethodPost && r.URL.Path == "/sandboxes/sbx-pause-fail/pause":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"code":500,"message":"pause failed"}`))
		case r.Method == http.MethodPost && r.URL.Path == "/sandboxes/sbx-resume-fail/resume":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"code":500,"message":"resume failed"}`))
		case r.Method == http.MethodPost && r.URL.Path == "/sandboxes/sbx-timeout-fail/timeout":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"code":500,"message":"timeout failed"}`))
		case r.Method == http.MethodDelete && r.URL.Path == "/sandboxes/sbx-delete-fail":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"code":500,"message":"delete failed"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer failServer.Close()

	notFoundDeleteServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodDelete && r.URL.Path == "/sandboxes/sbx-delete-gone":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"code":404,"message":"sandbox not found"}`))
		case r.Method == http.MethodDelete && r.URL.Path == "/sandboxes/sbx-delete-gone-2":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"code":404,"message":"sandbox not found"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer notFoundDeleteServer.Close()

	ctx := testutil.NewContext(t, "user-1")
	otherCtx := testutil.NewContext(t, "user-2")
	testutil.SeedActivePass(t, ctx)
	quotaDao := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx)
	if err := quotaDao.DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 2,
		ResourceQuotaTotal:     2,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	adapter := psandbox.NewSandboxAdapter(&config.SandboxConfig{
		BaseURL:       successServer.URL,
		Timeout:       5,
		MaxRetries:    0,
		RetryInterval: 1,
	}, resource.ZapLogger)
	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		quotaDao,
		adapter,
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		resource.ZapLogger,
		"tpl-integration",
	)

	createResp, err := logic.CreateInstance(ctx, &transport.CreateInstanceRequest{Timeout: ptr(int32(30))})
	if err != nil {
		t.Fatalf("create instance: %v", err)
	}
	if createResp.Status != modelinstance.InstanceStatusRunning {
		t.Fatalf("unexpected create status: %s", createResp.Status)
	}

	got, err := logic.GetInstance(ctx, createResp.InstanceID)
	if err != nil {
		t.Fatalf("get instance: %v", err)
	}
	if got.SandboxID != "sbx-integration-1" {
		t.Fatalf("unexpected sandbox id: %s", got.SandboxID)
	}

	if _, err := logic.GetInstance(otherCtx, createResp.InstanceID); !errors.Is(err, errcode.ErrInstanceNotFound) {
		t.Fatalf("expected tenant isolation, got %v", err)
	}

	pauseEntity := &modelinstance.Entity{
		InstanceId: "ins-pause-ok",
		Status:     modelinstance.InstanceStatusRunning,
		SandboxId:  "sbx-pause-ok",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, pauseEntity); err != nil {
		t.Fatalf("seed pause instance: %v", err)
	}

	pauseResp, err := logic.PauseInstance(ctx, pauseEntity.InstanceId)
	if err != nil {
		t.Fatalf("pause instance: %v", err)
	}
	if pauseResp.Status != modelinstance.InstanceStatusPaused {
		t.Fatalf("unexpected pause status: %s", pauseResp.Status)
	}

	pauseConflictEntity := &modelinstance.Entity{
		InstanceId: "ins-pause-conflict",
		Status:     modelinstance.InstanceStatusRunning,
		SandboxId:  "sbx-pause-conflict",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, pauseConflictEntity); err != nil {
		t.Fatalf("seed pause conflict instance: %v", err)
	}
	if _, err := logic.PauseInstance(ctx, pauseConflictEntity.InstanceId); err != nil {
		t.Fatalf("pause conflict should be idempotent: %v", err)
	}

	pauseInvalidEntity := &modelinstance.Entity{
		InstanceId: "ins-pause-invalid",
		Status:     modelinstance.InstanceStatusPaused,
		SandboxId:  "sbx-pause-invalid",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, pauseInvalidEntity); err != nil {
		t.Fatalf("seed pause invalid instance: %v", err)
	}
	if _, err := logic.PauseInstance(ctx, pauseInvalidEntity.InstanceId); !errors.Is(err, errcode.ErrInstanceStatusInvalid) {
		t.Fatalf("expected invalid status on pause, got %v", err)
	}
	if _, err := logic.PauseInstance(otherCtx, pauseEntity.InstanceId); !errors.Is(err, errcode.ErrInstanceNotFound) {
		t.Fatalf("expected tenant isolation on pause, got %v", err)
	}

	adapterFail := psandbox.NewSandboxAdapter(&config.SandboxConfig{
		BaseURL:       failServer.URL,
		Timeout:       5,
		MaxRetries:    0,
		RetryInterval: 1,
	}, resource.ZapLogger)
	failLogic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		quotaDao,
		adapterFail,
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		resource.ZapLogger,
		"tpl-integration",
	)

	_, err = failLogic.CreateInstance(ctx, &transport.CreateInstanceRequest{Timeout: ptr(int32(20))})
	if !errors.Is(err, errcode.ErrSandboxServiceError) {
		t.Fatalf("expected sandbox service error, got %v", err)
	}

	pauseFailEntity := &modelinstance.Entity{
		InstanceId: "ins-pause-fail",
		Status:     modelinstance.InstanceStatusRunning,
		SandboxId:  "sbx-pause-fail",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, pauseFailEntity); err != nil {
		t.Fatalf("seed pause fail instance: %v", err)
	}
	if _, err := failLogic.PauseInstance(ctx, pauseFailEntity.InstanceId); !errors.Is(err, errcode.ErrSandboxServiceError) {
		t.Fatalf("expected sandbox service error on pause, got %v", err)
	}
	pauseFailRecord, err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).GetByInstanceID(ctx, pauseFailEntity.InstanceId)
	if err != nil {
		t.Fatalf("query pause fail record: %v", err)
	}
	if pauseFailRecord.Status != modelinstance.InstanceStatusRunning {
		t.Fatalf("pause failure should keep running status, got %s", pauseFailRecord.Status)
	}

	resumeEntity := &modelinstance.Entity{
		InstanceId: "ins-resume-ok",
		Status:     modelinstance.InstanceStatusPaused,
		SandboxId:  "sbx-resume-ok",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, resumeEntity); err != nil {
		t.Fatalf("seed resume instance: %v", err)
	}
	beforeResume := time.Now()
	resumeResp, err := logic.ResumeInstance(ctx, resumeEntity.InstanceId, &transport.ResumeInstanceRequest{Timeout: ptr(int32(120))})
	if err != nil {
		t.Fatalf("resume instance: %v", err)
	}
	if resumeResp.Status != modelinstance.InstanceStatusRunning {
		t.Fatalf("unexpected resume status: %s", resumeResp.Status)
	}
	if resumeResp.TimeoutAt == nil {
		t.Fatalf("expected timeout_at in resume response")
	}
	resumeRecord, err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).GetByInstanceID(ctx, resumeEntity.InstanceId)
	if err != nil {
		t.Fatalf("query resume record: %v", err)
	}
	if resumeRecord.Status != modelinstance.InstanceStatusRunning {
		t.Fatalf("expected running after resume, got %s", resumeRecord.Status)
	}
	if resumeRecord.TimeoutAt.Before(beforeResume.Add(118*time.Second)) || resumeRecord.TimeoutAt.After(beforeResume.Add(122*time.Second)) {
		t.Fatalf("unexpected timeout_at after resume: %v", resumeRecord.TimeoutAt)
	}

	resumeConflictEntity := &modelinstance.Entity{
		InstanceId: "ins-resume-conflict",
		Status:     modelinstance.InstanceStatusPaused,
		SandboxId:  "sbx-resume-conflict",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, resumeConflictEntity); err != nil {
		t.Fatalf("seed resume conflict instance: %v", err)
	}
	if _, err := logic.ResumeInstance(ctx, resumeConflictEntity.InstanceId, nil); err != nil {
		t.Fatalf("resume conflict should be idempotent: %v", err)
	}

	resumeInvalidEntity := &modelinstance.Entity{
		InstanceId: "ins-resume-invalid",
		Status:     modelinstance.InstanceStatusRunning,
		SandboxId:  "sbx-resume-invalid",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, resumeInvalidEntity); err != nil {
		t.Fatalf("seed resume invalid instance: %v", err)
	}
	if _, err := logic.ResumeInstance(ctx, resumeInvalidEntity.InstanceId, nil); !errors.Is(err, errcode.ErrInstanceStatusInvalid) {
		t.Fatalf("expected invalid status on resume, got %v", err)
	}

	resumeFailEntity := &modelinstance.Entity{
		InstanceId: "ins-resume-fail",
		Status:     modelinstance.InstanceStatusPaused,
		SandboxId:  "sbx-resume-fail",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, resumeFailEntity); err != nil {
		t.Fatalf("seed resume fail instance: %v", err)
	}
	if _, err := failLogic.ResumeInstance(ctx, resumeFailEntity.InstanceId, &transport.ResumeInstanceRequest{Timeout: ptr(int32(60))}); !errors.Is(err, errcode.ErrSandboxServiceError) {
		t.Fatalf("expected sandbox service error on resume, got %v", err)
	}
	resumeFailRecord, err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).GetByInstanceID(ctx, resumeFailEntity.InstanceId)
	if err != nil {
		t.Fatalf("query resume fail record: %v", err)
	}
	if resumeFailRecord.Status != modelinstance.InstanceStatusPaused {
		t.Fatalf("resume failure should keep paused status, got %s", resumeFailRecord.Status)
	}

	timeoutRunningEntity := &modelinstance.Entity{
		InstanceId: "ins-timeout-running",
		Status:     modelinstance.InstanceStatusRunning,
		SandboxId:  "sbx-timeout-ok",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, timeoutRunningEntity); err != nil {
		t.Fatalf("seed timeout running instance: %v", err)
	}
	timeoutPausedEntity := &modelinstance.Entity{
		InstanceId: "ins-timeout-paused",
		Status:     modelinstance.InstanceStatusPaused,
		SandboxId:  "sbx-timeout-paused",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, timeoutPausedEntity); err != nil {
		t.Fatalf("seed timeout paused instance: %v", err)
	}
	beforeTimeout := time.Now()
	timeoutResp, err := logic.SetInstanceTimeout(ctx, timeoutRunningEntity.InstanceId, &transport.SetTimeoutRequest{Timeout: ptr(int32(300))})
	if err != nil {
		t.Fatalf("set timeout for running instance: %v", err)
	}
	if timeoutResp.TimeoutAt == nil {
		t.Fatalf("expected timeout_at in timeout response")
	}
	if timeoutResp.TimeoutAt.Before(beforeTimeout.Add(298*time.Second)) || timeoutResp.TimeoutAt.After(beforeTimeout.Add(302*time.Second)) {
		t.Fatalf("unexpected timeout_at response: %v", timeoutResp.TimeoutAt)
	}
	if _, err := logic.SetInstanceTimeout(ctx, timeoutPausedEntity.InstanceId, &transport.SetTimeoutRequest{Timeout: ptr(int32(180))}); err != nil {
		t.Fatalf("set timeout for paused instance: %v", err)
	}

	timeoutInvalidEntity := &modelinstance.Entity{
		InstanceId: "ins-timeout-invalid",
		Status:     modelinstance.InstanceStatusCreating,
		SandboxId:  "sbx-timeout-invalid",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, timeoutInvalidEntity); err != nil {
		t.Fatalf("seed timeout invalid instance: %v", err)
	}
	if _, err := logic.SetInstanceTimeout(ctx, timeoutInvalidEntity.InstanceId, &transport.SetTimeoutRequest{Timeout: ptr(int32(10))}); !errors.Is(err, errcode.ErrInstanceStatusInvalid) {
		t.Fatalf("expected invalid status on timeout, got %v", err)
	}
	if _, err := logic.SetInstanceTimeout(ctx, timeoutRunningEntity.InstanceId, &transport.SetTimeoutRequest{Timeout: ptr(int32(0))}); !errors.Is(err, errcode.ErrInstanceInvalidParam) {
		t.Fatalf("expected invalid timeout param, got %v", err)
	}
	if _, err := logic.SetInstanceTimeout(ctx, timeoutRunningEntity.InstanceId, &transport.SetTimeoutRequest{Timeout: ptr(transport.MaxInstanceTimeoutSeconds + 1)}); !errors.Is(err, errcode.ErrInstanceInvalidParam) {
		t.Fatalf("expected timeout upper-bound validation, got %v", err)
	}

	timeoutFailEntity := &modelinstance.Entity{
		InstanceId: "ins-timeout-fail",
		Status:     modelinstance.InstanceStatusRunning,
		SandboxId:  "sbx-timeout-fail",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, timeoutFailEntity); err != nil {
		t.Fatalf("seed timeout fail instance: %v", err)
	}
	timeoutFailBefore, err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).GetByInstanceID(ctx, timeoutFailEntity.InstanceId)
	if err != nil {
		t.Fatalf("query timeout fail record before update: %v", err)
	}
	if _, err := failLogic.SetInstanceTimeout(ctx, timeoutFailEntity.InstanceId, &transport.SetTimeoutRequest{Timeout: ptr(int32(90))}); !errors.Is(err, errcode.ErrSandboxServiceError) {
		t.Fatalf("expected sandbox service error on timeout, got %v", err)
	}
	timeoutFailRecord, err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).GetByInstanceID(ctx, timeoutFailEntity.InstanceId)
	if err != nil {
		t.Fatalf("query timeout fail record: %v", err)
	}
	if !timeoutFailRecord.TimeoutAt.Equal(timeoutFailBefore.TimeoutAt) {
		t.Fatalf("timeout failure should keep timeout_at unchanged, got %v want %v", timeoutFailRecord.TimeoutAt, timeoutFailBefore.TimeoutAt)
	}

	listResp, err := logic.ListInstances(ctx, 1, 20)
	if err != nil {
		t.Fatalf("list instances: %v", err)
	}
	if listResp.Total != 14 {
		t.Fatalf("expected 14 instances, got %d", listResp.Total)
	}

	quotaEntity, err := quotaDao.SelectQuota(ctx.GetUserID(), "OPENCLAW_INSTANCE", "")
	if err != nil {
		t.Fatalf("select quota: %v", err)
	}
	if quotaEntity.ResourceQuotaAvailable != 1 {
		t.Fatalf("expected quota rollback to keep 1 available, got %d", quotaEntity.ResourceQuotaAvailable)
	}

	entities, total, err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).ListByUserID(ctx, ctx.GetUserID(), 1, 20)
	if err != nil {
		t.Fatalf("list entities: %v", err)
	}
	if total != 14 || len(entities) != 14 {
		t.Fatalf("expected 14 persisted entities, total=%d len=%d", total, len(entities))
	}

	var failedCount int
	for _, entity := range entities {
		if entity.Status == modelinstance.InstanceStatusFailed {
			failedCount++
		}
		if entity.TimeoutAt.Before(time.Now()) {
			t.Fatalf("timeout_at should be in future")
		}
	}
	if failedCount != 1 {
		t.Fatalf("expected one failed entity, got %d", failedCount)
	}

	if err := quotaDao.DB().Create(&quota.Entity{
		UserID:                 otherCtx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 0,
		ResourceQuotaTotal:     1,
	}).Error; err != nil {
		t.Fatalf("seed other tenant quota: %v", err)
	}

	deleteEntity := &modelinstance.Entity{
		InstanceId: "ins-delete-ok",
		Status:     modelinstance.InstanceStatusRunning,
		SandboxId:  "sbx-delete-ok",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, deleteEntity); err != nil {
		t.Fatalf("seed delete instance: %v", err)
	}

	destroyResp, err := logic.DestroyInstance(ctx, deleteEntity.InstanceId)
	if err != nil {
		t.Fatalf("destroy instance: %v", err)
	}
	if destroyResp.Status != modelinstance.InstanceStatusDeleted {
		t.Fatalf("unexpected destroy status: %s", destroyResp.Status)
	}
	if _, err := logic.GetInstance(ctx, deleteEntity.InstanceId); !errors.Is(err, errcode.ErrInstanceNotFound) {
		t.Fatalf("expected deleted instance hidden from queries, got %v", err)
	}

	quotaEntity, err = quotaDao.SelectQuota(ctx.GetUserID(), "OPENCLAW_INSTANCE", "")
	if err != nil {
		t.Fatalf("select quota after destroy: %v", err)
	}
	if quotaEntity.ResourceQuotaAvailable != 2 {
		t.Fatalf("expected quota release after destroy, got %d", quotaEntity.ResourceQuotaAvailable)
	}

	if err := quotaDao.DB().
		Model(&quota.Entity{}).
		Where("user_id = ? AND resource_name = ? AND resource_key = ?", ctx.GetUserID(), "OPENCLAW_INSTANCE", "").
		Update("resource_quota_available", 1).Error; err != nil {
		t.Fatalf("prepare quota for paused destroy: %v", err)
	}

	pausedEntity := &modelinstance.Entity{
		InstanceId: "ins-delete-paused",
		Status:     modelinstance.InstanceStatusPaused,
		SandboxId:  "sbx-delete-gone",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, pausedEntity); err != nil {
		t.Fatalf("seed paused instance: %v", err)
	}

	notFoundDeleteAdapter := psandbox.NewSandboxAdapter(&config.SandboxConfig{
		BaseURL:       notFoundDeleteServer.URL,
		Timeout:       5,
		MaxRetries:    0,
		RetryInterval: 1,
	}, resource.ZapLogger)
	notFoundDeleteLogic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		quotaDao,
		notFoundDeleteAdapter,
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		resource.ZapLogger,
		"tpl-integration",
	)

	if _, err := notFoundDeleteLogic.DestroyInstance(ctx, pausedEntity.InstanceId); err != nil {
		t.Fatalf("destroy paused instance with sandbox 404: %v", err)
	}

	quotaEntity, err = quotaDao.SelectQuota(ctx.GetUserID(), "OPENCLAW_INSTANCE", "")
	if err != nil {
		t.Fatalf("select quota after sandbox 404 destroy: %v", err)
	}
	if quotaEntity.ResourceQuotaAvailable != 2 {
		t.Fatalf("expected quota to stay capped at total after sandbox 404 destroy, got %d", quotaEntity.ResourceQuotaAvailable)
	}

	failedDeleteEntity := &modelinstance.Entity{
		InstanceId: "ins-delete-fail",
		Status:     modelinstance.InstanceStatusRunning,
		SandboxId:  "sbx-delete-fail",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(otherCtx).Create(otherCtx, failedDeleteEntity); err != nil {
		t.Fatalf("seed failed delete instance: %v", err)
	}

	failDeleteLogic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(otherCtx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(otherCtx),
		psandbox.NewSandboxAdapter(&config.SandboxConfig{
			BaseURL:       failServer.URL,
			Timeout:       5,
			MaxRetries:    0,
			RetryInterval: 1,
		}, resource.ZapLogger),
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		resource.ZapLogger,
		"tpl-integration",
	)

	_, err = failDeleteLogic.DestroyInstance(otherCtx, failedDeleteEntity.InstanceId)
	if !errors.Is(err, errcode.ErrSandboxServiceError) {
		t.Fatalf("expected sandbox service error on delete, got %v", err)
	}

	failedDeleteRecord, err := modelfactory.DefaultDaoFactory.InstanceDao(otherCtx).GetByInstanceID(otherCtx, failedDeleteEntity.InstanceId)
	if err != nil {
		t.Fatalf("query failed delete record: %v", err)
	}
	if failedDeleteRecord.Status != modelinstance.InstanceStatusFailed {
		t.Fatalf("expected failed delete record status, got %s", failedDeleteRecord.Status)
	}

	otherQuota, err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(otherCtx).
		SelectQuota(otherCtx.GetUserID(), "OPENCLAW_INSTANCE", "")
	if err != nil {
		t.Fatalf("select other tenant quota: %v", err)
	}
	if otherQuota.ResourceQuotaAvailable != 0 {
		t.Fatalf("delete failure should not release quota, got %d", otherQuota.ResourceQuotaAvailable)
	}

	if _, err := logic.DestroyInstance(ctx, "ins-not-found"); !errors.Is(err, errcode.ErrInstanceNotFound) {
		t.Fatalf("expected instance not found on destroy, got %v", err)
	}

	invalidEntity := &modelinstance.Entity{
		InstanceId: "ins-delete-invalid",
		Status:     modelinstance.InstanceStatusCreating,
		SandboxId:  "sbx-delete-invalid",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, invalidEntity); err != nil {
		t.Fatalf("seed invalid delete instance: %v", err)
	}

	_, err = logic.DestroyInstance(ctx, invalidEntity.InstanceId)
	if !errors.Is(err, errcode.ErrInstanceStatusInvalid) {
		t.Fatalf("expected invalid status error, got %v", err)
	}

	quotaLeakEntity := &modelinstance.Entity{
		InstanceId: "ins-delete-quota-fail",
		Status:     modelinstance.InstanceStatusRunning,
		SandboxId:  "sbx-delete-gone-2",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, quotaLeakEntity); err != nil {
		t.Fatalf("seed quota failure instance: %v", err)
	}

	if err := quotaDao.DB().
		Model(&quota.Entity{}).
		Where("user_id = ? AND resource_name = ? AND resource_key = ?", ctx.GetUserID(), "OPENCLAW_INSTANCE", "").
		Update("resource_quota_available", 2).Error; err != nil {
		t.Fatalf("prepare already released quota: %v", err)
	}

	destroyResp, err = notFoundDeleteLogic.DestroyInstance(ctx, quotaLeakEntity.InstanceId)
	if err != nil {
		t.Fatalf("destroy with already released quota: %v", err)
	}
	if destroyResp.Status != modelinstance.InstanceStatusDeleted {
		t.Fatalf("expected deleted status with already released quota, got %s", destroyResp.Status)
	}
}

func ptr[T any](v T) *T {
	return &v
}
