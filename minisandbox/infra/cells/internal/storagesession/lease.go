package storagesession

import (
	"context"
	"errors"
	"time"

	coordinationv1 "k8s.io/api/coordination/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/leaderelection/resourcelock"
)

const leaseDuration = 60 * time.Second

// A pre-created, UID-pinned Lease lets RBAC restrict GET/UPDATE by resourceName.
// Kubernetes RBAC cannot restrict CREATE by resourceName. No create/list/event
// permission is needed, and SDK/API errors never reach client-go's klog output.
type exactLeaseLock struct {
	c     *controller
	lease *coordinationv1.Lease
}

func (c *controller) getLease(ctx context.Context) (*coordinationv1.Lease, error) {
	call, cancel := context.WithTimeout(ctx, c.config.timeout())
	defer cancel()
	l, err := c.coordination.Leases(c.config.Namespace).Get(call, c.config.LeaseName, metav1.GetOptions{})
	if err != nil {
		return nil, errors.New("lease_read_failed")
	}
	if l.Name != c.config.LeaseName || l.UID != types.UID(c.config.LeaseUID) || !c.owned(l) {
		return nil, errors.New("lease_identity_drift")
	}
	return l, nil
}

func (c *controller) holdsLease(ctx context.Context) error {
	if ctx.Err() != nil || !c.elector.IsLeader() {
		return errors.New("lease_not_held")
	}
	l, err := c.getLease(ctx)
	if err != nil {
		return err
	}
	if !c.leaseHeld(ctx, l) {
		return errors.New("lease_not_held")
	}
	return nil
}

func (c *controller) leaseHeld(ctx context.Context, l *coordinationv1.Lease) bool {
	return ctx.Err() == nil && c.elector.IsLeader() && l.Spec.HolderIdentity != nil && *l.Spec.HolderIdentity == c.identity && l.Spec.RenewTime != nil &&
		l.Spec.LeaseDurationSeconds != nil && *l.Spec.LeaseDurationSeconds == int32(leaseDuration/time.Second) &&
		!l.Spec.RenewTime.Time.After(time.Now().Add(5*time.Second)) && l.Spec.RenewTime.Add(leaseDuration).After(time.Now().Add(c.config.timeout()+5*time.Second))
}

func (l *exactLeaseLock) Get(ctx context.Context) (*resourcelock.LeaderElectionRecord, []byte, error) {
	if err := l.c.checkScope(ctx); err != nil {
		return nil, nil, err
	}
	lease, err := l.c.getLease(ctx)
	if err != nil {
		return nil, nil, err
	}
	l.lease = lease
	record := resourcelock.LeaseSpecToLeaderElectionRecord(&lease.Spec)
	// Raw record is used only for change detection, not persistence/logging.
	return record, []byte(lease.ResourceVersion), nil
}

func (*exactLeaseLock) Create(context.Context, resourcelock.LeaderElectionRecord) error {
	return errors.New("precreated_lease_required")
}
func (l *exactLeaseLock) Update(ctx context.Context, record resourcelock.LeaderElectionRecord) error {
	if l.lease == nil {
		return errors.New("lease_not_observed")
	}
	if err := l.c.checkScope(ctx); err != nil {
		return err
	}
	desired := l.lease.DeepCopy()
	desired.Spec = resourcelock.LeaderElectionRecordToLeaseSpec(&record)
	call, cancel := context.WithTimeout(ctx, l.c.config.timeout())
	defer cancel()
	updated, err := l.c.coordination.Leases(l.c.config.Namespace).Update(call, desired, metav1.UpdateOptions{})
	if err != nil {
		return errors.New("lease_update_failed")
	}
	l.lease = updated
	return nil
}
func (*exactLeaseLock) RecordEvent(string) {}
func (l *exactLeaseLock) Identity() string { return l.c.identity }
func (l *exactLeaseLock) Describe() string { return "storage-session-renewer" }
