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

func activePassGuardError(operation string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s requires active pass: %w", operation, err)
}
