package host

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/im"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/ingress"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/platform"
	velastate "github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/state"
)

type Host struct {
	config      Config
	coordinator *ingress.Coordinator
	recovering  atomic.Bool
	resync      chan im.Conversation
}

func New(config Config) (*Host, error) {
	normalized, err := normalizeConfig(config)
	if err != nil {
		return nil, err
	}
	host := &Host{config: normalized, resync: make(chan im.Conversation, 128)}
	coordinator, err := ingress.New(ingress.Config{
		Handler: normalized.Runtime, Cursors: normalized.Cursors,
		MaxConcurrent:   normalized.MaxInFlightEvents,
		QueueSize:       normalized.IngressQueueSize,
		DeliveryTimeout: normalized.RecoveryMessageTimeout,
		ReportFailure:   host.reportIngressFailure,
	})
	if err != nil {
		return nil, err
	}
	host.coordinator = coordinator
	return host, nil
}

type sessionOutcome uint8

const (
	outcomeStopped sessionOutcome = iota
	outcomeRefresh
	outcomeFailed
)

type sessionResult struct {
	outcome          sessionOutcome
	failure          FailureReport
	recoveryComplete bool
}

func (h *Host) Run(ctx context.Context) error {
	if h == nil || ctx == nil {
		return ErrInvalidConfig
	}
	defer h.closeRuntime()
	defer h.closeCoordinator()
	ready := false

	failures := 0
	for {
		if ctx.Err() != nil {
			return nil
		}
		h.reportStartup(StartupStageRuntimeSession)
		session, err := h.createRuntimeSession(ctx)
		if err != nil {
			if errors.Is(err, platform.ErrCredentialRejected) {
				return platform.ErrCredentialRejected
			}
			failures++
			h.reportFailure(FailureStageRuntimeSession, failures, "")
			if failures >= h.config.MaxFailures {
				return ErrFailureLimit
			}
			if !wait(ctx, h.backoffDelay(failures)) {
				return nil
			}
			continue
		}
		h.reportStartup(StartupStageRuntimeBind)
		if err := h.config.Runtime.UpdateSession(session); err != nil {
			failures++
			h.reportDetailedFailure(FailureReport{
				Scope:     FailureScopeSession,
				Stage:     FailureStageRuntimeBind,
				Code:      FailureCodeRuntimeBindFailed,
				Retryable: true,
				Attempt:   failures,
			})
			if failures >= h.config.MaxFailures {
				return ErrFailureLimit
			}
			if !wait(ctx, h.backoffDelay(failures)) {
				return nil
			}
			continue
		}

		launchID, err := h.config.NewLaunchID()
		if err != nil || strings.TrimSpace(launchID) == "" {
			failures++
			h.reportFailure(FailureStageLaunchID, failures, "")
			if failures >= h.config.MaxFailures {
				return ErrFailureLimit
			}
			if !wait(ctx, h.backoffDelay(failures)) {
				return nil
			}
			continue
		}
		h.reportStartup(StartupStageTransportCreate)
		transport, err := h.config.Transports.New()
		if err != nil || transport == nil {
			failures++
			h.reportFailure(FailureStageTransportCreate, failures, "")
			if failures >= h.config.MaxFailures {
				return ErrFailureLimit
			}
			if !wait(ctx, h.backoffDelay(failures)) {
				return nil
			}
			continue
		}
		userSig, err := im.NewUserSig(session.IM.UserSig.Reveal())
		if err != nil {
			h.closeTransport(transport)
			return platform.ErrInvalidSession
		}
		h.reportStartup(StartupStageTransportStart)
		startErr := transport.Start(ctx, im.Session{
			SDKAppID: session.IM.SDKAppID,
			UserID:   session.IM.UserID,
			UserSig:  userSig,
			LaunchID: launchID,
		})
		if startErr != nil {
			h.closeTransport(transport)
			failures++
			h.reportFailure(FailureStageTransportStart, failures, "")
			if failures >= h.config.MaxFailures {
				return ErrFailureLimit
			}
			if !wait(ctx, h.backoffDelay(failures)) {
				return nil
			}
			continue
		}
		if err := h.coordinator.BeginDiscovery(); err != nil {
			h.closeTransport(transport)
			return err
		}
		h.reportStartup(StartupStageHistoryRecovery)
		h.recovering.Store(true)
		recoveryContext, cancelRecovery := context.WithCancel(ctx)
		recoveryDone := make(chan error, 1)
		go func() {
			recoveryDone <- h.recoverUnread(recoveryContext, transport, session)
		}()
		result := h.serveSession(ctx, transport, launchID, session, recoveryDone, func() {
			h.recovering.Store(false)
			h.reportStartup(StartupStageServing)
			if !ready {
				ready = true
				if h.config.ReportReady != nil {
					h.config.ReportReady()
				}
			}
		})
		cancelRecovery()
		if !result.recoveryComplete {
			_ = h.coordinator.AbortDiscovery()
			select {
			case <-recoveryDone:
			case <-time.After(h.config.ShutdownTimeout):
				return ErrShutdownTimeout
			}
		}
		h.recovering.Store(false)
		outcome := result.outcome
		if outcome != outcomeStopped && ready {
			ready = false
			if h.config.ReportUnready != nil {
				h.config.ReportUnready()
			}
		}
		switch outcome {
		case outcomeStopped:
			return nil
		case outcomeRefresh:
			failures = 0
		default:
			failures++
			if result.failure.Stage == "" {
				result.failure.Stage = FailureStageServing
			}
			result.failure.Attempt = failures
			h.reportDetailedFailure(result.failure)
			if failures >= h.config.MaxFailures {
				return ErrFailureLimit
			}
			if !wait(ctx, h.backoffDelay(failures)) {
				return nil
			}
		}
	}
}

