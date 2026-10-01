package website

import (
	"ctl/pkg/errcode"
	modelwebsite "ctl/pkg/model/website"
	"ctl/pkg/resource"
	"fmt"
	"go.uber.org/zap"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"os"
	"sort"
	"strconv"
	"time"
)

// planReleaseRetention is a conservative, side-effect-free candidate selector.
// It is NOT deletion authorization. An executor must fence the site generation,
// exclude rollback/deploy admission and persist a non-rollbackable state BEFORE
// deleting either static or runtime artifacts. Never execute a stale plan.
// keep counts successful historical revisions, in addition to the active one.
func planReleaseRetention(site modelwebsite.SiteEntity, releases []modelwebsite.ReleaseEntity, operations []modelwebsite.OperationEntity, now time.Time, keep int, grace time.Duration) ([]string, error) {
	if site.SiteID == "" || site.UserID == "" || site.ActiveReleaseID == "" || site.Status != modelwebsite.SiteStatusActive || keep < 1 || grace <= 0 || now.IsZero() {
		return nil, fmt.Errorf("invalid retention snapshot or policy")
	}
	for _, op := range operations {
		if op.SiteID != site.SiteID || op.UserID != site.UserID {
			return nil, fmt.Errorf("foreign operation; reconcile before retention")
		}
		// A failed user publish is terminal, unlike cleanup which may be
		// partially executed and needs reconciliation. Do not let one old
		// publish failure disable successful-history retention forever.
		terminalPublishFailure := op.Status == modelwebsite.OpStatusFailed &&
			(op.OperationType == modelwebsite.OpTypeDeploy || op.OperationType == "rollback" || op.OperationType == modelwebsite.OpTypeCreate)
		if op.Status != modelwebsite.OpStatusSuccess && !terminalPublishFailure {
			return nil, fmt.Errorf("unsettled operation; reconcile before retention")
		}
	}
	seen := map[string]bool{}
	activeFound := false
	var historical []modelwebsite.ReleaseEntity
	for _, r := range releases {
		if r.SiteID != site.SiteID || r.UserID != site.UserID || r.ReleaseID == "" || seen[r.ReleaseID] {
			return nil, fmt.Errorf("invalid release identity")
		}
		seen[r.ReleaseID] = true
		if r.ReleaseID == site.ActiveReleaseID {
			if r.Status != modelwebsite.ReleaseStatusActive {
				return nil, fmt.Errorf("active pointer mismatch")
			}
			activeFound = true
			continue
		}
		// Completed tombstones retain identity for audit, but consume neither the
		// rollback window nor a deletion slot. Identity and active-pointer checks
		// above still apply; a pruned active revision is an inconsistent snapshot.
		if r.Status == "pruned" || r.Status == modelwebsite.ReleaseStatusFailed {
			// Failed artifacts are NOT deletion candidates here. Orphan
			// reconciliation owns them; this policy only prunes successes.
			continue
		}
		// Unknown and in-flight revisions still block retention.
		if r.Status != modelwebsite.ReleaseStatusSuperseded {
			return nil, fmt.Errorf("unsettled release; reconcile before retention")
		}
		historical = append(historical, r)
	}
	if !activeFound {
		return nil, fmt.Errorf("active release absent from snapshot")
	}
	sort.Slice(historical, func(i, j int) bool {
		if historical[i].Version == historical[j].Version {
			return historical[i].ReleaseID < historical[j].ReleaseID
		}
		return historical[i].Version > historical[j].Version
	})
	var candidates []string
	for i, r := range historical {
		if i < keep || r.UpdatedTime == nil || r.UpdatedTime.After(now.Add(-grace)) {
			continue
		}
		candidates = append(candidates, r.ReleaseID)
	}
	return candidates, nil
}

