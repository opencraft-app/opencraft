package computerauth

import "testing"

func TestRouteKeepsComputerRoutingSeparateFromAgentRouting(t *testing.T) {
	route := Route{
		ServerID:   "01989c24-7540-7f12-a27b-c83243215dd3",
		ComputerID: "01989c24-7540-7f12-a27b-c83243215dd5",
		Version:    2,
	}
	credential := Credential{Route: route}
	if credential.ComputerID == "" || credential.Version != 2 {
		t.Fatalf("Credential route = %#v", credential.Route)
	}
}