func (h *Host) reportStartup(stage StartupStage) {
	if h.config.ReportStartup == nil {
		return
	}
	switch stage {
	case StartupStageRuntimeSession,
		StartupStageRuntimeBind,
		StartupStageTransportCreate,
		StartupStageTransportStart,
		StartupStageHistoryRecovery,
		StartupStageServing:
		h.config.ReportStartup(stage)
	}
}

func (h *Host) createRuntimeSession(
	ctx context.Context,
) (platform.RuntimeSession, error) {
	return h.config.Sessions.CreateRuntimeSession(ctx)
}

func (h *Host) reportFailure(
	stage FailureStage,
	attempt int,
	code FailureCode,
) {
	if code == "" {
		code = defaultFailureCode(stage)
	}
	h.reportDetailedFailure(FailureReport{
		Scope:     FailureScopeSession,
		Stage:     stage,
		Code:      code,
		Retryable: true,
		Attempt:   attempt,
	})
}

func (h *Host) reportDetailedFailure(report FailureReport) {
	if h.config.ReportFailure == nil {
		return
	}
	h.config.ReportFailure(safeFailureReport(report))
}

func defaultFailureCode(stage FailureStage) FailureCode {
	switch stage {
	case FailureStageRuntimeSession:
		return FailureCodeRuntimeSessionUnavailable
	case FailureStageLaunchID:
		return FailureCodeLaunchIDFailed
	case FailureStageTransportCreate:
		return FailureCodeTransportCreateFailed
	case FailureStageTransportStart:
		return FailureCodeTransportStartFailed
	default:
		return FailureCodeServingUnknown
	}
}

func recoveryFailureCode(err error) FailureCode {
	switch {
	case errors.Is(err, ErrRecoveryStalled), errors.Is(err, ErrRecoverySnapshotIncomplete):
		return FailureCodeRecoveryStalled
	case errors.Is(err, ErrRecoveryInvalidPage):
		return FailureCodeRecoveryInvalidPage
	default:
		return FailureCodeRecoveryTransport
	}
}

type recoveryDispatchError struct {
	report FailureReport
	cause  error
}

var errRecoveryDeliveryBlocked = errors.New("Vela history delivery blocked")

func (e *recoveryDispatchError) Error() string {
	return e.report.String()
}

func (e *recoveryDispatchError) Unwrap() error {
	return e.cause
}

func recoveryFailureReport(err error, attempt int) FailureReport {
	var dispatchError *recoveryDispatchError
	if errors.As(err, &dispatchError) && dispatchError != nil {
		report := dispatchError.report
		report.Stage = FailureStageHistoryRecovery
		report.Attempt = attempt
		return safeFailureReport(report)
	}
	return safeFailureReport(FailureReport{
		Scope:     FailureScopeSession,
		Stage:     FailureStageHistoryRecovery,
		Code:      recoveryFailureCode(err),
		Retryable: true,
		Attempt:   attempt,
	})
}

