package workerregistry

const (
	defaultListPageSize = 20
	maxListPageSize     = 100
	maxListPage         = 100
)

func normalizePagination(page, perPage int) (int, int) {
	if page < 1 {
		page = 1
	}
	if perPage < 1 {
		perPage = defaultListPageSize
	}
	if perPage > maxListPageSize {
		perPage = maxListPageSize
	}
	return page, perPage
}

func paginate[T any](values []T, page, perPage int) []T {
	start := (page - 1) * perPage
	if start >= len(values) {
		return []T{}
	}
	end := min(start+perPage, len(values))
	return values[start:end]
}

func buildVersionRecords(summaries []VersionSummary, active map[string]struct{}, retention, rankOffset int) []VersionRecord {
	records := make([]VersionRecord, 0, len(summaries))
	for index, summary := range summaries {
		_, isActive := active[summary.VersionID]
		record := VersionRecord{
			VersionSummary: summary,
			Deployable:     rankOffset+index < retention,
			Active:         isActive,
			GCStatus:       VersionGCStatusCandidateReportOnly,
		}
		if record.Deployable {
			record.RetentionReasons = append(record.RetentionReasons, "deployable_window")
		}
		if isActive {
			record.RetentionReasons = append(record.RetentionReasons, "active_deployment")
		}
		if len(record.RetentionReasons) > 0 {
			record.GCStatus = VersionGCStatusRetained
		} else {
			// Physical deletion remains disabled until explicit Actor version pins
			// have a complete, durable reverse-reference index.
			record.GCBlockedReason = "actor_pin_index_unavailable"
		}
		records = append(records, record)
	}
	return records
}

func buildDeploymentRecords(deployments []Deployment, activeID string, deployable map[string]struct{}) []DeploymentRecord {
	records := make([]DeploymentRecord, 0, len(deployments))
	for _, deployment := range deployments {
		rollbackAvailable := true
		for _, target := range deployment.Versions {
			if _, ok := deployable[target.VersionID]; !ok {
				rollbackAvailable = false
				break
			}
		}
		records = append(records, DeploymentRecord{
			Deployment:        deployment,
			Active:            deployment.ID == activeID,
			RollbackAvailable: rollbackAvailable,
		})
	}
	return records
}

func versionIDSet(summaries []VersionSummary) map[string]struct{} {
	result := make(map[string]struct{}, len(summaries))
	for _, summary := range summaries {
		result[summary.VersionID] = struct{}{}
	}
	return result
}
