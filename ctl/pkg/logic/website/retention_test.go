package website

import (
	modelwebsite "ctl/pkg/model/website"
	"ctl/pkg/resource"
	"fmt"
	"testing"
	"time"
)

func TestRetentionPreservesActiveRecentAndRollbackWindow(t *testing.T) {
	now := time.Now().UTC()
	old := now.Add(-48 * time.Hour)
	recent := now.Add(-time.Hour)
	site := modelwebsite.SiteEntity{SiteID: "ws-test", Status: modelwebsite.SiteStatusActive, ActiveReleaseID: "wr-one"}
	site.UserID = "owner"
	var releases []modelwebsite.ReleaseEntity
	for i, id := range []string{"wr-one", "wr-two", "wr-three", "wr-four", "wr-five"} {
		r := modelwebsite.ReleaseEntity{SiteID: site.SiteID, ReleaseID: id, Version: i + 1, Status: modelwebsite.ReleaseStatusSuperseded}
		r.UserID = site.UserID
		r.UpdatedTime = &old
		releases = append(releases, r)
	}
	releases[0].Status = modelwebsite.ReleaseStatusActive
	releases[4].UpdatedTime = &recent
	got, err := planReleaseRetention(site, releases, nil, now, 2, 24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != "wr-three" || got[1] != "wr-two" {
		t.Fatalf("unsafe plan: %v", got)
	}
}
func TestRetentionFailsClosedForUnsettledOperationsAndBadSnapshot(t *testing.T) {
	now := time.Now().UTC()
	old := now.Add(-48 * time.Hour)
	site := modelwebsite.SiteEntity{SiteID: "ws-test", Status: modelwebsite.SiteStatusActive, ActiveReleaseID: "wr-active"}
	site.UserID = "owner"
	r := modelwebsite.ReleaseEntity{SiteID: site.SiteID, ReleaseID: "wr-active", Status: modelwebsite.ReleaseStatusActive}
	r.UserID = site.UserID
	r.UpdatedTime = &old
	for _, state := range []string{modelwebsite.OpStatusCreated, modelwebsite.OpStatusRunning, modelwebsite.OpStatusFailed, modelwebsite.OpStatusDead, "unknown"} {
		op := modelwebsite.OperationEntity{SiteID: site.SiteID, Status: state}
		op.UserID = site.UserID
		if _, err := planReleaseRetention(site, []modelwebsite.ReleaseEntity{r}, []modelwebsite.OperationEntity{op}, now, 2, time.Hour); err == nil {
			t.Fatalf("accepted operation %s", state)
		}
	}
	foreign := r
	foreign.UserID = "other"
	if _, err := planReleaseRetention(site, []modelwebsite.ReleaseEntity{foreign}, nil, now, 2, time.Hour); err == nil {
		t.Fatal("accepted foreign release")
	}
	if _, err := planReleaseRetention(site, nil, nil, now, 2, time.Hour); err == nil {
		t.Fatal("accepted missing active release")
	}
	if _, err := planReleaseRetention(site, []modelwebsite.ReleaseEntity{r, r}, nil, now, 2, time.Hour); err == nil {
		t.Fatal("accepted duplicate release")
	}
}

func TestRetentionReservationIsDurableAndBlocksRollback(t *testing.T) {
	l := setupCreateReleaseTest(t, 1000)
	old := time.Now().Add(-48 * time.Hour)
	for i, id := range []string{"wr-active", "wr-old", "wr-newer"} {
		state := modelwebsite.ReleaseStatusSuperseded
		if i == 0 {
			state = modelwebsite.ReleaseStatusActive
		}
		seedRelease(t, id, "ws-a", "user-1", i+1, state)
	}
	if err := resource.GormDB.Table(modelwebsite.SitesTable).Where("site_id = ?", "ws-a").Update("active_release_id", "wr-active").Error; err != nil {
		t.Fatal(err)
	}
	if err := resource.GormDB.Table(modelwebsite.ReleasesTable).Where("site_id = ?", "ws-a").Update("updated_time", old).Error; err != nil {
		t.Fatal(err)
	}
	op, err := l.reserveReleaseRetention("ws-a", time.Now(), 1, 24*time.Hour)
	if err != nil || op == nil {
		t.Fatalf("reservation: %v", err)
	}
	if op.ReleaseID != "wr-old" || op.OperationType != "prune_release" || op.SiteGeneration != 2 {
		t.Fatalf("bad reservation: %+v", op)
	}
	var r modelwebsite.ReleaseEntity
	if err := resource.GormDB.Where("release_id = ?", "wr-old").First(&r).Error; err != nil {
		t.Fatal(err)
	}
	if r.Status != "pruning" {
		t.Fatal("rollback eligibility not fenced")
	}
	if _, err := l.RollbackRelease("user-1", "ws-a", "wr-old"); err == nil {
		t.Fatal("rollback admitted pruning target")
	}
	if _, err := l.CreateRelease("user-1", "ws-a", validReleaseRequest(10)); err == nil {
		t.Fatal("publish admitted while prune reserved")
	}
	if _, err := l.reserveReleaseRetention("ws-a", time.Now(), 1, time.Hour); err == nil {
		t.Fatal("second prune admitted")
	}
}

func TestRetentionCompletionKeepsActivePointerAndFailureIsRetryable(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(fmt.Sprint(fail), func(t *testing.T) {
			l := setupCreateReleaseTest(t, 1000)
			seedRelease(t, "wr-active", "ws-a", "user-1", 2, modelwebsite.ReleaseStatusActive)
			seedRelease(t, "wr-pruning", "ws-a", "user-1", 1, "pruning")
			if err := resource.GormDB.Table(modelwebsite.SitesTable).Where("site_id = ?", "ws-a").Update("active_release_id", "wr-active").Error; err != nil {
				t.Fatal(err)
			}
			op := modelwebsite.OperationEntity{OperationID: "wo-prune", SiteID: "ws-a", ReleaseID: "wr-pruning", OperationType: "prune_release", Status: modelwebsite.OpStatusCreated, SiteGeneration: 1}
			op.UserID = "user-1"
			if err := resource.GormDB.Create(&op).Error; err != nil {
				t.Fatal(err)
			}
			claimed, ok, err := l.ClaimOperation(op.OperationID, "worker", time.Minute)
			if err != nil || !ok {
				t.Fatalf("claim: %v", err)
			}
			if fail {
				err = l.FailOperation(op.OperationID, claimed.LeaseToken, "temporary outage")
			} else {
				err = l.CompleteOperation(op.OperationID, claimed.LeaseToken, "", "")
			}
			if err != nil {
				t.Fatal(err)
			}
			var r modelwebsite.ReleaseEntity
			resource.GormDB.Where("release_id = ?", "wr-pruning").First(&r)
			var after modelwebsite.OperationEntity
			resource.GormDB.Where("operation_id = ?", op.OperationID).First(&after)
			if fail {
				if after.Status != modelwebsite.OpStatusCreated || r.Status != "pruning" {
					t.Fatal("cleanup not retryable/fenced")
				}
			} else {
				if r.Status != "pruned" || after.Status != modelwebsite.OpStatusSuccess {
					t.Fatal("cleanup not finalized")
				}
			}
			site := loadSite(t, "ws-a")
			if site.ActiveReleaseID != "wr-active" || site.Status != modelwebsite.SiteStatusActive {
				t.Fatal("cleanup changed live site")
			}
		})
	}
}

