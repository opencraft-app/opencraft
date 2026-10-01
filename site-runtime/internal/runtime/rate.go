package runtime

import "time"

// Per-manager beta safety bounds, independent of in-flight concurrency. Control
// operations are excluded so an abusive application cannot rate-limit deletion.
const (
	invocationRate  = 5.0
	invocationBurst = 10
	maxRateSites    = 4096
	rateIdleTTL     = 2 * time.Minute
)

type rateBucket struct {
	tokens  float64
	updated time.Time
}

func (s *Service) allowInvocation(site string, now time.Time) bool {
	s.rateLock.Lock()
	defer s.rateLock.Unlock()
	b, exists := s.rates[site]
	if !exists {
		if len(s.rates) >= maxRateSites {
			for id, old := range s.rates {
				if now.Sub(old.updated) >= rateIdleTTL {
					delete(s.rates, id)
				}
			}
			if len(s.rates) >= maxRateSites {
				return false
			}
		}
		b = rateBucket{tokens: invocationBurst, updated: now}
	}
	if elapsed := now.Sub(b.updated).Seconds(); elapsed > 0 {
		b.tokens = min(invocationBurst, b.tokens+elapsed*invocationRate)
		b.updated = now
	}
	allowed := b.tokens >= 1
	if allowed {
		b.tokens--
	}
	s.rates[site] = b
	return allowed
}
