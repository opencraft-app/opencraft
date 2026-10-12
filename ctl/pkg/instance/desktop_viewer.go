package instance

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	modelinstance "ctl/pkg/model/instance"
	"ctl/pkg/transport"

	"github.com/google/uuid"
)

// Viewer attachments let the new client use instance-scoped TAT instead of
// legacy ingress credentials; desktop/session retains those for old clients.
// Leases bind the owner, sandbox and prepared generation. The input gateway
// enforces a single-use ticket and grant lifetime on its connections. The raw
// read-only endpoint and instance-level TAT capability are not broker-scoped:
// this contract does not claim mandatory ticket checks on every media path.
const (
	desktopViewerVersion = 1

	desktopViewerTicketBytes = 32
	// Bounded lifetime. There is no renewal protocol: a reconnect needs a new
	// lease, so a live desktop never implies a resumable viewer.
	desktopViewerTTL = 5 * time.Minute
	// An unredeemed ticket is reclaimed after this window.
	desktopViewerClaimWindow = 30 * time.Second

	desktopViewerMaxPerInstance = 4
	// A writable lease owns keyboard and mouse, so there is exactly one of them
	// per instance. Read-only viewing stays shareable.
	desktopViewerMaxWritePerInstance = 1
	desktopViewerMaxTotal            = 128

	desktopViewerTunnelIPEnv        = "DESKTOP_VIEWER_TUNNEL_IP"
	desktopViewerTunnelWritePortEnv = "DESKTOP_VIEWER_TUNNEL_WRITE_PORT"
	desktopViewerTunnelReadPortEnv  = "DESKTOP_VIEWER_TUNNEL_READ_PORT"
	desktopViewerTunnelModeEnv      = "DESKTOP_VIEWER_TUNNEL_MODE"
	desktopViewerTunnelPathEnv      = "DESKTOP_VIEWER_TUNNEL_PATH"

	// The writable target is the loopback-only interactive endpoint installed
	// by desktop/resource; the read-only target is the observer. Both are
	// -nopw and loopback bound, so no password ever reaches the browser: the
	// TAT tunnel is the credential.
	// Kept in sync with desktopInputPort / desktopObserverPort by the assertion
	// below: those are typed ints because the systemd units render them.
	desktopViewerDefaultTunnelIP = "127.0.0.1"
	// Write goes to the input gateway (5904), never straight to the writable
	// x11vnc (5903): the gateway is what enforces input authorization.
	desktopViewerDefaultTunnelWritePort = "5904"
	desktopViewerDefaultTunnelReadPort  = "5901"
)

// The tunnel defaults must track the ports the units actually bind.
var _ = func() int {
	if desktopViewerDefaultTunnelWritePort != fmt.Sprint(desktopInputProxyPort) {
		panic("desktop viewer write port default does not match desktopInputProxyPort")
	}
	if desktopViewerDefaultTunnelReadPort != fmt.Sprint(desktopObserverPort) {
		panic("desktop viewer read port default does not match desktopObserverPort")
	}
	return 0
}()

type desktopViewerAttachment struct {
	id           string
	ticketDigest [sha256.Size]byte
	instanceID   string
	userID       string
	resourceID   string
	generationID string
	sandboxID    string
	// A write reservation survives uncertain remote outcomes until revoke or expiry.
	access         string
	createdAt      time.Time
	claimedAt      time.Time
	expiresAt      time.Time
	grantAttempted bool
	revoked        bool
	// incarnation pins the lease to the verified physical desktop, so a lease
	// minted for one machine can never be replayed against another.
	incarnation string
}

// desktopViewerBinding is what a lease is pinned to: one prepared generation,
// one sandbox, and whether the writable endpoint is available.
type desktopViewerBinding struct {
	generation  string
	sandboxID   string
	inputReady  bool
	incarnation string
}

var (
	desktopViewerMu sync.Mutex
	desktopViewers  = map[string]*desktopViewerAttachment{}
)

