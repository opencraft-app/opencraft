package runtimeactor

import (
	"context"
	"sync"
	"time"
)

type StartJob struct {
	AgentID string
	Token   uint64
}

type StartCoordinator interface {
	Execute(context.Context, StartJob, func(context.Context) error) error
	Close(context.Context) error
}

type startRequest struct {
	ctx      context.Context
	job      StartJob
	callback func(context.Context) error
	result   chan error
}

type QueuedCoordinator struct {
	interval time.Duration
	sleep    SleepFunc
	queue    chan startRequest
	slots    chan struct{}
	ctx      context.Context
	cancel   context.CancelFunc
	done     chan struct{}
	work     sync.WaitGroup
	once     sync.Once
}

func NewQueuedCoordinator(
	maxConcurrent int,
	interval time.Duration,
	sleep SleepFunc,
) *QueuedCoordinator {
	if maxConcurrent <= 0 {
		maxConcurrent = 5
	}
	if interval <= 0 {
		interval = 500 * time.Millisecond
	}
	if sleep == nil {
		sleep = sleepContext
	}
	ctx, cancel := context.WithCancel(context.Background())
	coordinator := &QueuedCoordinator{
		interval: interval,
		sleep:    sleep,
		queue:    make(chan startRequest, 128),
		slots:    make(chan struct{}, maxConcurrent),
		ctx:      ctx,
		cancel:   cancel,
		done:     make(chan struct{}),
	}
	go coordinator.run()
	return coordinator
}

func (c *QueuedCoordinator) Execute(
	ctx context.Context,
	job StartJob,
	callback func(context.Context) error,
) error {
	if c == nil || ctx == nil || callback == nil {
		return ErrManagerClosed
	}
	request := startRequest{
		ctx:      ctx,
		job:      job,
		callback: callback,
		result:   make(chan error, 1),
	}
	select {
	case c.queue <- request:
	case <-c.ctx.Done():
		return ErrManagerClosed
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case err := <-request.result:
		return err
	case <-c.ctx.Done():
		return ErrManagerClosed
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *QueuedCoordinator) Close(ctx context.Context) error {
	if c == nil {
		return nil
	}
	if ctx == nil {
		return ErrManagerClosed
	}
	c.once.Do(c.cancel)
	select {
	case <-c.done:
	case <-ctx.Done():
		return ctx.Err()
	}
	waited := make(chan struct{})
	go func() {
		c.work.Wait()
		close(waited)
	}()
	select {
	case <-waited:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *QueuedCoordinator) run() {
	defer close(c.done)
	first := true
	for {
		var request startRequest
		select {
		case <-c.ctx.Done():
			return
		case request = <-c.queue:
		}
		if !first {
			sleepCtx, cancel := context.WithCancel(request.ctx)
			stop := context.AfterFunc(c.ctx, cancel)
			err := c.sleep(sleepCtx, c.interval)
			stop()
			cancel()
			if err != nil {
				c.complete(request, err)
				continue
			}
		}
		first = false
		select {
		case c.slots <- struct{}{}:
			c.work.Add(1)
			go c.execute(request)
		case <-c.ctx.Done():
			c.complete(request, ErrManagerClosed)
		case <-request.ctx.Done():
			c.complete(request, request.ctx.Err())
		}
	}
}

func (c *QueuedCoordinator) execute(request startRequest) {
	defer c.work.Done()
	defer func() { <-c.slots }()
	ctx, cancel := context.WithCancel(request.ctx)
	stop := context.AfterFunc(c.ctx, cancel)
	err := request.callback(ctx)
	stop()
	cancel()
	c.complete(request, err)
}

func (c *QueuedCoordinator) complete(request startRequest, err error) {
	select {
	case request.result <- err:
	default:
	}
}

type directCoordinator struct {
	ctx    context.Context
	cancel context.CancelFunc
	work   sync.WaitGroup
	once   sync.Once
	mu     sync.Mutex
	closed bool
}

func newDirectCoordinator() *directCoordinator {
	ctx, cancel := context.WithCancel(context.Background())
	return &directCoordinator{ctx: ctx, cancel: cancel}
}

func (c *directCoordinator) Execute(
	ctx context.Context,
	_ StartJob,
	callback func(context.Context) error,
) error {
	if c == nil || ctx == nil || callback == nil {
		return ErrManagerClosed
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return ErrManagerClosed
	}
	c.work.Add(1)
	c.mu.Unlock()
	defer c.work.Done()
	callCtx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(c.ctx, cancel)
	defer func() {
		stop()
		cancel()
	}()
	return callback(callCtx)
}

func (c *directCoordinator) Close(ctx context.Context) error {
	if c == nil {
		return nil
	}
	if ctx == nil {
		return ErrManagerClosed
	}
	c.once.Do(func() {
		c.mu.Lock()
		c.closed = true
		c.cancel()
		c.mu.Unlock()
	})
	waited := make(chan struct{})
	go func() {
		c.work.Wait()
		close(waited)
	}()
	select {
	case <-waited:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