// Completed cleanup tombstones must not permanently disable later retention.
func TestRetentionSkipsPrunedHistoryButRejectsPrunedActiveOrForeign(t *testing.T) {
	now := time.Now().UTC()
	old := now.Add(-48 * time.Hour)
	site := modelwebsite.SiteEntity{SiteID: "ws-test", ActiveReleaseID: "wr-active", Status: modelwebsite.SiteStatusActive}
	site.UserID = "owner"
	var releases []modelwebsite.ReleaseEntity
	for i, status := range []string{modelwebsite.ReleaseStatusActive, "pruned", modelwebsite.ReleaseStatusSuperseded, modelwebsite.ReleaseStatusSuperseded} {
		r := modelwebsite.ReleaseEntity{SiteID: site.SiteID, ReleaseID: fmt.Sprintf("wr-%d", i), Version: i + 1, Status: status}
		r.UserID = site.UserID
		r.UpdatedTime = &old
		releases = append(releases, r)
	}
	releases[0].ReleaseID = site.ActiveReleaseID
	got, err := planReleaseRetention(site, releases, nil, now, 1, time.Hour)
	if err != nil || len(got) != 1 || got[0] != "wr-2" {
		t.Fatalf("subsequent retention blocked: %v %v", got, err)
	}
	releases[1].UserID = "foreign"
	if _, err := planReleaseRetention(site, releases, nil, now, 1, time.Hour); err == nil {
		t.Fatal("foreign tombstone accepted")
	}
	releases[1].UserID = site.UserID
	releases[0].Status = "pruned"
	if _, err := planReleaseRetention(site, releases, nil, now, 1, time.Hour); err == nil {
		t.Fatal("pruned active pointer accepted")
	}
}

