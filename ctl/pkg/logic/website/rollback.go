package website

import (
	"fmt"

	"ctl/pkg/errcode"
	"ctl/pkg/model/website"
	"ctl/pkg/resource"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type RollbackReleaseResult struct {
	OperationID string `json:"operation_id"`
}

// Rollback is a fenced operation, not an immediate pointer update. The worker
// must prove retained static files and (when present) backend revision exist.
func (l *logic) RollbackRelease(userID, siteID, releaseID string) (*RollbackReleaseResult, error) {
	site, err := l.siteDao.GetBySiteID(siteID)
	if err != nil {
		return nil, err
	}
	if site == nil || site.UserID != userID {
		return nil, errcode.ErrWebsiteNotFound
	}
	if site.Status != website.SiteStatusActive {
		return nil, errcode.ErrWebsiteNotActive
	}
	if _, err := l.getActivePass(userID); err != nil {
		return nil, err
	}
	operationID, err := l.generateID("website_operation", "wo")
	if err != nil {
		return nil, err
	}
	err = resource.GormDB.Transaction(func(tx *gorm.DB) error {
		var locked website.SiteEntity
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("site_id = ? AND user_id = ?", siteID, userID).First(&locked).Error; err != nil {
			return err
		}
		if locked.Status != website.SiteStatusActive {
			return errcode.ErrWebsiteNotActive
		}
		var target website.ReleaseEntity
		if err := tx.Where("release_id = ? AND site_id = ? AND user_id = ?", releaseID, siteID, userID).First(&target).Error; err != nil {
			return errcode.ErrWebsiteReleaseNotFound
		}
		if target.Status != website.ReleaseStatusSuperseded && target.Status != website.ReleaseStatusActive {
			return errcode.ErrWebsiteInvalidParam
		}
		if target.Kind == "fullstack" && !backendEnabledFor(userID) {
			return errcode.ErrWebsiteBackendUnavailable
		}
		var pending int64
		if err := tx.Table(website.OperationsTable).Where("site_id = ? AND status IN ?", siteID, []string{website.OpStatusCreated, website.OpStatusRunning}).Count(&pending).Error; err != nil {
			return err
		}
		if pending > 0 {
			return errcode.ErrWebsiteReleaseInProgress
		}
		locked.OperationGeneration++
		if err := tx.Model(&locked).Update("operation_generation", locked.OperationGeneration).Error; err != nil {
			return err
		}
		operation := website.OperationEntity{OperationID: operationID, SiteID: siteID, ReleaseID: releaseID, OperationType: "rollback", Status: website.OpStatusCreated, SiteGeneration: locked.OperationGeneration}
		operation.UserID = userID
		if err := tx.Create(&operation).Error; err != nil {
			return fmt.Errorf("create rollback operation: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	// Existing worker polling is the durable fallback; no ephemeral queue is
	// required for correctness of this operation.
	return &RollbackReleaseResult{OperationID: operationID}, nil
}
