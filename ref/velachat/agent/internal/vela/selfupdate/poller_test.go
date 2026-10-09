package selfupdate

import (
	"context"
	"crypto/sha256"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

type fixedChannelSource struct{ value VerifiedChannel }

func (source *fixedChannelSource) Get(context.Context) (VerifiedChannel, error) {
	return source.value, nil
}

type recordingCandidatePreparer struct {
	state *TrustState
	calls int
}

func (preparer *recordingCandidatePreparer) Prepare(
	_ context.Context,
	value VerifiedChannel,
) (Candidate, error) {
	preparer.calls++
	if preparer.state.Snapshot().HighestAcceptedSequence != 0 {
		return Candidate{}, errors.New("trust state advanced before verified staging")
	}
	return Candidate{
		Version:   value.Descriptor.ExpectedVersion,
		Sequence:  value.Descriptor.Sequence,
		Directory: "/private/staged/v0.1.52",
	}, nil
}

type recordingCandidateSink struct {
	state *TrustState
	calls int
}

func (sink *recordingCandidateSink) Stage(_ context.Context, candidate Candidate) error {
	sink.calls++
	if candidate.Version != "v0.1.52" || candidate.Sequence != 7 ||
		sink.state.Snapshot().HighestAcceptedSequence != 0 {
		return errors.New("candidate was not staged before trust commit")
	}
	return nil
}

func TestPollerStagesVerifiedCandidateBeforeCommittingTrustState(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 17, 23, 0, 0, 0, time.UTC)
	state, err := OpenTrustState(TrustStateConfig{
		Root: filepath.Join(t.TempDir(), "state"), Channel: "stable", Target: "linux-amd64",
		CurrentVersion: "v0.1.51", Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	source := &fixedChannelSource{value: VerifiedChannel{
		Descriptor: ChannelDescriptor{
			SchemaVersion: 1, Channel: "stable", Target: "linux-amd64",
			Sequence: 7, ExpectedVersion: "v0.1.52",
		},
		PayloadSHA256: sha256.Sum256([]byte("sequence-7")),
	}}
	preparer := &recordingCandidatePreparer{state: state}
	sink := &recordingCandidateSink{state: state}
	poller, err := NewPoller(PollerConfig{
		Source: source, Preparer: preparer, Sink: sink, Trust: state,
		Now: func() time.Time { return now }, Interval: 15 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := poller.CheckOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if preparer.calls != 1 || sink.calls != 1 || state.Snapshot().HighestAcceptedSequence != 7 {
		t.Fatalf("calls=(%d,%d) state=%#v", preparer.calls, sink.calls, state.Snapshot())
	}
	if err := poller.CheckOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if preparer.calls != 1 || sink.calls != 1 {
		t.Fatalf("identical descriptor repeated work: calls=(%d,%d)", preparer.calls, sink.calls)
	}
}
