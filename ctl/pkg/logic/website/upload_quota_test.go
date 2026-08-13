package website

import (
	"errors"
	"fmt"
	"testing"

	"ctl/pkg/errcode"
	quotaModel "ctl/pkg/model/userresourcequota"
	websiteModel "ctl/pkg/model/website"
	"ctl/pkg/resource"
)

func setupCreateReleaseTest(t *testing.T, storageLimit int64) *logic {
	t.Helper()
	t.Setenv("WEBSITE_COS_BUCKET", "test-vela-user-sites-1388575217")
	t.Setenv("WEBSITE_COS_REGION", "ap-beijing")
	t.Setenv("WEBSITE_COS_SECRET_ID", "AKIDTESTTESTTESTTESTTESTTESTTEST")
	t.Setenv("WEBSITE_COS_SECRET_KEY", "testtesttesttesttesttesttesttest")
	newWebsiteOperationTestDB(t)
	quotaJSON := fmt.Sprintf(`{"max_sites":3,"monthly_traffic_bytes":1000,"storage_bytes":%d,"max_artifact_size":1000,"max_files":500}`, storageLimit)
	seedPassAndBundle(t, "user-1", "bundle-1", quotaJSON)
	seedSite(t, "ws-a", "user-1", websiteModel.SiteStatusActive, 1)
	if err := resource.GormDB.Table(quotaModel.TableName).Create(&quotaModel.Entity{
		UserID:                 "user-1",
		ResourceName:           websiteModel.ResourceNameWebsiteSite,
		ResourceKey:            "bundle-1",
		ResourceQuotaAvailable: 2,
		ResourceQuotaTotal:     3,
	}).Error; err != nil {
		t.Fatal(err)
	}
	return NewLogic().(*logic)
}

