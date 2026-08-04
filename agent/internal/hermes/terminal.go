package hermes

import (
	"errors"
	"os"
	"time"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeapi"
)

const processKillGrace = 750 * time.Millisecond

func (session *session) failTransport(detail string) {
	session.transportFailOnce.Do(func() {
		session.mu.Lock()
		session.stopping = true
		session.completionFenced = true
		session.mu.Unlock()
		session.emit(runtimeapi.Event{
			Kind:     runtimeapi.EventError,
			Text:     detail,
			LaunchID: session.launchID,
		})
		session.abortWire()
		session.scheduleKillAfterGrace()
	})
}

func (session *session) scheduleKillAfterGrace() {
	session.killScheduleOnce.Do(func() {
		go session.killAfterGrace()
	})
}

func (session *session) killAfterGrace() {
	timer := time.NewTimer(processKillGrace)
	defer timer.Stop()
	select {
	case <-session.done:
		return
	case <-timer.C:
	}
	if session.command == nil || session.command.Process == nil {
		return
	}
	if err := session.command.Process.Kill(); err != nil &&
		!errors.Is(err, os.ErrProcessDone) {
		return
	}
}
