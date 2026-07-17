package main

import "fmt"

type managedSet struct {
	ID                      string `json:"id"`
	Status                  string `json:"status"`
	Setup                   bool   `json:"setup"`
	AdminUserID             int64  `json:"admin_user_id"`
	ActiveRuntimeGeneration int64  `json:"active_runtime_generation"`
	RouteRevision           int64  `json:"route_revision"`
}

func validateGenerationTransition(before, after managedSet, expectedGeneration int64) error {
	if before.ID != after.ID {
		return fmt.Errorf("set changed from %q to %q", before.ID, after.ID)
	}
	if after.ActiveRuntimeGeneration != expectedGeneration || after.ActiveRuntimeGeneration != before.ActiveRuntimeGeneration+1 {
		return fmt.Errorf("set %s runtime generation changed from %d to %d, expected %d", before.ID, before.ActiveRuntimeGeneration, after.ActiveRuntimeGeneration, expectedGeneration)
	}
	if after.RouteRevision != before.RouteRevision+1 {
		return fmt.Errorf("set %s route revision changed from %d to %d, expected %d", before.ID, before.RouteRevision, after.RouteRevision, before.RouteRevision+1)
	}
	return nil
}

func upsertManagerProbeModel(jobSpec map[string]any, model string) error {
	template, ok := jobSpec["template"].(map[string]any)
	if !ok {
		return fmt.Errorf("job template is missing")
	}
	podSpec, ok := template["spec"].(map[string]any)
	if !ok {
		return fmt.Errorf("job pod spec is missing")
	}
	containers, ok := podSpec["containers"].([]any)
	if !ok || len(containers) == 0 {
		return fmt.Errorf("job containers are missing")
	}
	container, ok := containers[0].(map[string]any)
	if !ok {
		return fmt.Errorf("job container has unexpected shape")
	}
	env, _ := container["env"].([]any)
	for _, raw := range env {
		entry, ok := raw.(map[string]any)
		if ok && entry["name"] == "LLMGATEWAY_SET_UPGRADE_PROBE_MODEL" {
			entry["value"] = model
			delete(entry, "valueFrom")
			return nil
		}
	}
	container["env"] = append(env, map[string]any{
		"name":  "LLMGATEWAY_SET_UPGRADE_PROBE_MODEL",
		"value": model,
	})
	return nil
}