func TestRetentionInternalSnapshotHydratesDeletionGuards(t *testing.T) {
	l := setupCreateReleaseTest(t, 1000)
	seedRelease(t, "wr-pruning", "ws-a", "user-1", 1, "pruning")
	if err := resource.GormDB.Table(modelwebsite.SitesTable).Where("site_id = ?", "ws-a").Updates(map[string]interface{}{"active_release_id": "wr-active", "cloud_path": "sites/ws-a/releases/wr-active/", "operation_generation": 7}).Error; err != nil {
		t.Fatal(err)
	}
	op := modelwebsite.OperationEntity{OperationID: "wo-prune", SiteID: "ws-a", ReleaseID: "wr-pruning", OperationType: "prune_release", Status: modelwebsite.OpStatusCreated, SiteGeneration: 7}
	op.UserID = "user-1"
	if err := resource.GormDB.Create(&op).Error; err != nil {
		t.Fatal(err)
	}
	current, ok, err := l.ClaimOperation(op.OperationID, "worker", time.Minute)
	if err != nil || !ok {
		t.Fatalf("claim %v %v", ok, err)
	}
	if current.ReleaseStatus != "pruning" || current.ActiveReleaseID != "wr-active" || current.ActiveCloudPath != "sites/ws-a/releases/wr-active/" || current.CurrentSiteGeneration != 7 || current.SiteGeneration != 7 || current.LeaseExpiresAt == nil || current.LeaseToken == "" {
		t.Fatal("incomplete deletion authorization snapshot")
	}
}

func TestRetentionIgnoresTerminalPublishFailureWithoutDeletingItsArtifacts(t *testing.T) {
	now := time.Now().UTC()
	old := now.Add(-48 * time.Hour)
	site := modelwebsite.SiteEntity{SiteID: "ws-test", ActiveReleaseID: "wr-active", Status: modelwebsite.SiteStatusActive}
	site.UserID = "owner"
	var releases []modelwebsite.ReleaseEntity
	for i, state := range []string{modelwebsite.ReleaseStatusActive, modelwebsite.ReleaseStatusSuperseded, modelwebsite.ReleaseStatusSuperseded, modelwebsite.ReleaseStatusFailed} {
		r := modelwebsite.ReleaseEntity{SiteID: site.SiteID, ReleaseID: fmt.Sprintf("wr-%d", i), Version: i + 1, Status: state}
		r.UserID = site.UserID
		r.UpdatedTime = &old
		releases = append(releases, r)
	}
	releases[0].ReleaseID = site.ActiveReleaseID
	op := modelwebsite.OperationEntity{SiteID: site.SiteID, ReleaseID: "wr-3", OperationType: modelwebsite.OpTypeDeploy, Status: modelwebsite.OpStatusFailed}
	op.UserID = site.UserID
	got, err := planReleaseRetention(site, releases, []modelwebsite.OperationEntity{op}, now, 1, time.Hour)
	if err != nil || len(got) != 1 || got[0] != "wr-1" {
		t.Fatalf("terminal publish blocked successful-history retention: %v %v", got, err)
	}
	op.OperationType = "prune_release"
	if _, err := planReleaseRetention(site, releases, []modelwebsite.OperationEntity{op}, now, 1, time.Hour); err == nil {
		t.Fatal("unfinished failed cleanup ignored")
	}
}