func (h *Host) recoverUnread(
	ctx context.Context,
	transport im.Transport,
	session platform.RuntimeSession,
) error {
	history, ok := transport.(im.HistoryTransport)
	if !ok {
		return nil
	}
	conversations, err := history.UnreadConversations(ctx)
	if err != nil {
		return err
	}
	attemptedConversations := make(map[im.Conversation]struct{}, len(conversations))
	for _, unread := range conversations {
		if !unread.Conversation.Valid() ||
			unread.UnreadCount <= 0 {
			h.markRecoveryGap(unread.Conversation, velastate.GapRecoveryStalled)
			continue
		}
		attemptedConversations[unread.Conversation] = struct{}{}
		if checkpoint, exists := h.config.Cursors.Get(unread.Conversation); exists {
			if checkpoint.Conversation.Kind() == im.ConversationC2C {
				_, incomingCount, boundaryFound, recoveryErr := h.recoverC2CFromCursorForUser(
					ctx, history, checkpoint, session.IM.UserID,
				)
				if errors.Is(recoveryErr, errRecoveryDeliveryBlocked) {
					continue
				}
				if recoveryErr != nil {
					if errors.Is(recoveryErr, ErrRecoveryStalled) || errors.Is(recoveryErr, ErrRecoveryInvalidPage) {
						h.markRecoveryGap(unread.Conversation, velastate.GapRecoveryStalled)
						continue
					}
					return recoveryErr
				}
				if !boundaryFound {
					h.markRecoveryGap(unread.Conversation, velastate.GapHistoryExpired)
					continue
				}
				if incomingCount < unread.UnreadCount {
					return ErrRecoverySnapshotIncomplete
				}
				if err := history.MarkRead(ctx, unread.Conversation); err != nil {
					return err
				}
				continue
			}
			_, incomingCount, recoveryErr := h.recoverOrderedFromCursorForUser(
				ctx, history, checkpoint, session.IM.UserID,
			)
			if errors.Is(recoveryErr, errRecoveryDeliveryBlocked) {
				continue
			}
			if recoveryErr != nil {
				if errors.Is(recoveryErr, ErrRecoveryStalled) || errors.Is(recoveryErr, ErrRecoveryInvalidPage) {
					h.markRecoveryGap(unread.Conversation, velastate.GapRecoveryStalled)
					continue
				}
				return recoveryErr
			}
			if incomingCount < unread.UnreadCount {
				return ErrRecoverySnapshotIncomplete
			}
			if err := history.MarkRead(ctx, unread.Conversation); err != nil {
				return err
			}
			continue
		}
		deliveredCount, complete, err := h.recoverUnreadSuffix(
			ctx, history, unread, session.IM.UserID,
		)
		if err != nil {
			if errors.Is(err, errRecoveryDeliveryBlocked) {
				continue
			}
			if errors.Is(err, ErrRecoveryStalled) || errors.Is(err, ErrRecoveryInvalidPage) {
				h.markRecoveryGap(unread.Conversation, velastate.GapRecoveryStalled)
				continue
			}
			return err
		}
		if !complete || deliveredCount < unread.UnreadCount {
			h.markRecoveryGap(unread.Conversation, velastate.GapHistoryExpired)
			continue
		}
		if err := history.MarkRead(
			ctx,
			unread.Conversation,
		); err != nil {
			return err
		}
	}
	for _, gap := range h.config.Cursors.ListGaps() {
		if _, attempted := attemptedConversations[gap.Conversation]; attempted {
			continue
		}
		if gap.FirstUnconsumed == nil {
			continue
		}
		attemptedConversations[gap.Conversation] = struct{}{}
		deliveredCount, _, boundaryFound, recoveryErr := h.recoverFromBoundary(
			ctx,
			history,
			gap.Conversation,
			gap.FirstUnconsumed.MessageID,
			"",
			true,
		)
		if errors.Is(recoveryErr, errRecoveryDeliveryBlocked) {
			continue
		}
		if recoveryErr != nil {
			if errors.Is(recoveryErr, ErrRecoveryStalled) || errors.Is(recoveryErr, ErrRecoveryInvalidPage) {
				h.markRecoveryGap(gap.Conversation, velastate.GapRecoveryStalled)
				continue
			}
			return recoveryErr
		}
		if !boundaryFound {
			h.markRecoveryGap(gap.Conversation, velastate.GapHistoryExpired)
			continue
		}
		if deliveredCount > 0 {
			if err := history.MarkRead(ctx, gap.Conversation); err != nil {
				return err
			}
		}
	}
	for _, cursor := range h.config.Cursors.List() {
		if _, alreadyAttempted := attemptedConversations[cursor.Conversation]; alreadyAttempted {
			continue
		}
		if cursor.Conversation.Kind() == im.ConversationC2C {
			deliveredCount, boundaryFound, err := h.recoverC2CFromCursor(
				ctx, history, cursor,
			)
			if errors.Is(err, errRecoveryDeliveryBlocked) {
				continue
			}
			if err != nil {
				if errors.Is(err, ErrRecoveryStalled) || errors.Is(err, ErrRecoveryInvalidPage) {
					h.markRecoveryGap(cursor.Conversation, velastate.GapRecoveryStalled)
					continue
				}
				return err
			}
			if !boundaryFound {
				h.markRecoveryGap(cursor.Conversation, velastate.GapHistoryExpired)
				continue
			}
			if deliveredCount > 0 {
				if err := history.MarkRead(ctx, cursor.Conversation); err != nil {
					return err
				}
			}
			continue
		}
		deliveredCount, err := h.recoverOrderedFromCursor(ctx, history, cursor)
		if errors.Is(err, errRecoveryDeliveryBlocked) {
			continue
		}
		if err != nil {
			if errors.Is(err, ErrRecoveryStalled) || errors.Is(err, ErrRecoveryInvalidPage) {
				h.markRecoveryGap(cursor.Conversation, velastate.GapRecoveryStalled)
				continue
			}
			return err
		}
		if deliveredCount > 0 {
			if err := history.MarkRead(ctx, cursor.Conversation); err != nil {
				return err
			}
		}
	}
	return nil
}

