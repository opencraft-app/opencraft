// Package desktop owns transient authorized viewers, not desktop processes.
// It has no permissive default authority and is not mounted in the public API.
package desktop

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"io"
	"sync"
	"time"
)

var errUnavailable = errors.New("desktop unavailable")

type Target struct {
	ConversationID string `json:"conversationId"`
	ServerID       string `json:"serverId"`
	EnvironmentID  string `json:"environmentId"`
	PrincipalID    string `json:"principalId"`
}
type Request struct {
	Target                  Target `json:"target"`
	InstanceID              string `json:"instanceId"`
	ResourceID              string `json:"resourceId"`
	PreparationGenerationID string `json:"preparationGenerationId"`
	BindingRevision         string `json:"bindingRevision"`
}

// Binding must come from the canonical directory and verified remote runtime.
// Preparation generation is never accepted as physical incarnation.
type Binding struct {
	Request
	Incarnation string
}
type Authority interface {
	Resolve(context.Context, string, Target) (Binding, error)
	// OpenVerified verifies physical incarnation and native input policy before
	// returning a dedicated stream. An unrestricted VNC stream is not acceptable.
	OpenVerified(opening context.Context, lifetime context.Context, binding Binding) (VerifiedStream, error)
}
type VerifiedStream struct {
	Binding Binding
	// Native observe-only, or default-deny gated RFB. Close must revoke input
	// and clear held keys/buttons independently of further control messages.
	Stream io.ReadWriteCloser
	// Nil for the immutable observer. Only an actual remote input executor may
	// implement this port; a local boolean or mutex is not input enforcement.
	Control Controller
}
type Controller interface {
	// Must enforce exclusive input including other viewers/Agent users of the
	// executor. Return only after the remote grant is confirmed.
	// Honor request cancellation; a successful grant has its own lifetime,
	// independent of this request context.
	Acquire(context.Context) (Grant, error)
}
type Grant interface {
	// Non-nil; closes on remote revocation and successful Release.
	Done() <-chan struct{}
	// Revoke input and release held keys/buttons before successful completion.
	// Unknown/failed release causes the entire viewer connection to be retired.
	Release(context.Context) error
}
type Credential struct {
	Request
	Version      int    `json:"version"`
	AttachmentID string `json:"attachmentId"`
	Ticket       string `json:"ticket"`
	Incarnation  string `json:"incarnation"`
	ExpiresAt    int64  `json:"expiresAt"`
}
type attachment struct {
	id, principal            string
	binding                  Binding
	ticket                   [32]byte
	ticketDeadline, deadline time.Time
	claimed                  bool
	ctx                      context.Context
	cancel                   context.CancelFunc
	timer                    *time.Timer
	closeTransport           func()
}
type Broker struct {
	authority                          Authority
	mu                                 sync.Mutex
	attachments                        map[string]*attachment
	sockets                            map[string]int
	closed                             bool
	ticketTTL, lifetime, checkInterval time.Duration
}

func NewBroker(authority Authority) (*Broker, error) {
	if authority == nil {
		return nil, errUnavailable
	}
	return &Broker{authority: authority, attachments: make(map[string]*attachment), sockets: make(map[string]int),
		ticketTTL: 30 * time.Second, lifetime: 5 * time.Minute, checkInterval: 5 * time.Second}, nil
}