func resetDesktopViewersForTest() {
	desktopViewerMu.Lock()
	defer desktopViewerMu.Unlock()
	desktopViewers = map[string]*desktopViewerAttachment{}
}

func desktopViewerEnv(name, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value
}

// desktopViewerTunnelFor is the only endpoint hint handed to a client. It never
// contains a host name, a sandbox id or a credential. The writable endpoint is
// used only when desktop/resource actually prepared it; otherwise the viewer
// degrades to the read-only observer.
func desktopViewerTunnelFor(access string) transport.DesktopViewerTunnel {
	mode := strings.ToLower(desktopViewerEnv(desktopViewerTunnelModeEnv, transport.DesktopViewerTunnelModeRFB))
	if mode != transport.DesktopViewerTunnelModeWS {
		mode = transport.DesktopViewerTunnelModeRFB
	}
	port := desktopViewerDefaultTunnelReadPort
	portEnv := desktopViewerTunnelReadPortEnv
	if access == transport.DesktopViewerAccessWrite {
		port = desktopViewerDefaultTunnelWritePort
		portEnv = desktopViewerTunnelWritePortEnv
	}
	resolved := desktopViewerEnv(portEnv, port)
	if access == transport.DesktopViewerAccessWrite && resolved == fmt.Sprint(desktopInputPort) {
		// 原始可写端口没有输入仲裁，绝不允许被配置成绕过网关。
		resolved = desktopViewerDefaultTunnelWritePort
	}
	tunnel := transport.DesktopViewerTunnel{
		Mode: mode,
		IP:   desktopViewerEnv(desktopViewerTunnelIPEnv, desktopViewerDefaultTunnelIP),
		Port: resolved,
	}
	if mode == transport.DesktopViewerTunnelModeWS {
		tunnel.Path = desktopViewerEnv(desktopViewerTunnelPathEnv, "/desktop/connect")
	} else if access == transport.DesktopViewerAccessWrite {
		tunnel.Path = "/desktop/input"
	}
	return tunnel
}

// desktopViewerCount must be called with desktopViewerMu held.
func desktopViewerCount(instanceID string) int {
	total := 0
	for _, attachment := range desktopViewers {
		if attachment.instanceID == instanceID {
			total++
		}
	}
	return total
}

// The gateway accepts at most 30 seconds of clock skew. A possible remote
// grant keeps its reservation until even a slow gateway clock has expired it.
const desktopViewerExpirySkew = 30 * time.Second

func desktopViewerSafelyExpired(attachment *desktopViewerAttachment, now time.Time) bool {
	expiry := attachment.expiresAt
	if attachment.grantAttempted {
		expiry = expiry.Add(desktopViewerExpirySkew)
	}
	return !now.Before(expiry)
}

// sweepDesktopViewers drops safely expired leases. Caller holds desktopViewerMu.
func sweepDesktopViewers(now time.Time) {
	for id, attachment := range desktopViewers {
		if desktopViewerSafelyExpired(attachment, now) {
			delete(desktopViewers, id)
		}
	}
}

// Invalidate locally first, retaining possible remote grants until cleanup.
func revokeDesktopViewers(instanceID string) {
	desktopViewerMu.Lock()
	defer desktopViewerMu.Unlock()
	for id, attachment := range desktopViewers {
		if attachment.instanceID == instanceID {
			attachment.revoked = true
			if !attachment.grantAttempted || desktopViewerSafelyExpired(attachment, time.Now()) {
				delete(desktopViewers, id)
			}
		}
	}
}