type c2cHistoryAnchor struct {
	requestCursor string
	messageIDs    []string
	boundaryIndex int
}

func (h *Host) recoverUnreadSuffix(
	ctx context.Context,
	history im.HistoryTransport,
	unread im.UnreadConversation,
	selfUserID string,
) (int, bool, error) {
	requestCursor := ""
	seenCursors := make(map[string]struct{})
	seenMessages := make(map[string]struct{})
	anchors := make([]c2cHistoryAnchor, 0, 8)
	var firstPage *im.HistoryPage
	found := false
	incomingCount := 0
	for {
		page, err := history.History(ctx, im.HistoryRequest{
			Conversation: unread.Conversation, Cursor: requestCursor,
		})
		if err != nil {
			return 0, false, err
		}
		anchor := c2cHistoryAnchor{
			requestCursor: requestCursor, boundaryIndex: -1,
			messageIDs: make([]string, 0, len(page.Messages)),
		}
		for index, message := range page.Messages {
			if message.Ref.Conversation() != unread.Conversation {
				return 0, false, ErrRecoveryInvalidPage
			}
			messageID := message.Ref.MessageID()
			anchor.messageIDs = append(anchor.messageIDs, messageID)
			if _, duplicate := seenMessages[messageID]; duplicate {
				continue
			}
			seenMessages[messageID] = struct{}{}
			if message.SenderUserID != selfUserID {
				incomingCount++
				if incomingCount == unread.UnreadCount {
					anchor.boundaryIndex = index
					found = true
				}
			}
		}
		anchors = append(anchors, anchor)
		if len(anchors) == 1 {
			copy := page
			copy.Messages = append([]im.IncomingMessage(nil), page.Messages...)
			firstPage = &copy
		}
		if found || page.Completed {
			break
		}
		if page.NextCursor == "" || page.NextCursor == requestCursor {
			return 0, false, ErrRecoveryStalled
		}
		if _, duplicate := seenCursors[page.NextCursor]; duplicate {
			return 0, false, ErrRecoveryStalled
		}
		seenCursors[page.NextCursor] = struct{}{}
		requestCursor = page.NextCursor
	}
	if !found {
		return 0, false, nil
	}
	deliveredIDs := make(map[string]struct{})
	incomingDelivered := 0
	for anchorIndex := len(anchors) - 1; anchorIndex >= 0; anchorIndex-- {
		anchor := anchors[anchorIndex]
		var page im.HistoryPage
		if anchorIndex == 0 {
			page = *firstPage
		} else {
			var err error
			page, err = history.History(ctx, im.HistoryRequest{
				Conversation: unread.Conversation, Cursor: anchor.requestCursor,
			})
			if err != nil {
				return incomingDelivered, true, err
			}
		}
		if !sameMessageIDs(page.Messages, anchor.messageIDs) {
			return incomingDelivered, true, ErrRecoveryStalled
		}
		limit := len(page.Messages)
		if anchor.boundaryIndex >= 0 {
			limit = anchor.boundaryIndex + 1
		}
		for messageIndex := limit - 1; messageIndex >= 0; messageIndex-- {
			message := page.Messages[messageIndex]
			messageID := message.Ref.MessageID()
			if _, duplicate := deliveredIDs[messageID]; duplicate {
				continue
			}
			delivered, err := h.dispatchRecovered(ctx, []im.IncomingMessage{message})
			if err != nil {
				return incomingDelivered, true, err
			}
			if !delivered {
				return incomingDelivered, true, errRecoveryDeliveryBlocked
			}
			deliveredIDs[messageID] = struct{}{}
			if message.SenderUserID != selfUserID {
				incomingDelivered++
			}
		}
	}
	return incomingDelivered, true, nil
}

func (h *Host) recoverC2CFromCursor(
	ctx context.Context,
	history im.HistoryTransport,
	checkpoint velastate.MessageCursor,
) (int, bool, error) {
	if checkpoint.Conversation.Kind() != im.ConversationC2C {
		return 0, false, ErrRecoveryInvalidPage
	}
	deliveredCount, _, boundaryFound, err := h.recoverFromBoundary(
		ctx, history, checkpoint.Conversation, checkpoint.MessageID, "", false,
	)
	return deliveredCount, boundaryFound, err
}

func (h *Host) recoverC2CFromCursorForUser(
	ctx context.Context,
	history im.HistoryTransport,
	checkpoint velastate.MessageCursor,
	selfUserID string,
) (int, int, bool, error) {
	if checkpoint.Conversation.Kind() != im.ConversationC2C || strings.TrimSpace(selfUserID) == "" {
		return 0, 0, false, ErrRecoveryInvalidPage
	}
	return h.recoverFromBoundary(
		ctx, history, checkpoint.Conversation, checkpoint.MessageID, selfUserID, false,
	)
}

