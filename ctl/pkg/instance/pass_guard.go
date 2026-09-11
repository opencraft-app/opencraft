package instance

import (
	"fmt"
	"strings"

	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	modelpass "ctl/pkg/model/pass"
)

type userPassLister interface {
	ListByUserID(userID string) ([]*modelpass.Entity, error)
}

func (l *logic) requireActivePass(ctx pctx.Context) error {
	// Focused unit-test logic instances may omit infrastructure dependencies.
	// NewLogic always injects the production pass DAO.
	if l.passLister == nil {
		return nil
	}
	if ctx == nil || strings.TrimSpace(ctx.GetUserID()) == "" {
		return errcode.ErrInstanceMissingUserID
	}

	passes, err := l.passLister.ListByUserID(ctx.GetUserID())
	if err != nil {
		return errcode.Wrap(errcode.ErrInternalServer, "check active pass: %v", err)
	}
	seen := make(map[string]bool, len(passes))
	for _, pass := range passes {
		if pass != nil {
			seen[pass.Status] = true
		}
	}
	for _, state := range []struct {
		status string
		err    error
	}{
		{modelpass.StatusIsolating, errcode.ErrPassIsolating},
		{modelpass.StatusRenewing, errcode.ErrPassRenewing},
		{modelpass.StatusDeleting, errcode.ErrPassDeleting},
		{modelpass.StatusTerminating, errcode.ErrPassTerminating},
		// 变配期间底层机器规格正在改，放行新建会让用户拿到源规格池的实例。
		{modelpass.StatusModifying, errcode.ErrPassModifying},
		{modelpass.StatusIsolated, errcode.ErrPassIsolated},
	} {
		if seen[state.status] {
			return state.err
		}
	}
	if !seen[modelpass.StatusActive] {
		return errcode.ErrInstanceNoActivePass
	}
	return nil
}

func (l *logic) instanceBotQuota(ctx pctx.Context) (int64, error) {
	// Focused unit-test logic instances may omit infrastructure dependencies.
	// NewLogic always injects both production DAOs.
	if l.passLister == nil || l.bundleDao == nil {
		return 0, nil
	}
	if ctx == nil || strings.TrimSpace(ctx.GetUserID()) == "" {
		return 0, errcode.ErrInstanceMissingUserID
	}

	passes, err := l.passLister.ListByUserID(ctx.GetUserID())
	if err != nil {
		return 0, errcode.Wrap(errcode.ErrInternalServer, "resolve instance bot quota: list passes: %v", err)
	}

	var quota int64
	for _, pass := range passes {
		if pass == nil || pass.Status != modelpass.StatusActive {
			continue
		}
		bundle, getErr := l.bundleDao.GetByBundleID(pass.BundleID)
		if getErr != nil {
			return 0, errcode.Wrap(errcode.ErrInternalServer, "resolve instance bot quota: get bundle %s: %v", pass.BundleID, getErr)
		}
		candidate := bundle.BotQuotaPerAgent
		if candidate < 1 {
			candidate = 1
		}
		if candidate > quota {
			quota = candidate
		}
	}
	if quota == 0 {
		return 0, errcode.ErrInstanceNoActivePass
	}
	return quota, nil
}

func activePassGuardError(operation string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s requires active pass: %w", operation, err)
}