func TestRetentionDeadLetterRevivalKeepsTargetFenced(t *testing.T) {
	l := setupCreateReleaseTest(t, 1000)
	seedRelease(t, "wr-pruning", "ws-a", "user-1", 1, "pruning")
	op := modelwebsite.OperationEntity{OperationID: "wo-prune", SiteID: "ws-a", ReleaseID: "wr-pruning", OperationType: "prune_release", Status: modelwebsite.OpStatusRunning, SiteGeneration: 1, Attempt: maxOperationAttempts, LeaseToken: "last-lease"}
	op.UserID = "user-1"
	if err := resource.GormDB.Create(&op).Error; err != nil {
		t.Fatal(err)
	}
	if err := l.FailOperation(op.OperationID, op.LeaseToken, "storage outage"); err != nil {
		t.Fatal(err)
	}
	var dead modelwebsite.OperationEntity
	if err := resource.GormDB.Where("operation_id = ?", op.OperationID).First(&dead).Error; err != nil {
		t.Fatal(err)
	}
	if dead.Status != modelwebsite.OpStatusDead {
		t.Fatalf("status=%s", dead.Status)
	}
	revived, err := l.ReviveOperation(op.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	if revived.Status != modelwebsite.OpStatusCreated || revived.Attempt != 0 || revived.ReleaseStatus != "pruning" || revived.LeaseToken != "" {
		t.Fatal("revival removed fencing or retained exhausted lease")
	}
	claimed, ok, err := l.ClaimOperation(op.OperationID, "recovery-worker", time.Minute)
	if err != nil || !ok {
		t.Fatalf("claim %v %v", ok, err)
	}
	if err := l.CompleteOperation(op.OperationID, claimed.LeaseToken, "", ""); err != nil {
		t.Fatal(err)
	}
	// Lost completion responses must be safely repeatable with the same lease.
	if err := l.CompleteOperation(op.OperationID, claimed.LeaseToken, "", ""); err != nil {
		t.Fatal(err)
	}
	var release modelwebsite.ReleaseEntity
	if err := resource.GormDB.Where("release_id = ?", op.ReleaseID).First(&release).Error; err != nil {
		t.Fatal(err)
	}
	if release.Status != "pruned" {
		t.Fatal("revived cleanup not finalized")
	}
}

func TestRetentionPolicyFailsClosed(t *testing.T) {
	for _, tc := range []struct {
		enabled, keep, grace string
		ok                   bool
	}{
		{"", "2", "24h", false}, {"true", "", "24h", false}, {"true", "0", "24h", false}, {"true", "31", "24h", false}, {"true", "2", "0s", false}, {"true", "2", "bad", false}, {"true", "2", "24h", true},
	} {
		t.Run(fmt.Sprintf("%s-%s-%s", tc.enabled, tc.keep, tc.grace), func(t *testing.T) {
			t.Setenv("WEBSITE_RETENTION_ENABLED", tc.enabled)
			t.Setenv("WEBSITE_RETENTION_KEEP", tc.keep)
			t.Setenv("WEBSITE_RETENTION_GRACE", tc.grace)
			_, _, err := releaseRetentionPolicy()
			if (err == nil) != tc.ok {
				t.Fatalf("policy accepted=%v wanted=%v", err == nil, tc.ok)
			}
		})
	}
}

func TestRetentionInternalTriggerPersistsOnlyWithExplicitPolicyAndScope(t *testing.T) {
	l := setupCreateReleaseTest(t, 1000)
	t.Setenv("WEBSITE_RETENTION_ENABLED", "true")
	t.Setenv("WEBSITE_RETENTION_KEEP", "1")
	t.Setenv("WEBSITE_RETENTION_GRACE", "24h")
	t.Setenv("WEBSITE_RUNTIME_BASE_URL", "https://runtime.invalid")
	t.Setenv("WEBSITE_RUNTIME_DEPLOY_TOKEN", "test-only")
	t.Setenv("WEBSITE_BACKEND_BETA_USERS", "user-1")
	old := time.Now().Add(-48 * time.Hour)
	for i, id := range []string{"wr-active", "wr-old", "wr-recent"} {
		status := modelwebsite.ReleaseStatusSuperseded
		if i == 0 {
			status = modelwebsite.ReleaseStatusActive
		}
		seedRelease(t, id, "ws-a", "user-1", i+1, status)
	}
	if err := resource.GormDB.Table(modelwebsite.SitesTable).Where("site_id = ?", "ws-a").Updates(map[string]interface{}{"active_release_id": "wr-active", "kind": "fullstack"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := resource.GormDB.Table(modelwebsite.ReleasesTable).Where("site_id = ?", "ws-a").Update("updated_time", old).Error; err != nil {
		t.Fatal(err)
	}
	t.Setenv("WEBSITE_BACKEND_BETA_USERS", "other")
	if _, err := l.ScheduleReleaseRetention("ws-a"); err == nil {
		t.Fatal("out of scope cleanup accepted")
	}
	t.Setenv("WEBSITE_BACKEND_BETA_USERS", "user-1")
	op, err := l.ScheduleReleaseRetention("ws-a")
	if err != nil || op == nil {
		t.Fatalf("schedule: %v", err)
	}
	if op.ReleaseID != "wr-old" {
		t.Fatalf("wrong target %s", op.ReleaseID)
	}
	if _, err := l.ScheduleReleaseRetention("ws-a"); err == nil {
		t.Fatal("duplicate reservation admitted")
	}
}

func TestRetentionRecoversAfterPassLifecycleWithoutReactivatingTarget(t *testing.T) {
	l := setupCreateReleaseTest(t, 1000)
	seedRelease(t, "wr-active", "ws-a", "user-1", 2, modelwebsite.ReleaseStatusActive)
	seedRelease(t, "wr-pruning", "ws-a", "user-1", 1, "pruning")
	if err := resource.GormDB.Table(modelwebsite.SitesTable).Where("site_id = ?", "ws-a").Update("active_release_id", "wr-active").Error; err != nil {
		t.Fatal(err)
	}
	expiry := time.Now().Add(time.Hour)
	op := modelwebsite.OperationEntity{OperationID: "wo-prune", SiteID: "ws-a", ReleaseID: "wr-pruning", OperationType: "prune_release", Status: modelwebsite.OpStatusRunning, SiteGeneration: 1, LeaseToken: "old-worker", LeaseExpiresAt: &expiry}
	op.UserID = "user-1"
	if err := resource.GormDB.Create(&op).Error; err != nil {
		t.Fatal(err)
	}
	if err := l.OnPassIsolated("user-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := l.reserveReleaseRetention("ws-a", time.Now(), 1, time.Hour); err == nil {
		t.Fatal("cleanup resumed while suspended")
	}
	if err := l.OnPassRenewed("user-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := l.reserveReleaseRetention("ws-a", time.Now(), 1, time.Hour); err == nil {
		t.Fatal("replaced a live lease")
	}
	expired := time.Now().Add(-time.Minute)
	if err := resource.GormDB.Table(modelwebsite.OperationsTable).Where("operation_id = ?", op.OperationID).Update("lease_expires_at", expired).Error; err != nil {
		t.Fatal(err)
	}
	recovered, err := l.reserveReleaseRetention("ws-a", time.Now(), 1, time.Hour)
	if err != nil || recovered == nil {
		t.Fatalf("interrupted cleanup not recovered: %v", err)
	}
	if recovered.OperationID != op.OperationID || recovered.Status != modelwebsite.OpStatusCreated || recovered.LeaseToken != "" || recovered.SiteGeneration <= op.SiteGeneration {
		t.Fatal("unsafe recovery")
	}
	if err := l.CompleteOperation(op.OperationID, op.LeaseToken, "", ""); err == nil {
		t.Fatal("old worker completion accepted")
	}
	current, ok, err := l.ClaimOperation(op.OperationID, "new-worker", time.Minute)
	if err != nil || !ok {
		t.Fatalf("claim %v %v", ok, err)
	}
	if err := l.CompleteOperation(op.OperationID, current.LeaseToken, "", ""); err != nil {
		t.Fatal(err)
	}
	if site := loadSite(t, "ws-a"); site.ActiveReleaseID != "wr-active" || site.Status != modelwebsite.SiteStatusActive {
		t.Fatal("recovery changed live pointer")
	}
}

func TestRetentionRecoveryDoesNotReviveDeadOrCompeteWithNewWork(t *testing.T) {
	for _, scenario := range []string{"dead", "new-publish", "active-target"} {
		t.Run(scenario, func(t *testing.T) {
			l := setupCreateReleaseTest(t, 1000)
			seedRelease(t, "wr-active", "ws-a", "user-1", 2, modelwebsite.ReleaseStatusActive)
			seedRelease(t, "wr-pruning", "ws-a", "user-1", 1, "pruning")
			if err := resource.GormDB.Table(modelwebsite.SitesTable).Where("site_id = ?", "ws-a").Updates(map[string]interface{}{"active_release_id": "wr-active", "operation_generation": 3}).Error; err != nil {
				t.Fatal(err)
			}
			op := modelwebsite.OperationEntity{OperationID: "wo-old", SiteID: "ws-a", ReleaseID: "wr-pruning", OperationType: "prune_release", Status: modelwebsite.OpStatusFailed, SiteGeneration: 1}
			op.UserID = "user-1"
			if scenario == "dead" {
				op.Status = modelwebsite.OpStatusDead
			}
			if scenario == "active-target" {
				op.ReleaseID = "wr-active"
			}
			if err := resource.GormDB.Create(&op).Error; err != nil {
				t.Fatal(err)
			}
			if scenario == "new-publish" {
				other := modelwebsite.OperationEntity{OperationID: "wo-new", SiteID: "ws-a", OperationType: modelwebsite.OpTypeDeploy, Status: modelwebsite.OpStatusCreated, SiteGeneration: 3}
				other.UserID = "user-1"
				if err := resource.GormDB.Create(&other).Error; err != nil {
					t.Fatal(err)
				}
			}
			if _, err := l.reserveReleaseRetention("ws-a", time.Now(), 1, time.Hour); err == nil {
				t.Fatal("unsafe recovery admitted")
			}
			if site := loadSite(t, "ws-a"); site.OperationGeneration != 3 {
				t.Fatal("rejected recovery mutated generation")
			}
		})
	}
}

func TestRetentionSweepBoundedCursorAndScope(t *testing.T) {
	l := setupCreateReleaseTest(t, 1000)
	t.Setenv("WEBSITE_RETENTION_ENABLED", "true")
	t.Setenv("WEBSITE_RETENTION_KEEP", "1")
	t.Setenv("WEBSITE_RETENTION_GRACE", "24h")
	t.Setenv("WEBSITE_BACKEND_BETA_USERS", "")
	for i := 0; i < 23; i++ {
		site := modelwebsite.SiteEntity{SiteID: fmt.Sprintf("ws-%03d", i), Kind: "fullstack", Status: modelwebsite.SiteStatusActive}
		site.UserID = "not-allowlisted"
		if err := resource.GormDB.Create(&site).Error; err != nil {
			t.Fatal(err)
		}
	}
	first, err := l.SweepReleaseRetention("")
	if err != nil {
		t.Fatal(err)
	}
	if first.Scanned != 20 || first.NextCursor != "ws-019" || first.Scheduled != 0 {
		t.Fatalf("first page %+v", first)
	}
	second, err := l.SweepReleaseRetention(first.NextCursor)
	if err != nil {
		t.Fatal(err)
	}
	if second.Scanned != 3 || second.NextCursor != "" || second.Scheduled != 0 {
		t.Fatalf("second page %+v", second)
	}
	t.Setenv("WEBSITE_RETENTION_ENABLED", "")
	if _, err := l.SweepReleaseRetention(""); err == nil {
		t.Fatal("disabled sweep ran")
	}
}

func TestRetentionReservesFailedArtifactOnlyAfterTerminalFailureAndGrace(t *testing.T) {
	for _, scenario := range []string{"eligible", "recent", "no-failure-operation"} {
		t.Run(scenario, func(t *testing.T) {
			l := setupCreateReleaseTest(t, 1000)
			seedRelease(t, "wr-active", "ws-a", "user-1", 2, modelwebsite.ReleaseStatusActive)
			seedRelease(t, "wr-failed", "ws-a", "user-1", 1, modelwebsite.ReleaseStatusFailed)
			if err := resource.GormDB.Table(modelwebsite.SitesTable).Where("site_id = ?", "ws-a").Update("active_release_id", "wr-active").Error; err != nil {
				t.Fatal(err)
			}
			age := time.Now().Add(-48 * time.Hour)
			if scenario == "recent" {
				age = time.Now()
			}
			if err := resource.GormDB.Table(modelwebsite.ReleasesTable).Where("release_id = ?", "wr-failed").Update("updated_time", age).Error; err != nil {
				t.Fatal(err)
			}
			if scenario != "no-failure-operation" {
				op := modelwebsite.OperationEntity{OperationID: "wo-failed", SiteID: "ws-a", ReleaseID: "wr-failed", OperationType: modelwebsite.OpTypeDeploy, Status: modelwebsite.OpStatusFailed}
				op.UserID = "user-1"
				if err := resource.GormDB.Create(&op).Error; err != nil {
					t.Fatal(err)
				}
			}
			op, err := l.reserveReleaseRetention("ws-a", time.Now(), 1, time.Hour)
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "eligible" {
				if op == nil || op.ReleaseID != "wr-failed" {
					t.Fatal("eligible failed artifact not reserved")
				}
			} else if op != nil {
				t.Fatal("unproven/recent failed artifact selected")
			}
		})
	}
}