// recoverFromBoundary replays Tencent history in chronological order. When
// inclusive is true, the boundary itself is the first unconsumed message and
// must be delivered; cursor recovery uses exclusive mode.
func (h *Host) recoverFromBoundary(
	ctx context.Context,
	history im.HistoryTransport,
	conversation im.Conversation,
	boundaryMessageID string,
	selfUserID string,
	inclusive bool,
) (int, int, bool, error) {
	if !conversation.Valid() || strings.TrimSpace(boundaryMessageID) == "" {
		return 0, 0, false, ErrRecoveryInvalidPage
	}
	requestCursor := ""
	seenCursors := make(map[string]struct{})
	anchors := make([]c2cHistoryAnchor, 0, 8)
	var firstPage *im.HistoryPage
	boundaryFound := false
	for {
		page, err := history.History(ctx, im.HistoryRequest{
			Conversation: conversation, Cursor: requestCursor,
		})
		if err != nil {
			return 0, 0, false, err
		}
		anchor := c2cHistoryAnchor{
			requestCursor: requestCursor, boundaryIndex: -1,
			messageIDs: make([]string, 0, len(page.Messages)),
		}
		for index, message := range page.Messages {
			if message.Ref.Conversation() != conversation {
				return 0, 0, false, ErrRecoveryInvalidPage
			}
			messageID := message.Ref.MessageID()
			anchor.messageIDs = append(anchor.messageIDs, messageID)
			if messageID == boundaryMessageID {
				anchor.boundaryIndex = index
				boundaryFound = true
			}
		}
		anchors = append(anchors, anchor)
		if len(anchors) == 1 {
			copy := page
			copy.Messages = append([]im.IncomingMessage(nil), page.Messages...)
			firstPage = &copy
		}
		if boundaryFound || page.Completed {
			break
		}
		if page.NextCursor == "" || page.NextCursor == requestCursor {
			return 0, 0, false, ErrRecoveryStalled
		}
		if _, duplicate := seenCursors[page.NextCursor]; duplicate {
			return 0, 0, false, ErrRecoveryStalled
		}
		seenCursors[page.NextCursor] = struct{}{}
		requestCursor = page.NextCursor
	}
	if !boundaryFound {
		return 0, 0, false, nil
	}
	deliveredIDs := make(map[string]struct{})
	deliveredCount := 0
	incomingCount := 0
	for anchorIndex := len(anchors) - 1; anchorIndex >= 0; anchorIndex-- {
		anchor := anchors[anchorIndex]
		var page im.HistoryPage
		if anchorIndex == 0 {
			page = *firstPage
		} else {
			var err error
			page, err = history.History(ctx, im.HistoryRequest{
				Conversation: conversation, Cursor: anchor.requestCursor,
			})
			if err != nil {
				return deliveredCount, incomingCount, true, err
			}
		}
		if !sameMessageIDs(page.Messages, anchor.messageIDs) {
			return deliveredCount, incomingCount, true, ErrRecoveryStalled
		}
		limit := len(page.Messages)
		if anchor.boundaryIndex >= 0 {
			limit = anchor.boundaryIndex
			if inclusive {
				limit++
			}
		}
		for messageIndex := limit - 1; messageIndex >= 0; messageIndex-- {
			message := page.Messages[messageIndex]
			messageID := message.Ref.MessageID()
			if _, duplicate := deliveredIDs[messageID]; duplicate {
				continue
			}
			delivered, err := h.dispatchRecovered(ctx, []im.IncomingMessage{message})
			if err != nil {
				return deliveredCount, incomingCount, true, err
			}
			if !delivered {
				return deliveredCount, incomingCount, true, errRecoveryDeliveryBlocked
			}
			deliveredIDs[messageID] = struct{}{}
			deliveredCount++
			if selfUserID == "" || message.SenderUserID != selfUserID {
				incomingCount++
			}
		}
	}
	return deliveredCount, incomingCount, true, nil
}

func sameMessageIDs(messages []im.IncomingMessage, expected []string) bool {
	if len(messages) != len(expected) {
		return false
	}
	for index, message := range messages {
		if message.Ref.MessageID() != expected[index] {
			return false
		}
	}
	return true
}

func (h *Host) markRecoveryGap(conversation im.Conversation, code velastate.GapCode) {
	if !conversation.Valid() {
		return
	}
	cursor, exists := h.config.Cursors.Get(conversation)
	var expected *velastate.MessageCursor
	if exists {
		expected = &cursor
	}
	_, _ = h.config.Cursors.MarkGap(conversation, expected, nil, velastate.GapDiagnostic{
		Code: code, DetectedAt: time.Now().UTC(),
	})
	failureCode := FailureCodeRecoveryStalled
	if code == velastate.GapHistoryExpired {
		failureCode = FailureCodeRecoveryHistoryExpired
	}
	report := FailureReport{
		Scope: FailureScopeMessage, Stage: FailureStageHistoryRecovery,
		Code: failureCode, Retryable: true, Attempt: 1,
		ConversationKind: conversation.Kind(),
	}
	if expected != nil {
		report.MessageID = expected.MessageID
	}
	h.reportDetailedFailure(report)
}

