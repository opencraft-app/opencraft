package wrapper

const (
	cloudAgentSessionStatusMethod      = "_cloudagent.session.status"
	cloudAgentRuntimeEnsureReadyMethod = "_cloudagent.runtime.ensure_ready"
	cloudAgentReplayDoneMethod         = "_cloudagent.session.replay_done"
	cloudAgentReplayGapMethod          = "_cloudagent.session.replay_gap"
	cloudAgentTurnStatusMethod         = "_cloudagent.turn.status"
)

func cloudAgentReplayDoneParams(sessionID string, lastEventSeq int64) map[string]any {
	return map[string]any{
		"session_id":     sessionID,
		"last_event_seq": lastEventSeq,
	}
}

func cloudAgentReplayGapParams(sessionID string, dropped int) map[string]any {
	return map[string]any{
		"session_id": sessionID,
		"dropped":    dropped,
	}
}
