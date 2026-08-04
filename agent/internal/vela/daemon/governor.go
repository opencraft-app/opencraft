package daemon

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/binary"
	"errors"
	"strings"
	"sync"
	"time"
)

var (
	ErrInvalidLaunchRequest = errors.New("Vela 启动许可请求无效")
	ErrLaunchGovernorClosed = errors.New("Vela 启动许可服务已关闭")
)

type LaunchKind string

const (
	LaunchAgentHost LaunchKind = "agent_host"
	LaunchRuntime   LaunchKind = "runtime"
)

type LaunchIdentity struct {
	AgentID  string
	LaunchID string
}

type Permit interface {
	Release()
}

type LaunchGovernorConfig struct {
	MinimumInterval time.Duration
	Now             func() time.Time
	Sleep           func(context.Context, time.Duration) error
	Jitter          func() time.Duration
}

type LaunchGovernor struct {
	minimumInterval time.Duration
	now             func() time.Time
	sleep           func(context.Context, time.Duration) error
	jitter          func() time.Duration
	slot            chan struct{}
	closed          chan struct{}
	closeOnce       sync.Once

	paceMu    sync.Mutex
	started   bool
	lastStart time.Time
}

func NewLaunchGovernor(
	config LaunchGovernorConfig,
) (*LaunchGovernor, error) {
	if config.MinimumInterval < 0 {
		return nil, ErrInvalidLaunchRequest
	}
	if config.MinimumInterval == 0 {
		config.MinimumInterval = 500 * time.Millisecond
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.Sleep == nil {
		config.Sleep = sleepLaunchContext
	}
	if config.Jitter == nil {
		config.Jitter = defaultLaunchJitter
	}
	return &LaunchGovernor{
		minimumInterval: config.MinimumInterval,
		now:             config.Now,
		sleep:           config.Sleep,
		jitter:          config.Jitter,
		slot:            make(chan struct{}, 1),
		closed:          make(chan struct{}),
	}, nil
}

func (g *LaunchGovernor) Acquire(
	ctx context.Context,
	kind LaunchKind,
	identity LaunchIdentity,
) (Permit, error) {
	if g == nil || ctx == nil ||
		(kind != LaunchAgentHost && kind != LaunchRuntime) ||
		strings.TrimSpace(identity.AgentID) == "" ||
		strings.TrimSpace(identity.LaunchID) == "" {
		return nil, ErrInvalidLaunchRequest
	}
	select {
	case <-g.closed:
		return nil, ErrLaunchGovernorClosed
	default:
	}
	select {
	case g.slot <- struct{}{}:
	case <-g.closed:
		return nil, ErrLaunchGovernorClosed
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	permit := &launchPermit{release: func() { <-g.slot }}
	select {
	case <-g.closed:
		permit.Release()
		return nil, ErrLaunchGovernorClosed
	default:
	}

	g.paceMu.Lock()
	delay := g.nextDelay()
	if delay > 0 {
		if err := g.sleep(ctx, delay); err != nil {
			g.paceMu.Unlock()
			permit.Release()
			return nil, err
		}
	}
	g.lastStart = g.now()
	g.started = true
	g.paceMu.Unlock()
	return permit, nil
}

func (g *LaunchGovernor) nextDelay() time.Duration {
	if !g.started {
		return nonNegativeDuration(g.jitter())
	}
	delay := g.minimumInterval - g.now().Sub(g.lastStart)
	if jitter := nonNegativeDuration(g.jitter()); jitter > delay {
		delay = jitter
	}
	return nonNegativeDuration(delay)
}

func (g *LaunchGovernor) Close() {
	if g == nil {
		return
	}
	g.closeOnce.Do(func() { close(g.closed) })
}

type launchPermit struct {
	once    sync.Once
	release func()
}

func (p *launchPermit) Release() {
	if p == nil {
		return
	}
	p.once.Do(p.release)
}

func nonNegativeDuration(value time.Duration) time.Duration {
	if value < 0 {
		return 0
	}
	return value
}

func sleepLaunchContext(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func defaultLaunchJitter() time.Duration {
	var value [8]byte
	if _, err := cryptorand.Read(value[:]); err != nil {
		return 0
	}
	const window = uint64(500 * time.Millisecond)
	return time.Duration(binary.LittleEndian.Uint64(value[:]) % (window + 1))
}