func (h *Host) recoverOrderedFromCursor(
	ctx context.Context,
	history im.HistoryTransport,
	checkpoint velastate.MessageCursor,
) (int, error) {
	deliveredCount, _, err := h.recoverOrderedFromCursorForUser(ctx, history, checkpoint, "")
	return deliveredCount, err
}

func (h *Host) recoverOrderedFromCursorForUser(
	ctx context.Context,
	history im.HistoryTransport,
	checkpoint velastate.MessageCursor,
	selfUserID string,
) (int, int, error) {
	if checkpoint.Conversation.Kind() == im.ConversationC2C {
		return 0, 0, ErrRecoveryInvalidPage
	}
	cursor := ""
	seenCursors := map[string]struct{}{}
	seenMessages := make(map[string]struct{})
	deliveredCount := 0
	incomingCount := 0
	lastSequence := checkpoint.Sequence
	for {
		page, err := history.History(ctx, im.HistoryRequest{
			Conversation: checkpoint.Conversation, Cursor: cursor,
			AfterSequence: checkpoint.Sequence,
		})
		if err != nil {
			return deliveredCount, incomingCount, err
		}
		messages := append([]im.IncomingMessage(nil), page.Messages...)
		sort.SliceStable(messages, func(left, right int) bool {
			return messages[left].Ref.Sequence() < messages[right].Ref.Sequence()
		})
		for _, message := range messages {
			if message.Ref.Conversation() != checkpoint.Conversation {
				return deliveredCount, incomingCount, ErrRecoveryInvalidPage
			}
			messageID := message.Ref.MessageID()
			if _, duplicate := seenMessages[messageID]; duplicate {
				continue
			}
			seenMessages[messageID] = struct{}{}
			sequence := message.Ref.Sequence()
			if sequence <= checkpoint.Sequence {
				continue
			}
			if sequence <= lastSequence {
				return deliveredCount, incomingCount, ErrRecoveryStalled
			}
			delivered, dispatchErr := h.dispatchRecovered(ctx, []im.IncomingMessage{message})
			if dispatchErr != nil {
				return deliveredCount, incomingCount, dispatchErr
			}
			if !delivered {
				return deliveredCount, incomingCount, errRecoveryDeliveryBlocked
			}
			lastSequence = sequence
			deliveredCount++
			if selfUserID == "" || message.SenderUserID != selfUserID {
				incomingCount++
			}
		}
		if page.Completed {
			break
		}
		if page.NextCursor == "" || page.NextCursor == cursor {
			return deliveredCount, incomingCount, ErrRecoveryStalled
		}
		if _, duplicate := seenCursors[page.NextCursor]; duplicate {
			return deliveredCount, incomingCount, ErrRecoveryStalled
		}
		seenCursors[page.NextCursor] = struct{}{}
		cursor = page.NextCursor
	}
	return deliveredCount, incomingCount, nil
}

func (h *Host) dispatchRecovered(
	ctx context.Context,
	messages []im.IncomingMessage,
) (bool, error) {
	for _, message := range messages {
		err := h.coordinator.Recover(ctx, message)
		if err == nil {
			continue
		}
		if ctx.Err() != nil {
			return false, ctx.Err()
		}
		report := messageFailure(message, err)
		report.Stage = FailureStageHistoryRecovery
		report.Attempt = 1
		if errors.Is(err, context.DeadlineExceeded) {
			report.Scope = FailureScopeMessage
			report.Code = FailureCodeMessageHandlerTimeout
			report.Retryable = true
		}
		if report.Scope == FailureScopeMessage {
			h.reportDetailedFailure(report)
			return false, nil
		}
		return false, &recoveryDispatchError{
			report: report,
			cause:  err,
		}
	}
	return true, nil
}