// Caller holds the shared operation mutex across invalidation and publication.
func (l *logic) revokeDesktopViewersLocked(ctx pctx.Context, session *desktopSession) error {
	revokeDesktopViewers(session.instanceID)
	desktopViewerMu.Lock()
	pending := make([]desktopViewerAttachment, 0)
	for _, attachment := range desktopViewers {
		if attachment.instanceID == session.instanceID && attachment.revoked {
			pending = append(pending, *attachment)
		}
	}
	desktopViewerMu.Unlock()
	for _, attachment := range pending {
		if err := l.clearDesktopInputGrantLocked(ctx, session, &attachment); err != nil {
			return err
		}
		desktopViewerMu.Lock()
		delete(desktopViewers, attachment.id)
		desktopViewerMu.Unlock()
	}
	return nil
}

// hasDesktopViewer reports whether the instance still holds a live viewer
// lease. desktop/resource is observation-only and has no heartbeat, so a live
// lease is the liveness signal the idle reaper must respect.
func hasDesktopViewer(instanceID string) bool {
	now := time.Now()
	desktopViewerMu.Lock()
	defer desktopViewerMu.Unlock()
	for _, attachment := range desktopViewers {
		if attachment.instanceID == instanceID && now.Before(attachment.expiresAt) {
			return true
		}
	}
	return false
}

