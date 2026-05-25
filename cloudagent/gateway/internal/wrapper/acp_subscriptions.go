package wrapper

import (
	"sync"
	"time"
)

const maxACPReplayBufferedUpdates = 256
const acpSubscriberWriteTimeout = 2 * time.Second

func (g *ACPGateway) subscribeSession(scope Scope, sessionID string, ws *WSConn, appEnvelope bool) {
	g.subscribeSessionWithReplayBuffer(scope, sessionID, ws, appEnvelope, false)
}

func (g *ACPGateway) subscribeSessionForReplay(scope Scope, sessionID string, ws *WSConn, appEnvelope bool) {
	g.subscribeSessionWithReplayBuffer(scope, sessionID, ws, appEnvelope, true)
}

func (g *ACPGateway) subscribeSessionWithReplayBuffer(scope Scope, sessionID string, ws *WSConn, appEnvelope bool, replayBuffering bool) {
	if sessionID == "" || ws == nil {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	session, ok := g.sessions[sessionID]
	if !ok || !sameScope(scope, session.Scope) {
		return
	}
	if g.subscribers == nil {
		g.subscribers = map[string]map[*WSConn]acpSessionSubscriber{}
	}
	if g.subscribers[sessionID] == nil {
		g.subscribers[sessionID] = map[*WSConn]acpSessionSubscriber{}
	}
	subscriber := g.subscribers[sessionID][ws]
	subscriber.WS = ws
	subscriber.AppEnvelope = appEnvelope
	subscriber.Scope = scope
	subscriber.ReplayBuffering = replayBuffering
	if !replayBuffering {
		subscriber.ReplayBuffer = nil
		subscriber.ReplayDropped = 0
	}
	g.subscribers[sessionID][ws] = subscriber
}

func (g *ACPGateway) unsubscribeWS(ws *WSConn) {
	if ws == nil {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	for sessionID, subscribers := range g.subscribers {
		delete(subscribers, ws)
		if len(subscribers) == 0 {
			delete(g.subscribers, sessionID)
		}
	}
}

func (g *ACPGateway) subscriberTargets(scope Scope, sessionID string, primary *WSConn, primaryEnvelope bool) []acpSessionSubscriber {
	g.mu.Lock()
	defer g.mu.Unlock()
	targets := make([]acpSessionSubscriber, 0, len(g.subscribers[sessionID])+1)
	seen := map[*WSConn]struct{}{}
	for ws, subscriber := range g.subscribers[sessionID] {
		if ws == nil || !sameScope(scope, subscriber.Scope) {
			continue
		}
		targets = append(targets, subscriber)
		seen[ws] = struct{}{}
	}
	if primary != nil {
		if _, ok := seen[primary]; !ok {
			targets = append(targets, acpSessionSubscriber{
				WS:          primary,
				AppEnvelope: primaryEnvelope,
				Scope:       scope,
			})
		}
	}
	return targets
}

func (g *ACPGateway) removeSubscriber(sessionID string, ws *WSConn) {
	if sessionID == "" || ws == nil {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if subscribers := g.subscribers[sessionID]; subscribers != nil {
		delete(subscribers, ws)
		if len(subscribers) == 0 {
			delete(g.subscribers, sessionID)
		}
	}
}

func (g *ACPGateway) bufferReplayUpdate(sessionID string, ws *WSConn, params map[string]any) bool {
	if sessionID == "" || ws == nil {
		return false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	subscriber, ok := g.subscribers[sessionID][ws]
	if !ok || !subscriber.ReplayBuffering {
		return false
	}
	if len(subscriber.ReplayBuffer) >= maxACPReplayBufferedUpdates {
		copy(subscriber.ReplayBuffer, subscriber.ReplayBuffer[1:])
		subscriber.ReplayBuffer[len(subscriber.ReplayBuffer)-1] = params
		subscriber.ReplayDropped++
		g.subscribers[sessionID][ws] = subscriber
		return true
	}
	subscriber.ReplayBuffer = append(subscriber.ReplayBuffer, params)
	g.subscribers[sessionID][ws] = subscriber
	return true
}

func (g *ACPGateway) flushReplayBufferedUpdates(sessionID string, ws *WSConn, appEnvelope bool) error {
	for {
		buffered, dropped, ok := g.popReplayBuffer(sessionID, ws)
		if !ok {
			return nil
		}
		if dropped > 0 {
			if err := g.writeNotification(ws, appEnvelope, cloudAgentReplayGapMethod, cloudAgentReplayGapParams(sessionID, dropped)); err != nil {
				g.removeSubscriber(sessionID, ws)
				return err
			}
		}
		if len(buffered) == 0 {
			return nil
		}
		for _, params := range buffered {
			if err := g.writeNotification(ws, appEnvelope, "session/update", params); err != nil {
				g.removeSubscriber(sessionID, ws)
				return err
			}
		}
	}
}

func (g *ACPGateway) popReplayBuffer(sessionID string, ws *WSConn) ([]map[string]any, int, bool) {
	if sessionID == "" || ws == nil {
		return nil, 0, false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	subscriber, ok := g.subscribers[sessionID][ws]
	if !ok {
		return nil, 0, false
	}
	if len(subscriber.ReplayBuffer) == 0 {
		dropped := subscriber.ReplayDropped
		subscriber.ReplayBuffering = false
		subscriber.ReplayBuffer = nil
		subscriber.ReplayDropped = 0
		g.subscribers[sessionID][ws] = subscriber
		return nil, dropped, true
	}
	buffered := append([]map[string]any(nil), subscriber.ReplayBuffer...)
	dropped := subscriber.ReplayDropped
	subscriber.ReplayBuffer = nil
	subscriber.ReplayDropped = 0
	g.subscribers[sessionID][ws] = subscriber
	return buffered, dropped, true
}

func (g *ACPGateway) broadcastPromptUpdate(scope Scope, sessionID string, run *acpPromptRun, params map[string]any) (int, int) {
	var primary *WSConn
	var primaryEnvelope bool
	if run != nil {
		if targetWS, _, targetEnvelope, ok := run.responseTarget(); ok {
			primary = targetWS
			primaryEnvelope = targetEnvelope
		}
	}
	targets := g.subscriberTargets(scope, sessionID, primary, primaryEnvelope)
	type result struct {
		target acpSessionSubscriber
		err    error
	}
	results := make(chan result, len(targets))
	var wg sync.WaitGroup
	for _, target := range targets {
		if target.WS == nil {
			continue
		}
		if target.ReplayBuffering {
			if g.bufferReplayUpdate(sessionID, target.WS, params) {
				results <- result{target: target}
				continue
			}
		}
		wg.Add(1)
		go func(target acpSessionSubscriber) {
			defer wg.Done()
			err := g.writeNotificationWithin(target.WS, target.AppEnvelope, "session/update", params, acpSubscriberWriteTimeout)
			results <- result{target: target, err: err}
		}(target)
	}
	wg.Wait()
	close(results)
	delivered := 0
	failed := 0
	for result := range results {
		if result.err != nil {
			failed++
			g.removeSubscriber(sessionID, result.target.WS)
			if run != nil {
				run.clearResponseTarget(result.target.WS)
			}
			continue
		}
		delivered++
	}
	return delivered, failed
}

func (g *ACPGateway) broadcastCloudAgentNotification(scope Scope, sessionID string, run *acpPromptRun, method string, params map[string]any) (int, int) {
	targets := g.subscriberTargets(scope, sessionID, nil, false)
	if run != nil {
		if primary, _, primaryEnvelope, ok := run.responseTarget(); ok {
			targets = g.subscriberTargets(scope, sessionID, primary, primaryEnvelope)
		}
	}
	type result struct {
		target acpSessionSubscriber
		err    error
	}
	results := make(chan result, len(targets))
	var wg sync.WaitGroup
	for _, target := range targets {
		if target.WS == nil {
			continue
		}
		wg.Add(1)
		go func(target acpSessionSubscriber) {
			defer wg.Done()
			err := g.writeNotificationWithin(target.WS, target.AppEnvelope, method, params, acpSubscriberWriteTimeout)
			results <- result{target: target, err: err}
		}(target)
	}
	wg.Wait()
	close(results)
	delivered := 0
	failed := 0
	for result := range results {
		if result.err != nil {
			failed++
			g.removeSubscriber(sessionID, result.target.WS)
			if run != nil {
				run.clearResponseTarget(result.target.WS)
			}
			continue
		}
		delivered++
	}
	return delivered, failed
}
