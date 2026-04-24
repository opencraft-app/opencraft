package serverstate

import "testing"

func TestDrainState(t *testing.T) {
	state := NewDrainState()
	if state.IsDraining() {
		t.Fatal("new state should not be draining")
	}

	state.SetDraining(true)
	if !state.IsDraining() {
		t.Fatal("state should be draining after SetDraining(true)")
	}

	state.SetDraining(false)
	if state.IsDraining() {
		t.Fatal("state should not be draining after SetDraining(false)")
	}
}
