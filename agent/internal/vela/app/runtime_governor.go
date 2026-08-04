package app

import (
	"context"
	"time"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeapi"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/daemon"
)

type governedResolver struct {
	next     runtimeapi.RuntimeResolver
	governor *daemon.LaunchGovernor
	timeout  time.Duration
}

func (r *governedResolver) ResolveRuntime(id string) (runtimeapi.ResolvedRuntime, bool) {
	resolved, ok := r.next.ResolveRuntime(id)
	if !ok || resolved.NewDriver == nil {
		return runtimeapi.ResolvedRuntime{}, false
	}
	nextFactory := resolved.NewDriver
	resolved.NewDriver = func() (runtimeapi.RuntimeDriver, error) {
		driver, err := nextFactory()
		if err != nil {
			return nil, err
		}
		return &governedDriver{
			next:     driver,
			governor: r.governor,
			timeout:  r.timeout,
		}, nil
	}
	return resolved, true
}

type governedDriver struct {
	next     runtimeapi.RuntimeDriver
	governor *daemon.LaunchGovernor
	timeout  time.Duration
}

func (d *governedDriver) Probe(ctx context.Context) (runtimeapi.ProbeResult, error) {
	return d.next.Probe(ctx)
}

func (d *governedDriver) DetectModels(ctx context.Context) (runtimeapi.ModelResult, error) {
	return d.next.DetectModels(ctx)
}

func (d *governedDriver) Start(
	ctx context.Context,
	request runtimeapi.StartRequest,
) (runtimeapi.RuntimeSession, error) {
	timeout := d.timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	startContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	permit, err := d.governor.Acquire(
		startContext,
		daemon.LaunchRuntime,
		daemon.LaunchIdentity{
			AgentID:  request.AgentID,
			LaunchID: request.LaunchID,
		},
	)
	if err != nil {
		return nil, err
	}
	defer permit.Release()
	return d.next.Start(startContext, request)
}