func TestCreateReleaseFailsBeforePersistenceWhenUploadSigningUnavailable(t *testing.T) {
	logic := setupCreateReleaseTest(t, 1000)
	t.Setenv("WEBSITE_COS_BUCKET", "")
	t.Setenv("WEBSITE_COS_REGION", "")
	t.Setenv("WEBSITE_COS_SECRET_ID", "")
	t.Setenv("WEBSITE_COS_SECRET_KEY", "")
	t.Setenv("TENCENT_SECRET_ID", "")
	t.Setenv("TENCENT_SECRET_KEY", "")

	_, err := logic.CreateRelease("user-1", "ws-a", validReleaseRequest(10))
	if !errors.Is(err, errcode.ErrWebsiteUploadUnavailable) {
		t.Fatalf("CreateRelease error = %v, want ErrWebsiteUploadUnavailable", err)
	}

	var releaseCount, operationCount int64
	if err := resource.GormDB.Table(websiteModel.ReleasesTable).Count(&releaseCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := resource.GormDB.Table(websiteModel.OperationsTable).Count(&operationCount).Error; err != nil {
		t.Fatal(err)
	}
	if releaseCount != 0 || operationCount != 0 {
		t.Fatalf("persisted rows after signing failure: releases=%d operations=%d", releaseCount, operationCount)
	}
}

func validReleaseRequest(size int64) CreateReleaseRequest {
	return CreateReleaseRequest{ArtifactHash: validSHA256, ArtifactSize: size, FileCount: 1}
}

func TestCreateReleaseRejectsInFlightReleaseForSameSite(t *testing.T) {
	for _, status := range []string{
		websiteModel.ReleaseStatusPending,
		websiteModel.ReleaseStatusUploading,
		websiteModel.ReleaseStatusDeploying,
	} {
		t.Run(status, func(t *testing.T) {
			logic := setupCreateReleaseTest(t, 1000)
			seedRelease(t, "wr-existing", "ws-a", "user-1", 1, status)

			_, err := logic.CreateRelease("user-1", "ws-a", validReleaseRequest(10))
			if !errors.Is(err, errcode.ErrWebsiteReleaseInProgress) {
				t.Fatalf("CreateRelease error = %v, want ErrWebsiteReleaseInProgress", err)
			}
			var count int64
			if err := resource.GormDB.Table(websiteModel.ReleasesTable).Where("site_id = ?", "ws-a").Count(&count).Error; err != nil {
				t.Fatal(err)
			}
			if count != 1 {
				t.Fatalf("release count = %d, want existing release only", count)
			}
		})
	}
}

func TestCreateReleaseRejectsUsedStoragePlusArtifact(t *testing.T) {
	logic := setupCreateReleaseTest(t, 100)
	if err := resource.GormDB.Table(websiteModel.SitesTable).
		Where("site_id = ?", "ws-a").Update("storage_bytes", 90).Error; err != nil {
		t.Fatal(err)
	}

	_, err := logic.CreateRelease("user-1", "ws-a", validReleaseRequest(11))
	if !errors.Is(err, errcode.ErrWebsiteQuotaExceeded) {
		t.Fatalf("CreateRelease error = %v, want ErrWebsiteQuotaExceeded", err)
	}
}

func TestCreateReleaseReservesInflightArtifactsAcrossUserSites(t *testing.T) {
	logic := setupCreateReleaseTest(t, 100)
	seedSite(t, "ws-b", "user-1", websiteModel.SiteStatusActive, 1)
	release := &websiteModel.ReleaseEntity{
		ReleaseID:    "wr-reserved",
		SiteID:       "ws-b",
		Version:      1,
		Status:       websiteModel.ReleaseStatusUploading,
		ArtifactHash: validSHA256,
		ArtifactSize: 60,
		FileCount:    1,
	}
	release.UserID = "user-1"
	if err := resource.GormDB.Table(websiteModel.ReleasesTable).Create(release).Error; err != nil {
		t.Fatal(err)
	}
	if err := resource.GormDB.Table(websiteModel.SitesTable).
		Where("site_id = ?", "ws-a").Update("storage_bytes", 30).Error; err != nil {
		t.Fatal(err)
	}

	_, err := logic.CreateRelease("user-1", "ws-a", validReleaseRequest(11))
	if !errors.Is(err, errcode.ErrWebsiteQuotaExceeded) {
		t.Fatalf("CreateRelease error = %v, want ErrWebsiteQuotaExceeded", err)
	}
}

func TestCreateReleaseAllowsTerminalReleaseHistory(t *testing.T) {
	for _, status := range []string{websiteModel.ReleaseStatusActive, websiteModel.ReleaseStatusFailed} {
		t.Run(status, func(t *testing.T) {
			logic := setupCreateReleaseTest(t, 1000)
			seedRelease(t, "wr-history", "ws-a", "user-1", 1, status)

			if _, err := logic.CreateRelease("user-1", "ws-a", validReleaseRequest(10)); err != nil {
				t.Fatalf("CreateRelease with %s history: %v", status, err)
			}
		})
	}
}

func TestUpdateSiteStorageRejectsUserWideQuotaExceeded(t *testing.T) {
	logic := setupCreateReleaseTest(t, 100)
	seedSite(t, "ws-b", "user-1", websiteModel.SiteStatusActive, 1)
	if err := resource.GormDB.Table(websiteModel.SitesTable).
		Where("site_id = ?", "ws-a").Update("storage_bytes", 20).Error; err != nil {
		t.Fatal(err)
	}
	if err := resource.GormDB.Table(websiteModel.SitesTable).
		Where("site_id = ?", "ws-b").Update("storage_bytes", 70).Error; err != nil {
		t.Fatal(err)
	}

	err := logic.UpdateSiteStorage("ws-a", 31)
	if !errors.Is(err, errcode.ErrWebsiteQuotaExceeded) {
		t.Fatalf("UpdateSiteStorage error = %v, want ErrWebsiteQuotaExceeded", err)
	}
	var site websiteModel.SiteEntity
	if err := resource.GormDB.Table(websiteModel.SitesTable).Where("site_id = ?", "ws-a").First(&site).Error; err != nil {
		t.Fatal(err)
	}
	if site.StorageBytes != 20 {
		t.Fatalf("storage_bytes changed after rejection: %d", site.StorageBytes)
	}
}