// reserveReleaseRetention persists exactly one cleanup intent in the same
// transaction that removes its rollback eligibility. No remote I/O occurs here.
// Called only through the explicit, disabled-by-default internal policy gate.
func (l *logic) reserveReleaseRetention(siteID string, now time.Time, keep int, grace time.Duration) (*modelwebsite.OperationEntity, error) {
	var reserved *modelwebsite.OperationEntity
	err := resource.GormDB.Transaction(func(tx *gorm.DB) error {
		var site modelwebsite.SiteEntity
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("site_id = ?", siteID).First(&site).Error; err != nil {
			return err
		}
		var releases []modelwebsite.ReleaseEntity
		if err := tx.Where("site_id = ?", siteID).Find(&releases).Error; err != nil {
			return err
		}
		var operations []modelwebsite.OperationEntity
		if err := tx.Where("site_id = ?", siteID).Find(&operations).Error; err != nil {
			return err
		}
		recovered, err := recoverInterruptedRetention(tx, site, releases, operations, now)
		if err != nil {
			return err
		}
		if recovered != nil {
			reserved = recovered
			return nil
		}
		candidates, err := planReleaseRetention(site, releases, operations, now, keep, grace)
		if err != nil {
			return err
		}
		targetStatus := modelwebsite.ReleaseStatusSuperseded
		if len(candidates) == 0 {
			candidates = failedArtifactCandidates(site, releases, operations, now, grace)
			targetStatus = modelwebsite.ReleaseStatusFailed
		}
		if len(candidates) == 0 {
			return nil
		}
		operationID, err := l.generateID("website_operation", "wo")
		if err != nil {
			return err
		}
		target := candidates[len(candidates)-1]
		changed := tx.Model(&modelwebsite.ReleaseEntity{}).Where("site_id = ? AND release_id = ? AND status = ?", siteID, target, targetStatus).Update("status", "pruning")
		if changed.Error != nil {
			return changed.Error
		}
		if changed.RowsAffected != 1 {
			return fmt.Errorf("retention target changed")
		}
		site.OperationGeneration++
		if err := tx.Model(&site).Update("operation_generation", site.OperationGeneration).Error; err != nil {
			return err
		}
		op := modelwebsite.OperationEntity{OperationID: operationID, SiteID: siteID, ReleaseID: target, OperationType: "prune_release", Status: modelwebsite.OpStatusCreated, SiteGeneration: site.OperationGeneration}
		op.UserID = site.UserID
		if err := tx.Create(&op).Error; err != nil {
			return err
		}
		reserved = &op
		return nil
	})
	return reserved, err
}

// Policy is explicit and disabled by default. Keep headroom below the runtime's
// 32-revision bound; grace can still delay deletion, so admission must fail safely.
func releaseRetentionPolicy() (int, time.Duration, error) {
	if os.Getenv("WEBSITE_RETENTION_ENABLED") != "true" {
		return 0, 0, errcode.ErrWebsiteBackendUnavailable
	}
	keep, err := strconv.Atoi(os.Getenv("WEBSITE_RETENTION_KEEP"))
	if err != nil || keep < 1 || keep > 16 {
		return 0, 0, errcode.ErrWebsiteInvalidParam
	}
	grace, err := time.ParseDuration(os.Getenv("WEBSITE_RETENTION_GRACE"))
	if err != nil || grace < time.Hour || grace > 30*24*time.Hour {
		return 0, 0, errcode.ErrWebsiteInvalidParam
	}
	return keep, grace, nil
}

// ScheduleReleaseRetention is an internal, one-site trigger. It uses deployment
// policy, not caller-supplied retention values. Durable worker polling picks up
// the reserved operation even if notification is lost.
func (l *logic) ScheduleReleaseRetention(siteID string) (*modelwebsite.OperationEntity, error) {
	keep, grace, err := releaseRetentionPolicy()
	if err != nil {
		return nil, err
	}
	site, err := l.siteDao.GetBySiteID(siteID)
	if err != nil {
		return nil, err
	}
	if site == nil {
		return nil, errcode.ErrWebsiteNotFound
	}
	if site.Kind != "fullstack" || !backendEnabledFor(site.UserID) {
		return nil, errcode.ErrWebsiteBackendUnavailable
	}
	op, err := l.reserveReleaseRetention(siteID, time.Now().UTC(), keep, grace)
	if err != nil {
		return nil, err
	}
	if op != nil {
		l.notifyDeployer(op.OperationID)
	}
	return op, nil
}

