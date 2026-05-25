package wrapper

import (
	"context"
	"fmt"
	"os"
	"time"
)

func (g *ACPGateway) acquireRuntimeOwnership(ctx context.Context, sessionID string, generation int64, runID, operation string) (RuntimeOwnershipLease, error) {
	return g.acquireRuntimeOwnershipWithOptions(ctx, sessionID, generation, runID, operation, false)
}

func (g *ACPGateway) acquireRuntimeOwnershipWithOptions(ctx context.Context, sessionID string, generation int64, runID, operation string, allowSameOwner bool) (RuntimeOwnershipLease, error) {
	if g.runtimeOwnership == nil {
		return RuntimeOwnershipLease{}, nil
	}
	if g.ownerID == "" {
		g.ownerID = "gateway_" + randomHex(12)
	}
	req := RuntimeOwnershipRequest{
		SessionID:      sessionID,
		Generation:     generation,
		RunID:          runID,
		OwnerID:        g.ownerID,
		Operation:      operation,
		TTL:            runtimeOwnershipTTL(),
		AllowSameOwner: allowSameOwner,
	}
	lease, err := g.runtimeOwnership.AcquireRuntimeOwnership(ctx, req)
	if err != nil {
		return RuntimeOwnershipLease{}, err
	}
	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_owner_acquired session_id=%s generation=%d run_id=%s owner_id=%s operation=%s fence=%d\n", lease.SessionID, lease.Generation, lease.RunID, lease.OwnerID, lease.Operation, lease.FencingToken)
	return lease, nil
}

func (g *ACPGateway) releaseRuntimeOwnership(lease RuntimeOwnershipLease) {
	if g.runtimeOwnership == nil || lease.SessionID == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := g.runtimeOwnership.ReleaseRuntimeOwnership(ctx, lease); err != nil {
		fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_owner_release_failed session_id=%s generation=%d run_id=%s error=%s\n", lease.SessionID, lease.Generation, lease.RunID, quoteServerField(err.Error()))
		return
	}
	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_owner_released session_id=%s generation=%d run_id=%s owner_id=%s operation=%s fence=%d\n", lease.SessionID, lease.Generation, lease.RunID, lease.OwnerID, lease.Operation, lease.FencingToken)
}

func (g *ACPGateway) runtimeOwnershipHeld(lease RuntimeOwnershipLease) bool {
	if g.runtimeOwnership == nil || lease.SessionID == "" {
		return true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	held, err := g.runtimeOwnership.RuntimeOwnershipHeld(ctx, lease)
	if err != nil {
		fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_owner_check_failed session_id=%s generation=%d run_id=%s error=%s\n", lease.SessionID, lease.Generation, lease.RunID, quoteServerField(err.Error()))
		return false
	}
	return held
}

func (g *ACPGateway) startRuntimeOwnershipHeartbeat(ctx context.Context, lease RuntimeOwnershipLease, onLost func(error)) func() {
	if g.runtimeOwnership == nil || lease.SessionID == "" {
		return func() {}
	}
	ttl := runtimeOwnershipTTL()
	interval := ttl / 3
	if interval < time.Second {
		interval = time.Second
	}
	if interval > 30*time.Second {
		interval = 30 * time.Second
	}
	heartbeatCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		timer := time.NewTimer(interval)
		defer timer.Stop()
		for {
			select {
			case <-heartbeatCtx.Done():
				return
			case <-timer.C:
				renewCtx, renewCancel := context.WithTimeout(context.Background(), 5*time.Second)
				err := g.runtimeOwnership.RenewRuntimeOwnership(renewCtx, lease, ttl)
				renewCancel()
				if err != nil {
					fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_owner_heartbeat_failed session_id=%s generation=%d run_id=%s error=%s\n", lease.SessionID, lease.Generation, lease.RunID, quoteServerField(err.Error()))
					if onLost != nil {
						onLost(err)
					}
					return
				}
				timer.Reset(interval)
			}
		}
	}()
	return func() {
		cancel()
		<-done
	}
}

func runtimeOwnershipTTL() time.Duration {
	return envDurationSeconds("GATEWAY_ACP_RUNTIME_OWNER_TTL_SECONDS", defaultRuntimeOwnershipTTL)
}
