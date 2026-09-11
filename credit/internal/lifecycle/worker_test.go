package lifecycle

import (
	"context"
	"errors"
	"testing"
	"time"

	"git.woa.com/wisp/mono/credit/internal/store"
)

type fakeStore struct {
	packages    []*store.CreditPackage
	claimed     bool
	claimID     string
	claimNow    time.Time
	staleBefore time.Time
	releasedID  string
	releaseAt   time.Time
}

func (s *fakeStore) ListExpiredPackages(_ context.Context, now, staleBefore time.Time, limit int) ([]*store.CreditPackage, error) {
	s.claimNow = now
	s.staleBefore = staleBefore
	if len(s.packages) > limit {
		return s.packages[:limit], nil
	}
	return s.packages, nil
}

func (s *fakeStore) TryClaimExpiredPackage(_ context.Context, packageID string, now, staleBefore time.Time) (bool, error) {
	s.claimID = packageID
	s.claimNow = now
	s.staleBefore = staleBefore
	return s.claimed, nil
}

func (s *fakeStore) ReleaseExpiredPackageClaim(_ context.Context, packageID string, claimedAt time.Time) (bool, error) {
	s.releasedID = packageID
	s.releaseAt = claimedAt
	return true, nil
}

type fakeDestroyer struct {
	packageIDs []string
	err        error
}

func (d *fakeDestroyer) ExpirePaidPackage(_ context.Context, packageID string) error {
	d.packageIDs = append(d.packageIDs, packageID)
	return d.err
}

func TestWorkerClaimsAndDestroysExpiredPackage(t *testing.T) {
	now := time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC)
	st := &fakeStore{
		packages: []*store.CreditPackage{{PackageID: "cpkg-expired", Status: store.PackageStatusActive}},
		claimed:  true,
	}
	destroyer := &fakeDestroyer{}
	worker := NewWorker(st, destroyer, WorkerOptions{
		Now: func() time.Time { return now }, LeaseDuration: 30 * time.Second, BatchSize: 50,
	})

	if err := worker.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce(): %v", err)
	}
	if st.claimID != "cpkg-expired" || len(destroyer.packageIDs) != 1 || destroyer.packageIDs[0] != "cpkg-expired" {
		t.Fatalf("claim=%q destroyed=%v", st.claimID, destroyer.packageIDs)
	}
	if !st.staleBefore.Equal(now.Add(-30 * time.Second)) {
		t.Fatalf("staleBefore=%s", st.staleBefore)
	}
	if st.releasedID != "" {
		t.Fatalf("successful destruction must not release claim: %q", st.releasedID)
	}
}

func TestWorkerReleasesClaimToActiveWhenDestructionFails(t *testing.T) {
	now := time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC)
	st := &fakeStore{
		packages: []*store.CreditPackage{{PackageID: "cpkg-expired", Status: store.PackageStatusActive}},
		claimed:  true,
	}
	destroyErr := errors.New("cancel subscription")
	worker := NewWorker(st, &fakeDestroyer{err: destroyErr}, WorkerOptions{Now: func() time.Time { return now }})

	err := worker.RunOnce(context.Background())
	if !errors.Is(err, destroyErr) {
		t.Fatalf("RunOnce() error=%v", err)
	}
	if st.releasedID != "cpkg-expired" || !st.releaseAt.Equal(now) {
		t.Fatalf("release id=%q claimedAt=%s", st.releasedID, st.releaseAt)
	}
}

func TestWorkerSkipsPackageWhenAnotherPodOwnsClaim(t *testing.T) {
	st := &fakeStore{
		packages: []*store.CreditPackage{{PackageID: "cpkg-expired", Status: store.PackageStatusActive}},
		claimed:  false,
	}
	destroyer := &fakeDestroyer{}
	worker := NewWorker(st, destroyer, WorkerOptions{})

	if err := worker.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce(): %v", err)
	}
	if len(destroyer.packageIDs) != 0 || st.releasedID != "" {
		t.Fatalf("destroyed=%v released=%q", destroyer.packageIDs, st.releasedID)
	}
}
