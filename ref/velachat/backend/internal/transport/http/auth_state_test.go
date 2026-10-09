package httptransport

import (
	"context"
	"testing"

	authnport "chatserver/internal/ports/authn"
)

func TestCurrentComputerPrincipalReturnsOnlyComputerPrincipal(t *testing.T) {
	principal, err := authnport.NewCurrentComputerPrincipal(
		hookTestServerID,
		hookTestComputerID,
		4,
	)
	if err != nil {
		t.Fatal(err)
	}
	state := &AuthState{}
	if err := state.setPrincipal(principal); err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(context.Background(), authStateContextKey{}, state)
	got, ok := CurrentComputerPrincipal(ctx)
	if !ok || got.ComputerID() != hookTestComputerID {
		t.Fatalf("CurrentComputerPrincipal() = %#v, %v", got, ok)
	}
}