func (h *Host) serveSession(
	ctx context.Context,
	transport im.Transport,
	launchID string,
	session platform.RuntimeSession,
	recoveryDone <-chan error,
	onReady func(),
) sessionResult {
	resyncContext, cancelResync := context.WithCancel(ctx)
	defer cancelResync()
	resyncDone := make(chan im.Conversation, h.config.MaxInFlightEvents)
	resyncSem := make(chan struct{}, h.config.MaxInFlightEvents)
	resyncActive := make(map[string]struct{})
	var resyncWork sync.WaitGroup
	refreshAt := session.ExpiresAt
	if session.IM.ExpiresAt.Before(refreshAt) {
		refreshAt = session.IM.ExpiresAt
	}
	refreshDelay := time.Until(refreshAt.Add(-h.config.RefreshBefore))
	if refreshDelay < 0 {
		refreshDelay = 0
	}
	refreshTimer := time.NewTimer(refreshDelay)
	defer refreshTimer.Stop()

	result := sessionResult{
		outcome: outcomeFailed,
		failure: FailureReport{
			Scope:     FailureScopeSession,
			Code:      FailureCodeServingUnknown,
			Retryable: true,
		},
	}
sessionLoop:
	for {
		select {
		case <-ctx.Done():
			result.outcome = outcomeStopped
			break sessionLoop
		case <-refreshTimer.C:
			result.outcome = outcomeRefresh
			break sessionLoop
		case recoveryErr := <-recoveryDone:
			recoveryDone = nil
			if recoveryErr != nil {
				result.outcome = outcomeFailed
				result.failure = recoveryFailureReport(recoveryErr, 1)
				break sessionLoop
			}
			if err := h.config.Cursors.MarkInitialized(); err != nil {
				result.outcome = outcomeFailed
				result.failure = recoveryFailureReport(err, 1)
				break sessionLoop
			}
			if err := h.coordinator.EndDiscovery(); err != nil {
				result.outcome = outcomeFailed
				result.failure = recoveryFailureReport(err, 1)
				break sessionLoop
			}
			result.recoveryComplete = true
			if onReady != nil {
				onReady()
			}
		case conversation := <-h.resync:
			if !result.recoveryComplete {
				continue
			}
			history, ok := transport.(im.HistoryTransport)
			if !ok || !conversation.Valid() {
				continue
			}
			key := hostConversationKey(conversation)
			if _, active := resyncActive[key]; active {
				continue
			}
			resyncActive[key] = struct{}{}
			resyncWork.Add(1)
			go func() {
				defer resyncWork.Done()
				select {
				case resyncSem <- struct{}{}:
					defer func() { <-resyncSem }()
				case <-resyncContext.Done():
					return
				}
				h.recoverConversationNow(resyncContext, history, conversation, session.IM.UserID)
				select {
				case resyncDone <- conversation:
				case <-resyncContext.Done():
				}
			}()
		case conversation := <-resyncDone:
			delete(resyncActive, hostConversationKey(conversation))
		case event, ok := <-transport.Events():
			if !ok {
				result.outcome = outcomeFailed
				result.failure = FailureReport{
					Scope:     FailureScopeSession,
					Code:      FailureCodeTransportEventsClosed,
					Retryable: true,
				}
				break sessionLoop
			}
			if event.LaunchID != launchID {
				continue
			}
			switch event.Type {
			case im.EventUserSigExpiring:
				result.outcome = outcomeRefresh
				break sessionLoop
			case im.EventMessage:
				if event.Message == nil {
					result.outcome = outcomeFailed
					result.failure = FailureReport{
						Scope:     FailureScopeMessage,
						Code:      FailureCodeMessageEventInvalid,
						Retryable: true,
					}
					break sessionLoop
				}
				switch submitted := h.coordinator.Submit(*event.Message); submitted {
				case ingress.SubmitAccepted:
				case ingress.SubmitNeedsResync:
					h.reportDetailedFailure(FailureReport{
						Scope: FailureScopeMessage, Stage: FailureStageServing,
						Code: FailureCodeMessageHandlerFailed, Retryable: true, Attempt: 1,
						MessageID:        event.Message.Ref.MessageID(),
						ConversationKind: event.Message.Ref.Conversation().Kind(),
					})
					select {
					case h.resync <- event.Message.Ref.Conversation():
					default:
					}
				default:
					result.outcome = outcomeFailed
					result.failure = FailureReport{
						Scope: FailureScopeMessage, Code: FailureCodeMessageEventInvalid,
						Retryable: true,
					}
					break sessionLoop
				}
			case im.EventKickedOut:
				if event.Code == "usersig_expired" {
					result.outcome = outcomeRefresh
				} else {
					result.outcome = outcomeFailed
					result.failure = FailureReport{
						Scope:     FailureScopeIdentity,
						Code:      kickedOutFailureCode(event.Reason),
						Retryable: true,
					}
				}
				break sessionLoop
			case im.EventLoginFailed:
				result.outcome = outcomeFailed
				result.failure = FailureReport{
					Scope:     FailureScopeSession,
					Code:      FailureCodeTransportLoginFailed,
					Retryable: true,
				}
				break sessionLoop
			case im.EventStopped:
				result.outcome = outcomeFailed
				result.failure = FailureReport{
					Scope:     FailureScopeSession,
					Code:      FailureCodeTransportStopped,
					Retryable: true,
				}
				break sessionLoop
			case im.EventSDKError:
				if !event.Retryable {
					result.outcome = outcomeFailed
					result.failure = FailureReport{
						Scope:     FailureScopeSession,
						Code:      FailureCodeSDKErrorNonRetryable,
						Retryable: true,
					}
					break sessionLoop
				}
			}
		}
	}

	cancelResync()
	h.closeTransport(transport)
	resyncStopped := make(chan struct{})
	go func() {
		resyncWork.Wait()
		close(resyncStopped)
	}()
	select {
	case <-resyncStopped:
	case <-time.After(h.config.ShutdownTimeout):
		result.outcome = outcomeFailed
		result.failure = FailureReport{
			Scope: FailureScopeSession, Stage: FailureStageServing,
			Code: FailureCodeServingUnknown, Retryable: true,
		}
	}
	return result
}

