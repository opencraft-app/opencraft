package hermes

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/filelock"
)

var ErrManagedProfileRuntimeBusy = errors.New(
	"Hermes managed Profile is already active",
)

// ManagedHost is protocol-neutral launch metadata for one Computer-managed
// Hermes Profile. It intentionally contains no configuration or credentials.
type ManagedHost struct {
	Executable  string
	ArgsPrefix  []string
	TrustedHome string
	ProfileName string
	ProfileHome string
	ProfileArgs []string
}

func (driver *Driver) PrepareManagedHost(
	ctx context.Context,
	agentID string,
) (ManagedHost, error) {
	candidate, err := driver.selectExecutable(ctx)
	if err != nil {
		return ManagedHost{}, err
	}
	if driver.homeErr != nil {
		return ManagedHost{}, fmt.Errorf(
			"resolve trusted Hermes OS-user home: %w",
			driver.homeErr,
		)
	}
	provisioner, err := newNativeProfileProvisioner(
		profileProvisionerOptions{
			TrustedHome: driver.trustedHome,
			Candidate:   candidate,
		},
	)
	if err != nil {
		return ManagedHost{}, err
	}
	profile, err := provisioner.Ensure(ctx, agentID)
	if err != nil {
		return ManagedHost{}, fmt.Errorf("provision Hermes Profile: %w", err)
	}
	return ManagedHost{
		Executable:  candidate.Path,
		ArgsPrefix:  append([]string(nil), candidate.ArgsPrefix...),
		TrustedHome: driver.trustedHome,
		ProfileName: profile.Name,
		ProfileHome: profile.Home,
		ProfileArgs: append([]string(nil), profile.Args...),
	}, nil
}

type ManagedProfileRuntimeLease struct {
	path string
	lock *filelock.Lock
}

func AcquireManagedProfileRuntimeLease(
	ctx context.Context,
	host ManagedHost,
	wait time.Duration,
) (*ManagedProfileRuntimeLease, error) {
	trustedHome := strings.TrimSpace(host.TrustedHome)
	profileName := strings.TrimSpace(host.ProfileName)
	if trustedHome == "" || !filepath.IsAbs(trustedHome) {
		return nil, errors.New(
			"Hermes runtime lease requires an absolute trusted home",
		)
	}
	if profileName == "" ||
		filepath.Base(profileName) != profileName ||
		strings.ContainsAny(profileName, `/\`) {
		return nil, errors.New(
			"Hermes runtime lease requires a safe Profile name",
		)
	}
	if wait <= 0 {
		wait = defaultProfileLockWait
	}
	path := filepath.Join(
		filepath.Clean(trustedHome),
		".hermes",
		".raft-computer-go",
		"runtime-locks",
		profileName+".lock",
	)
	deadline := time.Now().Add(wait)
	for {
		lock, err := filelock.Acquire(path)
		if err == nil {
			return &ManagedProfileRuntimeLease{
				path: path,
				lock: lock,
			}, nil
		}
		if !errors.Is(err, filelock.ErrLocked) {
			return nil, fmt.Errorf(
				"acquire Hermes managed Profile runtime lease: %w",
				err,
			)
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return nil, ErrManagedProfileRuntimeBusy
		}
		delay := profileLockPollInterval
		if remaining < delay {
			delay = remaining
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

func (lease *ManagedProfileRuntimeLease) Release() error {
	if lease == nil || lease.lock == nil {
		return nil
	}
	return lease.lock.Release()
}