func (b *Broker) reserveSocket(principal string) (func(), bool) {
	b.mu.Lock()
	total := 0
	for _, count := range b.sockets {
		total += count
	}
	if b.closed || (principal != "" && b.sockets[principal] >= 4) || total >= 128 {
		b.mu.Unlock()
		return nil, false
	}
	b.sockets[principal]++
	b.mu.Unlock()
	return func() {
		b.mu.Lock()
		b.sockets[principal]--
		if b.sockets[principal] == 0 {
			delete(b.sockets, principal)
		}
		b.mu.Unlock()
	}, true
}
func opaque(size int) (string, error) {
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		return "", errUnavailable
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}
func validRequest(principal string, req Request) bool {
	return principal != "" && req.Target.PrincipalID == principal && req.Target.ConversationID != "" &&
		req.Target.ServerID != "" && req.Target.EnvironmentID != "" && req.InstanceID != "" &&
		req.ResourceID != "" && req.PreparationGenerationID != "" && req.BindingRevision != ""
}
func (b *Broker) Issue(ctx context.Context, principal string, req Request) (Credential, error) {
	ctx, cancelRequest := context.WithTimeout(ctx, 5*time.Second)
	defer cancelRequest()
	if !validRequest(principal, req) {
		return Credential{}, errUnavailable
	}
	binding, err := b.authority.Resolve(ctx, principal, req.Target)
	if err != nil || binding.Request != req || binding.Incarnation == "" || ctx.Err() != nil {
		return Credential{}, errUnavailable
	}
	id, err := opaque(16)
	if err != nil {
		return Credential{}, err
	}
	ticket, err := opaque(32)
	if err != nil {
		return Credential{}, err
	}
	lifetime, cancel := context.WithCancel(context.Background())
	now := time.Now()
	a := &attachment{id: id, principal: principal, binding: binding, ticket: sha256.Sum256([]byte(ticket)),
		ticketDeadline: now.Add(b.ticketTTL), deadline: now.Add(b.lifetime), ctx: lifetime, cancel: cancel}
	b.mu.Lock()
	count := 0
	for _, existing := range b.attachments {
		if existing.principal == principal {
			count++
		}
	}
	if b.closed || len(b.attachments) >= 128 || count >= 4 || ctx.Err() != nil {
		b.mu.Unlock()
		cancel()
		return Credential{}, errUnavailable
	}
	b.attachments[id] = a
	// Unclaimed tickets release their slot promptly; a claimed viewer replaces
	// this timer under the same lock before remote opening.
	a.timer = time.AfterFunc(b.ticketTTL, func() { b.expire(a) })
	b.mu.Unlock()
	return Credential{Request: req, Version: 1, AttachmentID: id, Ticket: ticket,
		Incarnation: binding.Incarnation, ExpiresAt: a.deadline.UnixMilli()}, nil
}
func (b *Broker) claim(ctx context.Context, principal, id, ticket string) (*attachment, VerifiedStream, error) {
	hash := sha256.Sum256([]byte(ticket))
	b.mu.Lock()
	a := b.attachments[id]
	if b.closed || a == nil || (principal != "" && a.principal != principal) || a.claimed || len(ticket) > 128 ||
		!time.Now().Before(a.ticketDeadline) || subtle.ConstantTimeCompare(hash[:], a.ticket[:]) != 1 {
		b.mu.Unlock()
		return nil, VerifiedStream{}, errUnavailable
	}
	// A verified ticket binds the principal server-side. Never accept a
	// principal supplied in the WebSocket authentication payload.
	principal = a.principal
	a.claimed = true
	a.ticket = [32]byte{}
	a.timer.Stop()
	a.timer = time.AfterFunc(time.Until(a.deadline), func() { b.expire(a) })
	b.mu.Unlock()
	opening, cancel := context.WithTimeout(a.ctx, 15*time.Second)
	stop := context.AfterFunc(ctx, cancel)
	defer func() { stop(); cancel() }()
	current, err := b.authority.Resolve(opening, principal, a.binding.Target)
	if err != nil || current != a.binding {
		b.retire(a)
		return nil, VerifiedStream{}, errUnavailable
	}
	stream, err := b.authority.OpenVerified(opening, a.ctx, current)
	if err != nil || stream.Stream == nil || stream.Binding != current || opening.Err() != nil || a.ctx.Err() != nil {
		if stream.Stream != nil {
			_ = stream.Stream.Close()
		}
		b.retire(a)
		return nil, VerifiedStream{}, errUnavailable
	}
	// The returned stream's lifetime must be independent of the opening context;
	// the attachment registers its closer before it can be used by a consumer.
	return a, stream, nil
}
func (b *Broker) expire(a *attachment) {
	b.mu.Lock()
	deadline := a.ticketDeadline
	if a.claimed {
		deadline = a.deadline
	}
	expired := b.attachments[a.id] == a && !time.Now().Before(deadline)
	b.mu.Unlock()
	if expired {
		b.retire(a)
	}
}
func (b *Broker) retire(a *attachment) {
	b.mu.Lock()
	if b.attachments[a.id] != a {
		b.mu.Unlock()
		return
	}
	delete(b.attachments, a.id)
	a.timer.Stop()
	closeTransport := a.closeTransport
	a.closeTransport = nil
	b.mu.Unlock()
	a.cancel()
	if closeTransport != nil {
		closeTransport()
	}
}
func (b *Broker) Release(principal, id string) {
	b.mu.Lock()
	a := b.attachments[id]
	b.mu.Unlock()
	if a != nil && a.principal == principal {
		b.retire(a)
	}
}

// Directory/permission owner must call Revoke on change; the periodic check is
// a bounded safety net, not a substitute for immediate revocation events.
func (b *Broker) Revoke(target Target) {
	b.mu.Lock()
	var found []*attachment
	for _, a := range b.attachments {
		if a.binding.Target == target {
			found = append(found, a)
		}
	}
	b.mu.Unlock()
	for _, a := range found {
		b.retire(a)
	}
}
func (b *Broker) Close() {
	b.mu.Lock()
	b.closed = true
	all := make([]*attachment, 0, len(b.attachments))
	for _, a := range b.attachments {
		all = append(all, a)
	}
	b.mu.Unlock()
	for _, a := range all {
		b.retire(a)
	}
}
