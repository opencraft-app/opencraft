package instance

import (
	"errors"
	"fmt"
	"strings"
	"time"

	psandbox "ctl/pkg/adapter/sandbox"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	modelinstance "ctl/pkg/model/instance"
	"ctl/pkg/taskruntime/common"

	"go.uber.org/zap"
)

var ErrResumeTaskPermanent = errors.New("resume task no longer applicable")

func (l *logic) RunResumeInstanceTask(ctx pctx.Context, payload *common.ResumeInstanceTaskPayload) error {
	if payload == nil || payload.InstanceID == "" || !isValidInstanceTimeout(payload.Timeout) {
		return fmt.Errorf("%w: invalid resume payload", ErrResumeTaskPermanent)
	}
	entity, err := l.instanceDao.GetByInstanceID(ctx, payload.InstanceID)
	if err != nil {
		if errors.Is(err, errcode.ErrInstanceNotFound) {
			return fmt.Errorf("%w: instance not found", ErrResumeTaskPermanent)
		}
		return err
	}
	if entity.Status == modelinstance.InstanceStatusRunning {
		return nil
	}
	if entity.Status != modelinstance.InstanceStatusResuming {
		return fmt.Errorf("%w: instance status %s", ErrResumeTaskPermanent, entity.Status)
	}
	if err := l.requireActivePass(ctx); err != nil {
		if isInactivePassError(err) {
			return l.compensateInactiveResume(ctx, entity, err)
		}
		return activePassGuardError("resume instance", err)
	}
	if err := l.resumeSandbox(ctx, entity, &psandbox.ResumeSandboxRequest{Timeout: &payload.Timeout}); err != nil {
		return err
	}
	if err := l.requireActivePass(ctx); err != nil {
		if !isInactivePassError(err) {
			return activePassGuardError("resume instance", err)
		}
		return l.compensateInactiveResume(ctx, entity, err)
	}
	timeoutAt := time.Now().UTC().Add(time.Duration(payload.Timeout) * time.Second)
	if err := l.instanceDao.UpdateWithStatusPrecondition(ctx, entity.Id,
		[]string{modelinstance.InstanceStatusResuming},
		map[string]interface{}{
			modelinstance.ColumnStatus:    modelinstance.InstanceStatusRunning,
			modelinstance.ColumnTimeoutAt: timeoutAt,
		}); err != nil {
		l.logger.Warn("persist running state after async resume failed; will retry",
			zap.Error(err), zap.String("instance_id", entity.InstanceId))
		return err
	}
	return nil
}

func (l *logic) compensateInactiveResume(ctx pctx.Context, entity *modelinstance.Entity, passErr error) error {
	sandbox, err := l.sandboxAdapter.GetSandbox(ctx, entity.SandboxId)
	if err != nil {
		return err
	}
	switch strings.ToLower(strings.TrimSpace(sandbox.State)) {
	case "paused":
	case "running":
		if err := l.sandboxAdapter.PauseSandbox(ctx, entity.SandboxId); err != nil {
			return errcode.Wrap(errcode.ErrSandboxServiceError, "compensating pause after pass check: %v", err)
		}
	default:
		// GET reconciles RESUMING when CVM reaches RUNNING. Retry instead of
		// issuing Pause while Sandbox still rejects the transition.
		return fmt.Errorf("wait to compensate resume: sandbox state %s", sandbox.State)
	}
	if err := l.instanceDao.TransitionStatus(ctx, entity.Id,
		[]string{modelinstance.InstanceStatusResuming}, modelinstance.InstanceStatusPaused); err != nil {
		return err
	}
	return fmt.Errorf("%w: %v", ErrResumeTaskPermanent, activePassGuardError("resume instance", passErr))
}

func isInactivePassError(err error) bool {
	for _, target := range []error{
		errcode.ErrPassIsolating, errcode.ErrPassRenewing, errcode.ErrPassDeleting,
		errcode.ErrPassTerminating, errcode.ErrPassModifying, errcode.ErrPassIsolated,
		errcode.ErrInstanceNoActivePass,
	} {
		if errors.Is(err, target) {
			return true
		}
	}
	return false
}
