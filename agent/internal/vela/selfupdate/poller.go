package selfupdate

import (
	"context"
	"errors"
	"math/rand/v2"
	"time"
)

var ErrPollerInvalid = errors.New("Computer Update poller 配置无效")

type ChannelSource interface {
	Get(context.Context) (VerifiedChannel, error)
}

type Candidate struct {
	Version   string
	Sequence  int64
	Directory string
	Release   VerifiedRelease
}

type CandidatePreparer interface {
	Prepare(context.Context, VerifiedChannel) (Candidate, error)
}

type CandidateSink interface {
	Stage(context.Context, Candidate) error
}

type PollerConfig struct {
	Source     ChannelSource
	Preparer   CandidatePreparer
	Sink       CandidateSink
	Trust      *TrustState
	Now        func() time.Time
	Interval   time.Duration
	Jitter     func(time.Duration) time.Duration
	RetryDelay func(int) time.Duration
	Wait       func(context.Context, time.Duration) bool
}

type Poller struct{ config PollerConfig }

func NewPoller(config PollerConfig) (*Poller, error) {
	if config.Source == nil || config.Preparer == nil || config.Sink == nil ||
		config.Trust == nil || config.Now == nil ||
		config.Interval < time.Minute || config.Interval > 24*time.Hour {
		return nil, ErrPollerInvalid
	}
	if config.Jitter == nil {
		config.Jitter = defaultPollJitter
	}
	if config.RetryDelay == nil {
		config.RetryDelay = defaultPollRetryDelay
	}
	if config.Wait == nil {
		config.Wait = waitForPoll
	}
	return &Poller{config: config}, nil
}

func (poller *Poller) CheckOnce(ctx context.Context) error {
	if poller == nil || ctx == nil {
		return ErrPollerInvalid
	}
	value, err := poller.config.Source.Get(ctx)
	if err != nil {
		return err
	}
	snapshot := poller.config.Trust.Snapshot()
	if value.Descriptor.Sequence == snapshot.HighestAcceptedSequence &&
		hexDigest(value.PayloadSHA256) == snapshot.AcceptedDescriptorSHA256 {
		return nil
	}
	if value.Descriptor.Sequence <= snapshot.HighestAcceptedSequence ||
		compareVersions(value.Descriptor.ExpectedVersion, snapshot.HighestHealthyVersion) < 0 {
		_, err := poller.config.Trust.Accept(value, poller.config.Now().UTC())
		return err
	}
	if value.Descriptor.ExpectedVersion == snapshot.HighestHealthyVersion {
		_, err := poller.config.Trust.Accept(value, poller.config.Now().UTC())
		return err
	}
	candidate, err := poller.config.Preparer.Prepare(ctx, value)
	if err != nil {
		return err
	}
	if candidate.Version != value.Descriptor.ExpectedVersion ||
		candidate.Sequence != value.Descriptor.Sequence || !cleanAbsolute(candidate.Directory) {
		return ErrPollerInvalid
	}
	if err := poller.config.Sink.Stage(ctx, candidate); err != nil {
		return err
	}
	_, err = poller.config.Trust.Accept(value, poller.config.Now().UTC())
	return err
}

func (poller *Poller) Run(ctx context.Context) error {
	if poller == nil || ctx == nil {
		return ErrPollerInvalid
	}
	failures := 0
	for {
		err := poller.CheckOnce(ctx)
		if ctx.Err() != nil {
			return nil
		}
		delay := poller.config.Jitter(poller.config.Interval)
		if err != nil {
			failures++
			delay = poller.config.RetryDelay(failures)
		} else {
			failures = 0
		}
		if delay <= 0 {
			return ErrPollerInvalid
		}
		if !poller.config.Wait(ctx, delay) {
			return nil
		}
	}
}

func defaultPollJitter(interval time.Duration) time.Duration {
	spread := interval / 10
	if spread <= 0 {
		return interval
	}
	return interval - spread + time.Duration(rand.Int64N(int64(2*spread)+1))
}

func defaultPollRetryDelay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	if attempt > 6 {
		attempt = 6
	}
	return time.Duration(1<<uint(attempt-1)) * 15 * time.Second
}

func waitForPoll(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func hexDigest(value [32]byte) string {
	const alphabet = "0123456789abcdef"
	encoded := make([]byte, len(value)*2)
	for index, current := range value {
		encoded[index*2] = alphabet[current>>4]
		encoded[index*2+1] = alphabet[current&0x0f]
	}
	return string(encoded)
}
