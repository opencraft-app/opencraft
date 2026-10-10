package storagesession

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/dynamic"
	coordinationclient "k8s.io/client-go/kubernetes/typed/coordination/v1"
	coreclient "k8s.io/client-go/kubernetes/typed/core/v1"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/leaderelection"
)

// Health contains no credentials, provider errors, or object bodies.
type Health struct {
	mu    sync.RWMutex
	ready bool
	until time.Time
}

func (h *Health) set(ready bool, until time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.ready, h.until = ready, until
}
func (h *Health) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	switch r.URL.Path {
	case "/livez":
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("alive\n"))
	case "/readyz":
		h.mu.RLock()
		ready := h.ready && time.Now().Before(h.until)
		h.mu.RUnlock()
		if !ready {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("not_ready\n"))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ready\n"))
	default:
		http.NotFound(w, r)
	}
}

type controller struct {
	config       Config
	core         coreclient.CoreV1Interface
	coordination coordinationclient.CoordinationV1Interface
	dynamic      dynamic.Interface
	issuer       *oidcIssuer
	elector      *leaderelection.LeaderElector
	identity     string
	health       *Health
	pending      map[string]bool
}

// Run uses only in-cluster credentials and terminates permanently on lease loss.
// STS uses an explicit unsigned SDK client, never a default credential chain.
func Run(ctx context.Context, config Config, health *Health) error {
	if err := config.Validate(); err != nil {
		return err
	}
	health.set(false, time.Time{})
	cfg, err := rest.InClusterConfig()
	if err != nil {
		return errors.New("kubernetes_identity_unavailable")
	}
	cfg.Timeout = config.timeout()
	cfg.UserAgent = "storage-session-renewer"
	core, err := coreclient.NewForConfig(cfg)
	if err != nil {
		return errors.New("kubernetes_client_invalid")
	}
	coordination, err := coordinationclient.NewForConfig(cfg)
	if err != nil {
		return errors.New("kubernetes_client_invalid")
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return errors.New("kubernetes_client_invalid")
	}
	identity, err := randomID()
	if err != nil {
		return err
	}
	c := &controller{config: config, core: core, coordination: coordination, dynamic: dyn, identity: "storage-" + identity, health: health, pending: map[string]bool{}}
	if err = c.checkScope(ctx); err != nil {
		return err
	}
	if _, err = c.getLease(ctx); err != nil {
		return err
	}
	for _, r := range config.Roles {
		if _, err = c.getSecret(ctx, r); err != nil {
			return err
		}
	}
	c.issuer = newOIDCIssuer(config)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	start, done := make(chan struct{}), make(chan struct{})
	elector, err := leaderelection.NewLeaderElector(leaderelection.LeaderElectionConfig{
		Lock: &exactLeaseLock{c: c}, LeaseDuration: leaseDuration, RenewDeadline: 40 * time.Second, RetryPeriod: 5 * time.Second,
		// Do not release early while a cancelled STS/CAS might still be unwinding.
		ReleaseOnCancel: false, Name: "storage-session-renewer",
		Callbacks: leaderelection.LeaderCallbacks{
			OnStartedLeading: func(leading context.Context) { close(start); <-leading.Done() },
			OnStoppedLeading: func() { health.set(false, time.Time{}); cancel() },
		},
	})
	if err != nil {
		return errors.New("leader_election_invalid")
	}
	c.elector = elector
	// Spawn before election: shutdown can always wait even if never acquired.
	go func() {
		defer close(done)
		select {
		case <-ctx.Done():
			return
		case <-start:
			c.loop(ctx)
		}
	}()
	elector.Run(ctx)
	cancel()
	<-done
	health.set(false, time.Time{})
	return nil
}

func (c *controller) loop(ctx context.Context) {
	timer := time.NewTicker(time.Duration(c.config.PollSeconds) * time.Second)
	defer timer.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		c.reconcile(ctx)
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
	}
}

func (c *controller) reconcile(ctx context.Context) {
	// Any failed preflight/read/exchange/write immediately drops readiness.
	ready := false
	defer func() {
		if !ready {
			c.health.set(false, time.Time{})
		}
	}()
	if c.checkScope(ctx) != nil || c.holdsLease(ctx) != nil {
		return
	}
	observed := make(map[string]*corev1.Secret, 3)
	// Validate ALL identities/configuration before issuing ANY role.
	for _, r := range c.config.Roles {
		s, err := c.getSecret(ctx, r)
		if err != nil {
			return
		}
		observed[r.Name] = s
		tuple, err := readSession(s, r)
		if err != nil || tuple.ExpiresAt <= time.Now().Unix()+c.config.ReadyMinSeconds {
			c.health.set(false, time.Time{})
		}
	}
	failed := false
	for _, r := range c.config.Roles {
		s, err := readSession(observed[r.Name], r)
		_, bound := observed[r.Name].Annotations[annotationPrefix+"session-role-arn"]
		due := !bound || err != nil || s.ExpiresAt <= time.Now().Unix()+c.config.RenewBeforeSeconds || s.ExpiresAt > time.Now().Unix()+c.config.DurationSeconds+60
		if !due {
			delete(c.pending, r.Name)
			continue
		}
		if c.pending[r.Name] {
			// Unknown STS/write outcome: one read-only cycle for this exact role.
			// A later cycle may perform a NEW exchange, never replay the old request.
			delete(c.pending, r.Name)
			c.health.set(false, time.Time{})
			failed = true
			continue
		}
		if c.holdsLease(ctx) != nil {
			return
		}
		tuple, err := c.issuer.issue(ctx, r)
		if err == nil {
			err = c.publish(ctx, r, observed[r.Name], tuple)
		}
		if err != nil {
			c.pending[r.Name] = true
			c.health.set(false, time.Time{})
			failed = true
		}
	}
	if failed || ctx.Err() != nil || c.checkScope(ctx) != nil || c.holdsLease(ctx) != nil {
		return
	}
	// Verify actual persisted data, not an STS response or successful Update alone.
	now := time.Now()
	until := now.Add(2 * time.Duration(c.config.PollSeconds) * time.Second)
	for _, r := range c.config.Roles {
		live, err := c.getSecret(ctx, r)
		if err != nil {
			return
		}
		s, err := readSession(live, r)
		_, bound := live.Annotations[annotationPrefix+"session-role-arn"]
		if !bound || err != nil || s.ExpiresAt <= time.Now().Unix()+c.config.ReadyMinSeconds || s.ExpiresAt > time.Now().Unix()+c.config.DurationSeconds+60 {
			return
		}
		deadline := time.Unix(s.ExpiresAt-c.config.ReadyMinSeconds, 0)
		if deadline.Before(until) {
			until = deadline
		}
	}
	if ctx.Err() != nil || c.holdsLease(ctx) != nil {
		return
	}
	// Readiness also expires before the last observed live Lease can expire.
	l, err := c.getLease(ctx)
	if err != nil || !c.leaseHeld(ctx, l) {
		return
	}
	deadline := l.Spec.RenewTime.Add(leaseDuration - c.config.timeout() - 5*time.Second)
	if deadline.Before(until) {
		until = deadline
	}
	c.health.set(true, until)
	ready = true
}
