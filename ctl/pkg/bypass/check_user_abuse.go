package bypass

import (
	"time"

	"ctl/pkg/config"
	pctx "ctl/pkg/context"
	instancelogic "ctl/pkg/instance"

	"go.uber.org/zap"
)

const (
	bypassCheckUserAbuse      = "checkUserAbuse"
	checkUserAbuseLockSeconds = 60
)

func init() {
	registerBypass(bypassCheckUserAbuse, newCheckUserAbuse)
}

type checkUserAbuse struct {
	*baseBypass
}

func newCheckUserAbuse() Bypass {
	c := &checkUserAbuse{
		baseBypass: newBaseBypass(bypassCheckUserAbuse, checkUserAbuseLockSeconds),
	}
	c.intervalFunc = c.interval
	c.runFunc = c.run
	return c
}

func (c *checkUserAbuse) interval(_ pctx.Context) time.Duration {
	if config.ServerConf.APIConfig == nil || config.ServerConf.APIConfig.Instance == nil {
		return 10 * time.Second
	}
	return time.Duration(config.ServerConf.APIConfig.Instance.UserAbuseRefreshSeconds) * time.Second
}

func (c *checkUserAbuse) run(ctx pctx.Context) {
	activeCount, err := instancelogic.RefreshUserAbuseCooldownMetrics(ctx)
	if err != nil {
		ctx.Logger().Error("refresh user abuse cooldown metrics failed", zap.Error(err))
		return
	}
	if activeCount > 0 {
		ctx.Logger().Info("user abuse cooldown metrics refreshed",
			zap.Int64("active_cooldowns", activeCount),
		)
	}
}
