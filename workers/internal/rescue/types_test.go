package rescue

import "testing"

func TestNormalizeExportRequestDefaultsRescueEntryPolicy(t *testing.T) {
	req := NormalizeExportRequest(ExportRequest{})

	if req.StopType != DefaultRescueStopType {
		t.Fatalf("unexpected stop type: %s", req.StopType)
	}
	if req.WaitTimeoutSeconds != DefaultRescueWaitTimeoutSeconds {
		t.Fatalf("unexpected wait timeout: %d", req.WaitTimeoutSeconds)
	}
	if req.TATWaitTimeoutSeconds != DefaultRescueWaitTimeoutSeconds {
		t.Fatalf("unexpected TAT wait timeout: %d", req.TATWaitTimeoutSeconds)
	}
}

func TestNormalizeExportRequestKeepsExplicitWaits(t *testing.T) {
	req := NormalizeExportRequest(ExportRequest{
		StopType:              "HARD",
		WaitTimeoutSeconds:    30,
		TATWaitTimeoutSeconds: 45,
	})

	if req.StopType != "HARD" {
		t.Fatalf("unexpected stop type: %s", req.StopType)
	}
	if req.WaitTimeoutSeconds != 30 {
		t.Fatalf("unexpected wait timeout: %d", req.WaitTimeoutSeconds)
	}
	if req.TATWaitTimeoutSeconds != 45 {
		t.Fatalf("unexpected TAT wait timeout: %d", req.TATWaitTimeoutSeconds)
	}
}

func TestNormalizeImportRequestDefaultsWaits(t *testing.T) {
	req := NormalizeImportRequest(ImportRequest{})

	if req.WaitTimeoutSeconds != DefaultImportWaitTimeoutSeconds {
		t.Fatalf("unexpected import wait timeout: %d", req.WaitTimeoutSeconds)
	}
	if req.TATWaitTimeoutSeconds != DefaultImportWaitTimeoutSeconds {
		t.Fatalf("unexpected import TAT wait timeout: %d", req.TATWaitTimeoutSeconds)
	}
}
