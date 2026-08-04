package hermes

import (
	"time"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeapi"
)

const (
	maxActionQueue   = 4096
	actionDrainGrace = 250 * time.Millisecond
)

func (session *session) initActionDispatcher() {
	session.actionsInitOnce.Do(func() {
		session.actionWake = make(chan struct{}, 1)
		session.actionForce = make(chan struct{})
		session.actionDone = make(chan struct{})
		go session.dispatchActions()
	})
}

func (session *session) emit(event runtimeapi.Event) {
	session.mu.Lock()
	session.enqueueEventLocked(event)
	session.mu.Unlock()
	session.wakeActionDispatcher()
}

func (session *session) enqueueEventsLocked(events []runtimeapi.Event) {
	for _, event := range events {
		session.enqueueEventLocked(event)
	}
}

func (session *session) enqueueEventLocked(event runtimeapi.Event) {
	if session.actionsClosing {
		return
	}
	if len(session.actionQueue) >= maxActionQueue {
		if !mandatoryRuntimeEvent(event.Kind) {
			return
		}
		for index, queued := range session.actionQueue {
			if mandatoryRuntimeEvent(queued.Kind) {
				continue
			}
			copy(session.actionQueue[index:], session.actionQueue[index+1:])
			session.actionQueue[len(session.actionQueue)-1] = event
			return
		}
		if event.Kind != runtimeapi.EventTurnCompletion ||
			session.terminalActionQueued {
			return
		}
		session.terminalActionQueued = true
	}
	session.actionQueue = append(session.actionQueue, event)
}

func mandatoryRuntimeEvent(kind runtimeapi.EventKind) bool {
	switch kind {
	case runtimeapi.EventSession,
		runtimeapi.EventError,
		runtimeapi.EventTurnCompletion,
		runtimeapi.EventTerminalFailure:
		return true
	default:
		return false
	}
}

func (session *session) wakeActionDispatcher() {
	select {
	case session.actionWake <- struct{}{}:
	default:
	}
}

func (session *session) dispatchActions() {
	defer close(session.actionDone)
	defer close(session.events)
	for {
		session.mu.Lock()
		if len(session.actionQueue) > 0 {
			event := session.actionQueue[0]
			copy(session.actionQueue, session.actionQueue[1:])
			clear(session.actionQueue[len(session.actionQueue)-1:])
			session.actionQueue = session.actionQueue[:len(session.actionQueue)-1]
			session.mu.Unlock()
			select {
			case session.events <- event:
			case <-session.actionForce:
				return
			}
			continue
		}
		closing := session.actionsClosing
		session.mu.Unlock()
		if closing {
			return
		}
		select {
		case <-session.actionWake:
		case <-session.actionForce:
			return
		}
	}
}

func (session *session) closeEvents() {
	session.actionsCloseOnce.Do(func() {
		session.mu.Lock()
		session.actionsClosing = true
		session.mu.Unlock()
		session.wakeActionDispatcher()
	})
	timer := time.NewTimer(actionDrainGrace)
	defer timer.Stop()
	select {
	case <-session.actionDone:
		return
	case <-timer.C:
		session.actionsForceOnce.Do(func() { close(session.actionForce) })
		<-session.actionDone
	}
}