func messageFailure(
	message im.IncomingMessage,
	err error,
) FailureReport {
	failure, ok := DescribeFailure(err)
	if !ok {
		failure = Failure{
			Scope:     FailureScopeMessage,
			Code:      FailureCodeMessageHandlerFailed,
			Retryable: true,
		}
	}
	return safeFailureReport(FailureReport{
		Scope:            failure.Scope,
		Code:             failure.Code,
		Retryable:        failure.Retryable,
		MessageID:        message.Ref.MessageID(),
		ConversationKind: message.Ref.Conversation().Kind(),
	})
}

func (h *Host) reportIngressFailure(failure ingress.Failure) {
	if h == nil || h.recovering.Load() {
		return
	}
	report := messageFailure(failure.Message, failure.Err)
	switch failure.Code {
	case velastate.GapRuntimeTimeout:
		report.Code = FailureCodeMessageHandlerTimeout
	case velastate.GapQueueOverflow:
		report.Code = FailureCodeMessageQueueOverflow
	case velastate.GapCursorWriteFailed:
		report.Code = FailureCodeMessageCursorWriteFailed
	}
	report.Stage = FailureStageServing
	report.Attempt = 1
	h.reportDetailedFailure(report)
	select {
	case h.resync <- failure.Message.Ref.Conversation():
	default:
	}
}

func (h *Host) recoverConversationNow(
	ctx context.Context,
	history im.HistoryTransport,
	conversation im.Conversation,
	selfUserID string,
) {
	checkpoint, exists := h.config.Cursors.Get(conversation)
	if exists {
		if conversation.Kind() == im.ConversationC2C {
			count, found, err := h.recoverC2CFromCursor(ctx, history, checkpoint)
			if errors.Is(err, errRecoveryDeliveryBlocked) {
				return
			}
			if err != nil {
				h.markRecoveryGap(conversation, velastate.GapRecoveryStalled)
				return
			}
			if !found {
				h.markRecoveryGap(conversation, velastate.GapHistoryExpired)
				return
			}
			if count > 0 {
				_ = history.MarkRead(ctx, conversation)
			}
			return
		}
		count, err := h.recoverOrderedFromCursor(ctx, history, checkpoint)
		if err != nil {
			h.markRecoveryGap(conversation, velastate.GapRecoveryStalled)
			return
		}
		if count > 0 {
			_ = history.MarkRead(ctx, conversation)
		}
		return
	}
	unreadConversations, err := history.UnreadConversations(ctx)
	if err != nil {
		return
	}
	for _, unread := range unreadConversations {
		if unread.Conversation != conversation || unread.UnreadCount <= 0 {
			continue
		}
		count, complete, recoveryErr := h.recoverUnreadSuffix(ctx, history, unread, selfUserID)
		if recoveryErr == nil && complete && count >= unread.UnreadCount {
			_ = history.MarkRead(ctx, conversation)
		} else if recoveryErr == nil && !complete {
			h.markRecoveryGap(conversation, velastate.GapHistoryExpired)
		}
		return
	}
}

func hostConversationKey(conversation im.Conversation) string {
	return string(conversation.Kind()) + "\x00" + conversation.PeerUserID() + "\x00" +
		conversation.GroupID() + "\x00" + conversation.TopicID()
}

func kickedOutFailureCode(reason string) FailureCode {
	switch reason {
	case string(FailureCodeKickedOutMultAccount):
		return FailureCodeKickedOutMultAccount
	case string(FailureCodeKickedOutMultDevice):
		return FailureCodeKickedOutMultDevice
	case string(FailureCodeKickedOutUserSigExpired):
		return FailureCodeKickedOutUserSigExpired
	case string(FailureCodeKickedOutRESTAPI):
		return FailureCodeKickedOutRESTAPI
	default:
		return FailureCodeKickedOutUnknown
	}
}

func (h *Host) backoffDelay(failures int) time.Duration {
	delay := h.config.BackoffBase
	for step := 1; step < failures; step++ {
		if delay >= h.config.BackoffMax/2 {
			return h.config.BackoffMax
		}
		delay *= 2
	}
	if delay > h.config.BackoffMax {
		return h.config.BackoffMax
	}
	return delay
}

func wait(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (h *Host) closeTransport(transport im.Transport) {
	ctx, cancel := context.WithTimeout(
		context.Background(),
		h.config.ShutdownTimeout,
	)
	defer cancel()
	_ = transport.Close(ctx)
}

func (h *Host) closeRuntime() {
	ctx, cancel := context.WithTimeout(
		context.Background(),
		h.config.ShutdownTimeout,
	)
	defer cancel()
	_ = h.config.Runtime.Close(ctx)
}

func (h *Host) closeCoordinator() {
	ctx, cancel := context.WithTimeout(context.Background(), h.config.ShutdownTimeout)
	defer cancel()
	_ = h.coordinator.Close(ctx)
}