// recoverInterruptedRetention retries only a previously reserved pruning target
// superseded by a site lifecycle transition. It never restores rollback eligibility
// or retries dead-letter failures automatically. Caller holds the site row lock.
func recoverInterruptedRetention(tx *gorm.DB, site modelwebsite.SiteEntity, releases []modelwebsite.ReleaseEntity, operations []modelwebsite.OperationEntity, now time.Time) (*modelwebsite.OperationEntity, error) {
	if site.Status != modelwebsite.SiteStatusActive || site.ActiveReleaseID == "" {
		return nil, nil
	}
	var candidate *modelwebsite.OperationEntity
	for i := range operations {
		op := operations[i]
		if op.UserID != site.UserID || op.SiteID != site.SiteID {
			return nil, fmt.Errorf("foreign retention operation")
		}
		if op.Status == modelwebsite.OpStatusSuccess {
			continue
		}
		if op.Status == modelwebsite.OpStatusFailed && (op.OperationType == modelwebsite.OpTypeDeploy || op.OperationType == modelwebsite.OpTypeCreate || op.OperationType == "rollback") {
			continue
		}
		staleCleanup := op.OperationType == "prune_release" && op.SiteGeneration > 0 && op.SiteGeneration < site.OperationGeneration
		retryableState := op.Status == modelwebsite.OpStatusCreated || op.Status == modelwebsite.OpStatusFailed || (op.Status == modelwebsite.OpStatusRunning && op.LeaseExpiresAt != nil && op.LeaseExpiresAt.Before(now))
		if !staleCleanup || !retryableState || candidate != nil {
			return nil, nil
		}
		candidate = &operations[i]
	}
	if candidate == nil {
		return nil, nil
	}
	found, active := false, false
	seen := map[string]bool{}
	for _, r := range releases {
		if r.UserID != site.UserID || r.SiteID != site.SiteID || r.ReleaseID == "" || seen[r.ReleaseID] {
			return nil, fmt.Errorf("invalid recovery snapshot")
		}
		seen[r.ReleaseID] = true
		if r.ReleaseID == site.ActiveReleaseID {
			active = r.Status == modelwebsite.ReleaseStatusActive
		}
		if r.ReleaseID == candidate.ReleaseID {
			found = r.Status == "pruning" && r.ReleaseID != site.ActiveReleaseID
		}
		if r.ReleaseID != candidate.ReleaseID && r.ReleaseID != site.ActiveReleaseID && r.Status != modelwebsite.ReleaseStatusSuperseded && r.Status != modelwebsite.ReleaseStatusFailed && r.Status != "pruned" {
			return nil, fmt.Errorf("unsettled recovery snapshot")
		}
	}
	if !found || !active {
		return nil, fmt.Errorf("recovery target or active pointer invalid")
	}
	generation := site.OperationGeneration + 1
	if err := tx.Model(&site).Update("operation_generation", generation).Error; err != nil {
		return nil, err
	}
	result := tx.Model(&modelwebsite.OperationEntity{}).Where("operation_id = ? AND status = ? AND lease_token = ? AND site_generation = ?", candidate.OperationID, candidate.Status, candidate.LeaseToken, candidate.SiteGeneration).Updates(map[string]interface{}{
		"status": modelwebsite.OpStatusCreated, "site_generation": generation, "lease_token": "", "lease_expires_at": nil, "next_retry_at": nil, "attempt": 0, "error_message": "",
	})
	if result.Error != nil {
		return nil, result.Error
	}
	if result.RowsAffected != 1 {
		return nil, fmt.Errorf("cleanup changed during recovery")
	}
	candidate.Status = modelwebsite.OpStatusCreated
	candidate.SiteGeneration = generation
	candidate.LeaseToken = ""
	candidate.LeaseExpiresAt = nil
	candidate.NextRetryAt = nil
	candidate.Attempt = 0
	candidate.ErrorMessage = ""
	return candidate, nil
}

// RetentionSweepResult uses a stable site-ID cursor, not an offset that can skip
// rows when sites are created/deleted during a sweep. One call scans at most 20.
type RetentionSweepResult struct {
	NextCursor string `json:"next_cursor"`
	Scanned    int    `json:"scanned"`
	Scheduled  int    `json:"scheduled"`
	Deferred   int    `json:"deferred"`
}

func (l *logic) SweepReleaseRetention(cursor string) (*RetentionSweepResult, error) {
	if _, _, err := releaseRetentionPolicy(); err != nil {
		return nil, err
	}
	if len(cursor) > 128 {
		return nil, errcode.ErrWebsiteInvalidParam
	}
	var sites []modelwebsite.SiteEntity
	if err := resource.GormDB.Where("site_id > ? AND kind = ? AND status = ?", cursor, "fullstack", modelwebsite.SiteStatusActive).Order("site_id ASC").Limit(20).Find(&sites).Error; err != nil {
		return nil, err
	}
	result := &RetentionSweepResult{Scanned: len(sites)}
	for _, site := range sites {
		if !backendEnabledFor(site.UserID) {
			continue
		}
		op, err := l.ScheduleReleaseRetention(site.SiteID)
		if err != nil {
			result.Deferred++
			l.logger.Warn("website retention deferred", zap.String("site_id", site.SiteID))
			continue
		}
		if op != nil {
			result.Scheduled++
		}
	}
	if len(sites) == 20 {
		result.NextCursor = sites[len(sites)-1].SiteID
	}
	return result, nil
}

// Called only after the complete snapshot passed planReleaseRetention. Failed
// revisions do not consume the rollback window. Require an explicit terminal
// failed deploy record and elapsed grace; unknown disk directories are NOT garbage.
func failedArtifactCandidates(site modelwebsite.SiteEntity, releases []modelwebsite.ReleaseEntity, operations []modelwebsite.OperationEntity, now time.Time, grace time.Duration) []string {
	failed := map[string]bool{}
	for _, op := range operations {
		if op.OperationType == modelwebsite.OpTypeDeploy && op.Status == modelwebsite.OpStatusFailed {
			failed[op.ReleaseID] = true
		}
	}
	var candidates []string
	for _, r := range releases {
		if r.Status == modelwebsite.ReleaseStatusFailed && r.ReleaseID != site.ActiveReleaseID && failed[r.ReleaseID] && r.UpdatedTime != nil && !r.UpdatedTime.After(now.Add(-grace)) {
			candidates = append(candidates, r.ReleaseID)
		}
	}
	sort.Strings(candidates)
	return candidates
}
