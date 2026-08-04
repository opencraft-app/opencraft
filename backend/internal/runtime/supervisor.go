package runtime

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"
)

var (
	ErrDatabaseRequired     = errors.New("Supervisor Database 不能为空")
	ErrComponentRequired    = errors.New("Supervisor 角色组件不完整")
	ErrDrainTimeoutInvalid  = errors.New("Supervisor drain timeout 无效")
	ErrSupervisorStarted    = errors.New("Supervisor 已启动")
	ErrSupervisorNotStarted = errors.New("Supervisor 尚未启动")
)

// Database 是 Supervisor 对共享数据库 Handle 的唯一要求。
type Database interface {
	Close() error
}

// Component 是可停止 intake、可 drain 的后台角色。
type Component interface {
	Role() Role
	Run(context.Context, Database) error
	StopIntake()
	Drain(context.Context) error
}

// SupervisorConfig 定义进程角色和共同 drain 上限。
type SupervisorConfig struct {
	Mode         DatabaseMode
	Roles        RoleSet
	DrainTimeout time.Duration
}

// Supervisor 让所有角色共享一个 Database，并确定性关闭。
type Supervisor struct {
	config     SupervisorConfig
	database   Database
	components []Component

	mu        sync.Mutex
	started   bool
	stopped   bool
	runCancel context.CancelFunc
	runWG     sync.WaitGroup
	runErrs   []error

	ready atomic.Bool

	shutdownOnce sync.Once
	shutdownDone chan struct{}
	shutdownErr  error
}

// NewSupervisor 创建角色 Supervisor。
func NewSupervisor(
	config SupervisorConfig,
	database Database,
	components []Component,
) (*Supervisor, error) {
	if err := config.Roles.Validate(config.Mode); err != nil {
		return nil, err
	}
	if config.DrainTimeout <= 0 {
		return nil, ErrDrainTimeoutInvalid
	}
	if database == nil {
		return nil, ErrDatabaseRequired
	}
	if len(components) != config.Roles.Len() {
		return nil, ErrComponentRequired
	}

	seen := make(map[Role]struct{}, len(components))
	copied := make([]Component, 0, len(components))
	for _, component := range components {
		if component == nil ||
			!config.Roles.Has(component.Role()) {
			return nil, ErrComponentRequired
		}
		if _, exists := seen[component.Role()]; exists {
			return nil, ErrComponentRequired
		}
		seen[component.Role()] = struct{}{}
		copied = append(copied, component)
	}

	return &Supervisor{
		config:       config,
		database:     database,
		components:   copied,
		shutdownDone: make(chan struct{}),
	}, nil
}

// Start 启动所有角色。同一 Supervisor 只能启动一次。
func (supervisor *Supervisor) Start(parent context.Context) error {
	if supervisor == nil {
		return ErrComponentRequired
	}
	if parent == nil {
		parent = context.Background()
	}
	if err := parent.Err(); err != nil {
		return err
	}

	supervisor.mu.Lock()
	if supervisor.started || supervisor.stopped {
		supervisor.mu.Unlock()
		return ErrSupervisorStarted
	}
	runContext, cancel := context.WithCancel(parent)
	supervisor.started = true
	supervisor.runCancel = cancel
	supervisor.mu.Unlock()

	for _, component := range supervisor.components {
		component := component
		supervisor.runWG.Add(1)
		go func() {
			defer supervisor.runWG.Done()
			err := component.Run(runContext, supervisor.database)
			if err != nil && !errors.Is(err, context.Canceled) {
				supervisor.mu.Lock()
				supervisor.runErrs = append(supervisor.runErrs, err)
				supervisor.mu.Unlock()
			}
			if runContext.Err() == nil {
				supervisor.ready.Store(false)
			}
		}()
	}
	supervisor.ready.Store(true)
	return nil
}

// Ready 报告进程是否仍接受新工作。
func (supervisor *Supervisor) Ready() bool {
	return supervisor != nil && supervisor.ready.Load()
}

// Shutdown 停止 intake、并行 drain、cancel/join，最后关闭共享数据库。
func (supervisor *Supervisor) Shutdown(ctx context.Context) error {
	if supervisor == nil {
		return nil
	}
	supervisor.shutdownOnce.Do(func() {
		supervisor.shutdownErr = supervisor.shutdown(ctx)
		close(supervisor.shutdownDone)
	})
	<-supervisor.shutdownDone
	return supervisor.shutdownErr
}

func (supervisor *Supervisor) shutdown(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	supervisor.mu.Lock()
	if !supervisor.started {
		supervisor.mu.Unlock()
		return ErrSupervisorNotStarted
	}
	supervisor.stopped = true
	cancelRun := supervisor.runCancel
	supervisor.mu.Unlock()

	supervisor.ready.Store(false)
	for _, component := range supervisor.components {
		component.StopIntake()
	}

	drainContext, cancelDrain := context.WithTimeout(
		ctx,
		supervisor.config.DrainTimeout,
	)
	defer cancelDrain()
	var drainWG sync.WaitGroup
	var drainMu sync.Mutex
	var drainErrs []error
	for _, component := range supervisor.components {
		component := component
		drainWG.Add(1)
		go func() {
			defer drainWG.Done()
			if err := component.Drain(drainContext); err != nil {
				drainMu.Lock()
				drainErrs = append(drainErrs, err)
				drainMu.Unlock()
			}
		}()
	}
	drainDone := make(chan struct{})
	go func() {
		drainWG.Wait()
		close(drainDone)
	}()

	var drainDeadlineErr error
	select {
	case <-drainDone:
	case <-drainContext.Done():
		drainDeadlineErr = drainContext.Err()
	}

	cancelRun()
	joinDone := make(chan struct{})
	go func() {
		drainWG.Wait()
		supervisor.runWG.Wait()
		close(joinDone)
	}()
	joinContext, cancelJoin := context.WithTimeout(
		context.Background(),
		supervisor.config.DrainTimeout,
	)
	defer cancelJoin()
	select {
	case <-joinDone:
	case <-joinContext.Done():
		return errors.Join(drainDeadlineErr, joinContext.Err())
	}

	supervisor.mu.Lock()
	runErrs := append([]error(nil), supervisor.runErrs...)
	supervisor.mu.Unlock()
	closeErr := supervisor.database.Close()
	return errors.Join(
		drainDeadlineErr,
		errors.Join(drainErrs...),
		errors.Join(runErrs...),
		closeErr,
	)
}
