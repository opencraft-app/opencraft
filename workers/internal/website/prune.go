package website

import (
	"context"
	"fmt"
	"time"
)

// validatePruneSnapshot requires the durable, non-rollbackable reservation. Never
// infer deletion authorization from object age, a queued message, or a stale plan.
func validatePruneSnapshot(request, current Operation) error {
	if request.OperationID == "" || request.LeaseToken == "" || current.OperationID != request.OperationID || current.LeaseToken != request.LeaseToken || current.SiteID != request.SiteID || current.ReleaseID != request.ReleaseID || current.UserID != request.UserID || current.UserID == "" {
		return fmt.Errorf("prune identity or lease changed")
	}
	if current.OperationType != "prune_release" || current.Status != "running" || current.ReleaseStatus != "pruning" || current.LeaseExpiresAt == nil || !current.LeaseExpiresAt.After(time.Now()) || current.SiteGeneration <= 0 || current.SiteGeneration != current.CurrentSiteGeneration {
		return fmt.Errorf("prune reservation is not current")
	}
	// Validate path segments before constructing a COS prefix, including site ID.
	if !isDirectChildPrefix("sites/", "sites/"+current.SiteID+"/") || !isDirectChildPrefix("releases/", "releases/"+current.ReleaseID+"/") || current.ActiveReleaseID == "" || current.ActiveReleaseID == current.ReleaseID || current.ActiveCloudPath != siteReleasePrefix(current.SiteID, current.ActiveReleaseID) {
		return fmt.Errorf("prune target or active pointer invalid")
	}
	// Pre-fullstack static releases persist an empty kind.
	if current.Kind != "" && current.Kind != "static" && current.Kind != "fullstack" {
		return fmt.Errorf("unknown release kind")
	}
	return nil
}

func (d *Deployer) executePruneRelease(op Operation) error {
	if d.siteCos == nil {
		return fmt.Errorf("prune storage unavailable")
	}
	check := func() (*Operation, error) {
		current, err := d.GetOperation(op.OperationID)
		if err != nil {
			return nil, err
		}
		if current == nil {
			return nil, fmt.Errorf("prune operation absent")
		}
		if err := validatePruneSnapshot(op, *current); err != nil {
			return nil, err
		}
		return current, nil
	}
	current, err := check()
	if err != nil {
		return err
	}
	// A partially deleted target remains pruning: it can never be rolled back to.
	// Both deletions are exact-revision and idempotent; retry after lost completion
	// is safe. Do not fail an operation using a stale worker's lease.
	if current.Kind == "fullstack" {
		if err := d.deleteBackend(*current); err != nil {
			return d.failOperation(op, "prune backend unavailable")
		}
	}
	if _, err := check(); err != nil {
		return err
	}
	if err := d.deleteCosPrefix(d.siteCos, siteReleasePrefix(op.SiteID, op.ReleaseID), op); err != nil {
		return d.failOperation(op, "prune static revision failed")
	}
	if _, err := check(); err != nil {
		return err
	}
	// Failed publishes can leave their private upload ZIP behind. Remove only
	// this revision's exact key; never delete a site's entire artifact prefix.
	if _, err := d.siteCos.client.Object.Delete(context.Background(), siteArtifactKey(op.SiteID, op.ReleaseID)); err != nil {
		return d.failOperation(op, "prune temporary artifact failed")
	}
	if _, err := check(); err != nil {
		return err
	}
	return d.completeOperation(op, "", "")
}
