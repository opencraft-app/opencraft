package bypass

import (
	"time"

	adapterfactory "ctl/pkg/adapter/factory"
	"ctl/pkg/config"
	pctx "ctl/pkg/context"
	instancelogic "ctl/pkg/instance"

	"go.uber.org/zap"
)

const (
	bypassCheckPoolPressure      = "checkPoolPressure"
	checkPoolPressureLockSeconds = 60
)

func init() {
	registerBypass(bypassCheckPoolPressure, newCheckPoolPressure)
}

type checkPoolPressure struct {
	*baseBypass
}

func newCheckPoolPressure() Bypass {
	c := &checkPoolPressure{
		baseBypass: newBaseBypass(bypassCheckPoolPressure, checkPoolPressureLockSeconds),
	}
	c.intervalFunc = c.interval
	c.runFunc = c.run
	return c
}

func (c *checkPoolPressure) interval(_ pctx.Context) time.Duration {
	if config.ServerConf.APIConfig == nil || config.ServerConf.APIConfig.Instance == nil {
		return 5 * time.Second
	}
	return time.Duration(config.ServerConf.APIConfig.Instance.PressureRefreshSec) * time.Second
}

func (c *checkPoolPressure) run(ctx pctx.Context) {
	snapshot, err := instancelogic.RefreshPoolPressureSnapshot(ctx, adapterfactory.DefaultAdapterFactory.SandboxAdapter())
	if err != nil {
		ctx.Logger().Error("refresh pool pressure snapshot failed", zap.Error(err))
		return
	}
	if snapshot == nil {
		return
	}
	ctx.Logger().Info("pool pressure snapshot refreshed",
		zap.String("state", snapshot.State),
		zap.Strings("candidate_pools", snapshot.Candidate),
	)
}
