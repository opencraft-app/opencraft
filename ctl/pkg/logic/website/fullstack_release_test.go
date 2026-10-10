package website

import (
	"net/http"
	"net/http/httptest"
	"testing"

	websiteModel "ctl/pkg/model/website"
	"ctl/pkg/resource"
)

func TestFullstackReleasePersistsPinnedBackendContract(t *testing.T) {
	l := setupCreateReleaseTest(t, 1000)
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	defer runtime.Close()
	t.Setenv("WEBSITE_BACKEND_ENABLED", "1")
	t.Setenv("WEBSITE_RUNTIME_BASE_URL", runtime.URL)
	t.Setenv("WEBSITE_RUNTIME_DEPLOY_TOKEN", "test-token")
	request := validReleaseRequest(10)
	request.Kind = "fullstack"
	request.BackendSHA256 = validSHA256
	result, err := l.CreateRelease("user-1", "ws-a", request)
	if err != nil {
		t.Fatal(err)
	}
	var release websiteModel.ReleaseEntity
	if err := resource.GormDB.Where("release_id = ?", result.ReleaseID).First(&release).Error; err != nil {
		t.Fatal(err)
	}
	if release.Kind != "fullstack" || release.BackendSHA256 != validSHA256 {
		t.Fatal("backend contract not persisted")
	}
	operation, err := l.GetOperationInternal(result.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	if operation.Kind != "fullstack" || operation.BackendSHA256 != validSHA256 {
		t.Fatal("deployer contract missing")
	}
}
