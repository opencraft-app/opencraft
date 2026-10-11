package codex

const maximumCompletedTurnEvidence = 16

type turnEvidenceCompletion struct {
	ZeroEvidence  bool
	InputEvidence string
}

type turnEvidenceState struct {
	activeTurnID       string
	inProgress         bool
	hadRuntimeActivity bool
	hadTokenUsage      bool
	hadNonEmptyInput   bool
	pendingNonEmpty    map[string]struct{}
	completed          map[string]struct{}
	completedOrder     []string
}

func (s *turnEvidenceState) markAcceptedInput(turnID string, nonEmpty bool) {
	if turnID == "" || !nonEmpty || s.wasCompleted(turnID) {
		return
	}
	if s.inProgress && s.activeTurnID == turnID {
		s.hadNonEmptyInput = true
		return
	}
	if s.pendingNonEmpty == nil {
		s.pendingNonEmpty = make(map[string]struct{})
	}
	s.pendingNonEmpty[turnID] = struct{}{}
}

func (s *turnEvidenceState) markStarted(turnID string) {
	if turnID != "" {
		s.activeTurnID = turnID
	}
	s.inProgress = true
	s.hadRuntimeActivity = false
	s.hadTokenUsage = false
	s.hadNonEmptyInput = false
	if turnID == "" || s.pendingNonEmpty == nil {
		return
	}
	if _, ok := s.pendingNonEmpty[turnID]; ok {
		s.hadNonEmptyInput = true
		delete(s.pendingNonEmpty, turnID)
	}
}

func (s *turnEvidenceState) markRuntimeActivity() {
	if s.inProgress {
		s.hadRuntimeActivity = true
	}
}

func (s *turnEvidenceState) markTokenUsage() {
	if s.inProgress {
		s.hadTokenUsage = true
	}
}

func (s *turnEvidenceState) markCompleted() turnEvidenceCompletion {
	completion := turnEvidenceCompletion{}
	if s.inProgress && !s.hadRuntimeActivity && !s.hadTokenUsage {
		completion.ZeroEvidence = true
		completion.InputEvidence = "unknown"
		if s.hadNonEmptyInput {
			completion.InputEvidence = "nonempty"
		}
	}
	if s.inProgress && s.activeTurnID != "" {
		s.rememberCompleted(s.activeTurnID)
	}
	s.activeTurnID = ""
	s.inProgress = false
	s.hadRuntimeActivity = false
	s.hadTokenUsage = false
	s.hadNonEmptyInput = false
	return completion
}

func (s *turnEvidenceState) wasCompleted(turnID string) bool {
	if s.completed == nil {
		return false
	}
	_, ok := s.completed[turnID]
	return ok
}

func (s *turnEvidenceState) rememberCompleted(turnID string) {
	if s.completed == nil {
		s.completed = make(map[string]struct{})
	}
	if _, ok := s.completed[turnID]; ok {
		return
	}
	s.completed[turnID] = struct{}{}
	s.completedOrder = append(s.completedOrder, turnID)
	if len(s.completedOrder) <= maximumCompletedTurnEvidence {
		return
	}
	oldest := s.completedOrder[0]
	s.completedOrder = s.completedOrder[1:]
	delete(s.completed, oldest)
}
