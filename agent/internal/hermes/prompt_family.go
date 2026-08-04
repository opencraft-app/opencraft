package hermes

import "errors"

const maxPromptFamilyMembers = 256

var ErrPromptFamilyFull = errors.New("Hermes ACP prompt family is full")
var ErrPromptFamilyInactive = errors.New("Hermes ACP prompt family is inactive")

type promptMember struct {
	RequestID  int64
	Generation uint64
	Ordinal    uint64
}

type promptResolution struct {
	RequestID         int64
	Generation        uint64
	Ordinal           uint64
	EarlyChild        bool
	PromotedRequestID int64
	Complete          bool
}

type promptFamily struct {
	generation  uint64
	nextOrdinal uint64
	order       []promptMember
}

func (family *promptFamily) Active() bool {
	return len(family.order) != 0
}

func (family *promptFamily) Start(requestID int64) (promptMember, error) {
	if family.Active() {
		return promptMember{}, ErrPrimaryTurnActive
	}
	family.generation++
	family.nextOrdinal = 1
	member := promptMember{
		RequestID:  requestID,
		Generation: family.generation,
		Ordinal:    family.nextOrdinal,
	}
	family.order = append(family.order[:0], member)
	return member, nil
}

func (family *promptFamily) Append(requestID int64) (promptMember, error) {
	if !family.Active() {
		return promptMember{}, ErrPromptFamilyInactive
	}
	if len(family.order) >= maxPromptFamilyMembers {
		return promptMember{}, ErrPromptFamilyFull
	}
	for _, member := range family.order {
		if member.RequestID == requestID {
			return promptMember{}, errors.New("Hermes ACP prompt request is already tracked")
		}
	}
	family.nextOrdinal++
	member := promptMember{
		RequestID:  requestID,
		Generation: family.generation,
		Ordinal:    family.nextOrdinal,
	}
	family.order = append(family.order, member)
	return member, nil
}

func (family *promptFamily) Resolve(requestID int64) (promptResolution, bool) {
	index := family.index(requestID)
	if index < 0 {
		return promptResolution{}, false
	}
	member := family.order[index]
	resolution := promptResolution{
		RequestID:  member.RequestID,
		Generation: member.Generation,
		Ordinal:    member.Ordinal,
		EarlyChild: index > 0,
	}
	family.remove(index)
	if index == 0 {
		if len(family.order) == 0 {
			resolution.Complete = true
		} else {
			resolution.PromotedRequestID = family.order[0].RequestID
		}
	}
	return resolution, true
}

func (family *promptFamily) Rollback(requestID int64) bool {
	index := family.index(requestID)
	if index < 0 {
		return false
	}
	family.remove(index)
	return true
}

func (family *promptFamily) Detach() []promptMember {
	if len(family.order) == 0 {
		return nil
	}
	members := append([]promptMember(nil), family.order...)
	clear(family.order)
	family.order = family.order[:0]
	return members
}

func (family *promptFamily) index(requestID int64) int {
	for index, member := range family.order {
		if member.RequestID == requestID {
			return index
		}
	}
	return -1
}

func (family *promptFamily) remove(index int) {
	copy(family.order[index:], family.order[index+1:])
	clear(family.order[len(family.order)-1:])
	family.order = family.order[:len(family.order)-1]
	if len(family.order) == 0 {
		family.nextOrdinal = 0
	}
}
