package serverstate

import "testing"

func TestDrainState(t *testing.T) {
	state := NewDrainState()
	if state.IsDraining() {
		t.Fatal("new state should not be draining")
	}

	if !state.BeginDraining() {
		t.Fatal("first BeginDraining should report state change")
	}
	if !state.IsDraining() {
		t.Fatal("state should be draining after BeginDraining")
	}
	if state.BeginDraining() {
		t.Fatal("second BeginDraining should not report state change")
	}

	state.SetDraining(false)
	if state.IsDraining() {
		t.Fatal("state should not be draining after SetDraining(false)")
	}
}
