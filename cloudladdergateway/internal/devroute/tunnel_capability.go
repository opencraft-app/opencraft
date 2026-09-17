package devroute

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/tunnelcap"
)

var ErrInvalidTunnelCapability = errors.New("invalid or expired developer tunnel capability")

// TunnelCapabilityVerifier validates agent capabilities against the current
// registration. Disabling or expiring the Lease therefore revokes an already
// issued capability without exposing the shared devtunnel secret.
type TunnelCapabilityVerifier struct {
	Store Store
	Now   func() time.Time
}

func (v TunnelCapabilityVerifier) Verify(ctx context.Context, token string, tunnelHost string) error {
	if v.Store == nil {
		return ErrInvalidTunnelCapability
	}
	uin, ok := tunnelcap.UIN(token)
	if !ok {
		return ErrInvalidTunnelCapability
	}
	registration, err := v.Store.Get(ctx, uin)
	if err != nil {
		return ErrInvalidTunnelCapability
	}
	now := time.Now().UTC()
	if v.Now != nil {
		now = v.Now().UTC()
	}
	if registration.State(now) != StateActive || registration.DeliveryMode != DeliveryModeDevtunnel {
		return ErrInvalidTunnelCapability
	}
	if tunnelHost = strings.ToLower(strings.TrimSpace(tunnelHost)); tunnelHost != "" && tunnelHost != registration.TunnelHost {
		return ErrInvalidTunnelCapability
	}
	if !tunnelcap.MatchesDigest(token, registration.TunnelTokenHash) {
		return ErrInvalidTunnelCapability
	}
	return nil
}