// preparedDesktopSession returns the session only when desktop/resource has
// finished preparing the desktop for the current owner/sandbox. inputReady
// reports whether the writable endpoint came up; when it did not, the viewer
// must degrade to the read-only observer instead of failing.
func (l *logic) preparedDesktopSession(entity *modelinstance.Entity) (*desktopSession, desktopViewerBinding, error) {
	if strings.TrimSpace(entity.SandboxId) == "" {
		return nil, desktopViewerBinding{}, errcode.ErrDesktopNotConfigured
	}
	raw, ok := desktopSessions.Load(entity.InstanceId)
	if !ok {
		return nil, desktopViewerBinding{}, errcode.ErrDesktopNotConfigured
	}
	session, ok := raw.(*desktopSession)
	if !ok {
		return nil, desktopViewerBinding{}, errcode.ErrDesktopNotConfigured
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.generation == "" || session.userID != entity.UserId || session.sandboxID != entity.SandboxId {
		return nil, desktopViewerBinding{}, errcode.ErrDesktopTargetChanged
	}
	if session.status != transport.DesktopSessionStatusReady || !session.observerPrepared || session.preparing {
		return nil, desktopViewerBinding{}, errcode.ErrDesktopNotConfigured
	}
	return session, desktopViewerBinding{
		generation: session.generation,
		sandboxID:  session.sandboxID,
		inputReady: session.inputPrepared,
	}, nil
}

// Caller holds the operation mutex, never desktopViewerMu, while loading authority.
func (l *logic) validateDesktopViewerBinding(ctx pctx.Context, session *desktopSession, userID, sandboxID, generation string) error {
	if err := l.validateDesktopViewerTarget(ctx, session, userID, sandboxID, generation); err != nil {
		return err
	}
	session.mu.Lock()
	ready := session.status == transport.DesktopSessionStatusReady && session.observerPrepared && !session.preparing
	session.mu.Unlock()
	if !ready {
		return errcode.ErrDesktopNotConfigured
	}
	return nil
}

// Cleanup requires the same authorized target, but not a ready desktop.
func (l *logic) validateDesktopViewerTarget(ctx pctx.Context, session *desktopSession, userID, sandboxID, generation string) error {
	entity, err := l.loadDesktopInstance(ctx, session.instanceID)
	if err != nil {
		return err
	}
	current, _ := desktopSessions.Load(session.instanceID)
	session.mu.Lock()
	matches := current == session && entity.UserId == userID && entity.SandboxId == sandboxID &&
		session.userID == userID && session.sandboxID == sandboxID && session.generation == generation
	session.mu.Unlock()
	if !matches {
		return errcode.ErrDesktopTargetChanged
	}
	return nil
}

// desktopViewerCountWithAccess must be called with desktopViewerMu held.
func desktopViewerCountWithAccess(instanceID, access string) int {
	total := 0
	for _, attachment := range desktopViewers {
		if attachment.instanceID == instanceID && attachment.access == access {
			total++
		}
	}
	return total
}

// CreateDesktopViewer mints a single-use viewer lease for a prepared desktop.
// The response carries neither a VNC password nor a public URL.
func (l *logic) CreateDesktopViewer(ctx pctx.Context, instanceID string) (*transport.DesktopViewerResponse, error) {
	entity, err := l.loadDesktopInstance(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	session, binding, err := l.preparedDesktopSession(entity)
	if err != nil {
		return nil, err
	}
	incarnation, err := l.verifyDesktopIncarnation(ctx, session, binding.sandboxID)
	if err != nil {
		return nil, err
	}
	binding.incarnation = incarnation

	raw := make([]byte, desktopViewerTicketBytes)
	if _, err := rand.Read(raw); err != nil {
		return nil, errcode.Wrap(errcode.ErrSandboxServiceError, "generate desktop viewer ticket: %v", err)
	}
	id, err := uuid.NewRandom()
	if err != nil {
		return nil, errcode.ErrSandboxServiceError
	}
	op := session.operationMutex()
	op.Lock()
	defer op.Unlock()
	if err := l.validateDesktopViewerBinding(ctx, session, entity.UserId, binding.sandboxID, binding.generation); err != nil {
		return nil, err
	}
	session.mu.Lock()
	binding.inputReady = session.inputPrepared
	session.mu.Unlock()
	session.touch()

	now := time.Now()
	desktopViewerMu.Lock()
	defer desktopViewerMu.Unlock()
	sweepDesktopViewers(now)
	access := transport.DesktopViewerAccessRead
	if binding.inputReady && desktopViewerCountWithAccess(entity.InstanceId, transport.DesktopViewerAccessWrite) < desktopViewerMaxWritePerInstance {
		access = transport.DesktopViewerAccessWrite
	}
	if access == transport.DesktopViewerAccessRead && desktopViewerCountWithAccess(entity.InstanceId, access) >= desktopViewerMaxPerInstance {
		return nil, errcode.ErrDesktopNotConfigured
	}
	if len(desktopViewers) >= desktopViewerMaxTotal {
		return nil, errcode.ErrDesktopNotConfigured
	}
	attachment := &desktopViewerAttachment{
		id:           id.String(),
		ticketDigest: sha256.Sum256(raw),
		instanceID:   entity.InstanceId,
		userID:       entity.UserId,
		resourceID:   entity.InstanceId,
		generationID: binding.generation,
		sandboxID:    binding.sandboxID,
		access:       access,
		incarnation:  binding.incarnation,
		createdAt:    now,
		expiresAt:    now.Add(desktopViewerTTL),
	}
	desktopViewers[attachment.id] = attachment
	return &transport.DesktopViewerResponse{
		Version:      desktopViewerVersion,
		AttachmentID: attachment.id,
		Ticket:       base64.RawURLEncoding.EncodeToString(raw),
		ResourceID:   attachment.resourceID,
		GenerationID: binding.generation,
		Access:       access,
		Incarnation:  binding.incarnation,
		ExpiresAt:    attachment.expiresAt.UnixMilli(),
		Tunnel:       desktopViewerTunnelFor(access),
	}, nil
}

// ClaimDesktopViewer redeems the one-time ticket. Redemption is what allows a
// client to open the desktop tunnel, so expiry, single use, ownership and
// generation binding are all enforced here rather than trusted from the client.
func (l *logic) ClaimDesktopViewer(ctx pctx.Context, instanceID, attachmentID string, req *transport.DesktopViewerClaimRequest) (*transport.DesktopViewerClaimResponse, error) {
	entity, err := l.loadDesktopInstance(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	if req == nil {
		return nil, errcode.ErrInvalidParam
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(req.Ticket))
	if err != nil {
		return nil, errcode.ErrInvalidParam
	}
	digest := sha256.Sum256(raw)
	current, _ := desktopSessions.Load(instanceID)
	session, ok := current.(*desktopSession)
	if !ok || session == nil {
		return nil, errcode.ErrDesktopTargetChanged
	}
	op := session.operationMutex()
	op.Lock()
	defer op.Unlock()

	desktopViewerMu.Lock()
	attachment, ok := desktopViewers[attachmentID]
	if !ok || attachment.instanceID != entity.InstanceId || attachment.userID != entity.UserId {
		desktopViewerMu.Unlock()
		return nil, errcode.ErrDesktopTargetChanged
	}
	snapshot := *attachment
	desktopViewerMu.Unlock()
	if err := l.validateDesktopViewerBinding(ctx, session, snapshot.userID, snapshot.sandboxID, snapshot.generationID); err != nil {
		return nil, err
	}

	now := time.Now()
	desktopViewerMu.Lock()
	if desktopViewers[attachmentID] != attachment || attachment.revoked || !attachment.claimedAt.IsZero() {
		desktopViewerMu.Unlock()
		return nil, errcode.ErrDesktopTargetChanged
	}
	if !now.Before(attachment.expiresAt) || now.Sub(attachment.createdAt) > desktopViewerClaimWindow {
		delete(desktopViewers, attachmentID)
		desktopViewerMu.Unlock()
		return nil, errcode.ErrDesktopTargetChanged
	}
	if subtle.ConstantTimeCompare(digest[:], attachment.ticketDigest[:]) != 1 {
		desktopViewerMu.Unlock()
		return nil, errcode.ErrDesktopTargetChanged
	}
	attachment.claimedAt = now
	snapshot = *attachment
	desktopViewerMu.Unlock()

	incarnation, err := l.verifyDesktopIncarnationLocked(ctx, session, snapshot.sandboxID)
	if err != nil {
		return nil, err
	}
	if incarnation != snapshot.incarnation {
		return nil, errcode.ErrDesktopTargetChanged
	}
	if err := l.validateDesktopViewerBinding(ctx, session, snapshot.userID, snapshot.sandboxID, snapshot.generationID); err != nil {
		return nil, err
	}
	desktopViewerMu.Lock()
	if desktopViewers[attachmentID] != attachment || attachment.revoked || !time.Now().Before(attachment.expiresAt) || ctx.Err() != nil {
		desktopViewerMu.Unlock()
		return nil, errcode.ErrDesktopTargetChanged
	}
	attachment.grantAttempted = attachment.access == transport.DesktopViewerAccessWrite
	snapshot = *attachment
	desktopViewerMu.Unlock()

	grantFailed := false
	if snapshot.grantAttempted {
		grantFailed = l.setDesktopInputGrantLocked(ctx, session, &snapshot) != nil
		if err := l.validateDesktopViewerBinding(ctx, session, snapshot.userID, snapshot.sandboxID, snapshot.generationID); err != nil {
			return nil, err
		}
		if grantFailed {
			// A transport failure may hide an applied grant. Only a confirmed,
			// attachment-scoped revoke (including a tombstone) permits read fallback.
			if err := l.clearDesktopInputGrantLocked(ctx, session, &snapshot); err != nil {
				return nil, err
			}
			desktopViewerMu.Lock()
			attachment.grantAttempted = false
			desktopViewerMu.Unlock()
		}
	}
	if err := l.validateDesktopViewerBinding(ctx, session, snapshot.userID, snapshot.sandboxID, snapshot.generationID); err != nil {
		return nil, err
	}
	desktopViewerMu.Lock()
	defer desktopViewerMu.Unlock()
	if grantFailed {
		sweepDesktopViewers(time.Now())
	}
	if desktopViewers[attachmentID] != attachment || !time.Now().Before(attachment.expiresAt) {
		return nil, errcode.ErrDesktopTargetChanged
	}
	if grantFailed {
		if desktopViewerCountWithAccess(instanceID, transport.DesktopViewerAccessRead) >= desktopViewerMaxPerInstance {
			delete(desktopViewers, attachmentID)
			return nil, errcode.ErrDesktopNotConfigured
		}
		attachment.access = transport.DesktopViewerAccessRead
	}
	return &transport.DesktopViewerClaimResponse{
		Version:      desktopViewerVersion,
		AttachmentID: attachment.id,
		ResourceID:   attachment.resourceID,
		GenerationID: attachment.generationID,
		Access:       attachment.access,
		Incarnation:  attachment.incarnation,
		ExpiresAt:    attachment.expiresAt.UnixMilli(),
		Tunnel:       desktopViewerTunnelFor(attachment.access),
	}, nil
}

// These helpers run under the operation mutex and use only the pinned session.
func (l *logic) setDesktopInputGrantLocked(ctx pctx.Context, session *desktopSession, attachment *desktopViewerAttachment) error {
	result, err := l.execDesktopInstallCommandLocked(ctx, session, attachment.sandboxID,
		renderDesktopInputGrantCommand(attachment.id, attachment.expiresAt.UnixMilli(), fmt.Sprintf("%x", attachment.ticketDigest), attachment.generationID, attachment.incarnation))
	if err != nil {
		return err
	}
	if !sandboxCommandSucceeded(result) {
		return errcode.ErrDesktopNotConfigured
	}
	return nil
}

func (l *logic) clearDesktopInputGrantLocked(ctx pctx.Context, _ *desktopSession, attachment *desktopViewerAttachment) error {
	if desktopViewerSafelyExpired(attachment, time.Now()) {
		return nil
	}
	// Reauthorize the current caller; never reuse the old owner's credentials
	// or require the old generation to remain current merely to remove its id.
	entity, err := l.loadDesktopInstance(ctx, attachment.instanceID)
	if err != nil {
		return err
	}
	if entity.SandboxId != attachment.sandboxID {
		// The sandbox was replaced: the grant lived only in the old sandbox's
		// /run/opencraft-desktop-input/grant, which is gone with it, and CTL has
		// no path left to reach it. There is nothing to revoke, so treat cleanup
		// as done rather than erroring, which would otherwise block resource
		// preparation for the whole TTL + skew window on every retry.
		return nil
	}
	result, err := l.sandboxAdapter.ExecCommand(ctx, entity.SandboxId,
		renderDesktopInputRevokeCommand(attachment.id, attachment.expiresAt.UnixMilli()), desktopProbeTimeoutS)
	if err != nil {
		return err
	}
	if !sandboxCommandSucceeded(result) {
		return errcode.ErrDesktopNotConfigured
	}
	entity, err = l.loadDesktopInstance(ctx, attachment.instanceID)
	if err != nil {
		return err
	}
	if entity.SandboxId != attachment.sandboxID {
		return errcode.ErrDesktopTargetChanged
	}
	return nil
}

// Unknown/released attachments are idempotent. A failed cleanup keeps the write
// reservation, so another viewer cannot acquire input until cleanup or expiry.
func (l *logic) ReleaseDesktopViewer(ctx pctx.Context, instanceID, attachmentID string) error {
	entity, err := l.loadDesktopInstance(ctx, instanceID)
	if err != nil {
		return err
	}
	session := l.desktopSessionOf(instanceID)
	op := session.operationMutex()
	op.Lock()
	defer op.Unlock()
	desktopViewerMu.Lock()
	attachment, ok := desktopViewers[attachmentID]
	if !ok || attachment.instanceID != entity.InstanceId {
		desktopViewerMu.Unlock()
		return nil
	}
	attachment.revoked = true
	snapshot := *attachment
	desktopViewerMu.Unlock()
	if snapshot.grantAttempted {
		if err := l.clearDesktopInputGrantLocked(ctx, session, &snapshot); err != nil {
			return err
		}
	}
	desktopViewerMu.Lock()
	if desktopViewers[attachmentID] == attachment {
		delete(desktopViewers, attachmentID)
	}
	desktopViewerMu.Unlock()
	return nil
}
