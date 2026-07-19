package runner

import (
	"testing"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/cases"
)

func TestScenarioNamesMapToResultOrientedCaseSets(t *testing.T) {
	scenario, err := scenarioForName("preprod_release_gate")
	if err != nil {
		t.Fatal(err)
	}
	if scenario.Cases[0] != cases.CasePlatformReady || scenario.Cases[len(scenario.Cases)-1] != cases.CasePlatformHealthy {
		t.Fatalf("scenario = %+v", scenario)
	}
}

func TestFleetCampaignScenarioEndsAtCampaignConvergence(t *testing.T) {
	scenario, err := scenarioForName("fleet_release_campaign_gate")
	if err != nil {
		t.Fatal(err)
	}
	if scenario.Cases[len(scenario.Cases)-1] != cases.CaseFleetCampaign {
		t.Fatalf("scenario = %+v", scenario)
	}
}

func TestDisruptiveScenarioNamesMapToTheirP0Outcome(t *testing.T) {
	tests := map[string]string{
		"set_upgrade_rollback_gate": cases.CasePostSwitchRollback,
		"set_manager_takeover_gate": cases.CaseManagerTakeover,
		"control_plane_outage_gate": cases.CaseControlPlaneOutage,
	}
	for name, finalCase := range tests {
		scenario, err := scenarioForName(name)
		if err != nil {
			t.Fatal(err)
		}
		if scenario.Cases[len(scenario.Cases)-1] != finalCase {
			t.Fatalf("%s scenario = %+v", name, scenario)
		}
	}
}
