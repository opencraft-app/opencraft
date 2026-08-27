package website

import (
	"errors"
	"testing"

	"ctl/pkg/errcode"
	"ctl/pkg/model/website"
)

func TestBindCustomDomain(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedPassAndBundle(t, "user-1", "bundle-1", testQuotaJSON)
	seedSite(t, "ws-a", "user-1", website.SiteStatusActive, 1)

	l := NewLogic().(*logic)
	if err := l.BindCustomDomain("blog.example.com", "ws-a", "user-1"); err != nil {
		t.Fatalf("BindCustomDomain: %v", err)
	}

	// Verify it's in the DB
	binding, err := l.customDomainDao.GetByDomain("blog.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if binding == nil || binding.SiteID != "ws-a" {
		t.Fatalf("expected binding to ws-a, got %+v", binding)
	}
}

func TestBindCustomDomainIdempotent(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedPassAndBundle(t, "user-1", "bundle-1", testQuotaJSON)
	seedSite(t, "ws-a", "user-1", website.SiteStatusActive, 1)

	l := NewLogic().(*logic)
	if err := l.BindCustomDomain("blog.example.com", "ws-a", "user-1"); err != nil {
		t.Fatal(err)
	}
	// Second bind to same site+domain should be idempotent
	if err := l.BindCustomDomain("blog.example.com", "ws-a", "user-1"); err != nil {
		t.Fatalf("idempotent rebind: %v", err)
	}
}

func TestBindCustomDomainAlreadyTaken(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedPassAndBundle(t, "user-1", "bundle-1", testQuotaJSON)
	seedPassAndBundle(t, "user-2", "bundle-2", testQuotaJSON)
	seedSite(t, "ws-a", "user-1", website.SiteStatusActive, 1)
	seedSite(t, "ws-b", "user-2", website.SiteStatusActive, 1)

	l := NewLogic().(*logic)
	if err := l.BindCustomDomain("blog.example.com", "ws-a", "user-1"); err != nil {
		t.Fatal(err)
	}
	err := l.BindCustomDomain("blog.example.com", "ws-b", "user-2")
	if !errors.Is(err, errcode.ErrWebsiteDomainAlreadyBound) {
		t.Fatalf("expected ErrWebsiteDomainAlreadyBound, got %v", err)
	}
}

func TestBindCustomDomainSiteNotFound(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedPassAndBundle(t, "user-1", "bundle-1", testQuotaJSON)

	l := NewLogic().(*logic)
	err := l.BindCustomDomain("blog.example.com", "ws-nonexistent", "user-1")
	if !errors.Is(err, errcode.ErrWebsiteNotFound) {
		t.Fatalf("expected ErrWebsiteNotFound, got %v", err)
	}
}

func TestBindCustomDomainNormalizes(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedPassAndBundle(t, "user-1", "bundle-1", testQuotaJSON)
	seedSite(t, "ws-a", "user-1", website.SiteStatusActive, 1)

	l := NewLogic().(*logic)
	// Uppercase + trailing dot should normalize to lowercase no-dot
	if err := l.BindCustomDomain("Blog.Example.COM.", "ws-a", "user-1"); err != nil {
		t.Fatal(err)
	}

	binding, err := l.customDomainDao.GetByDomain("blog.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if binding == nil {
		t.Fatal("expected binding with normalized domain")
	}
}

func TestUnbindCustomDomain(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedPassAndBundle(t, "user-1", "bundle-1", testQuotaJSON)
	seedSite(t, "ws-a", "user-1", website.SiteStatusActive, 1)

	l := NewLogic().(*logic)
	if err := l.BindCustomDomain("blog.example.com", "ws-a", "user-1"); err != nil {
		t.Fatal(err)
	}
	if err := l.UnbindCustomDomain("blog.example.com"); err != nil {
		t.Fatal(err)
	}

	// Verify it's gone
	binding, err := l.customDomainDao.GetByDomain("blog.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if binding != nil {
		t.Fatal("expected nil after unbind")
	}

	// Unbinding non-existent domain is idempotent
	if err := l.UnbindCustomDomain("nonexistent.com"); err != nil {
		t.Fatalf("idempotent unbind: %v", err)
	}
}

func TestGetSiteIDByDomain(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedPassAndBundle(t, "user-1", "bundle-1", testQuotaJSON)
	seedSite(t, "ws-a", "user-1", website.SiteStatusActive, 1)

	l := NewLogic().(*logic)
	if err := l.BindCustomDomain("blog.example.com", "ws-a", "user-1"); err != nil {
		t.Fatal(err)
	}

	siteID, err := l.GetSiteIDByDomain("blog.example.com")
	if err != nil {
		t.Fatalf("GetSiteIDByDomain: %v", err)
	}
	if siteID != "ws-a" {
		t.Fatalf("expected ws-a, got %s", siteID)
	}
}

func TestGetSiteIDByDomainNotFound(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedPassAndBundle(t, "user-1", "bundle-1", testQuotaJSON)

	l := NewLogic().(*logic)
	_, err := l.GetSiteIDByDomain("nonexistent.example.com")
	if !errors.Is(err, errcode.ErrWebsiteNotFound) {
		t.Fatalf("expected ErrWebsiteNotFound, got %v", err)
	}
}

func TestGetSiteIDByDomainDeletedSite(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedPassAndBundle(t, "user-1", "bundle-1", testQuotaJSON)
	seedSite(t, "ws-a", "user-1", website.SiteStatusActive, 1)

	l := NewLogic().(*logic)
	if err := l.BindCustomDomain("blog.example.com", "ws-a", "user-1"); err != nil {
		t.Fatal(err)
	}

	// Soft delete the site
	if err := l.siteDao.SoftDelete("ws-a"); err != nil {
		t.Fatal(err)
	}

	// Should now return not found even though binding exists
	_, err := l.GetSiteIDByDomain("blog.example.com")
	if !errors.Is(err, errcode.ErrWebsiteNotFound) {
		t.Fatalf("expected ErrWebsiteNotFound for deleted site, got %v", err)
	}
}

func TestGetSiteIDByDomainMultipleBindings(t *testing.T) {
	newWebsiteOperationTestDB(t)
	seedPassAndBundle(t, "user-1", "bundle-1", testQuotaJSON)
	seedSite(t, "ws-a", "user-1", website.SiteStatusActive, 1)
	seedSite(t, "ws-b", "user-1", website.SiteStatusActive, 1)

	l := NewLogic().(*logic)
	if err := l.BindCustomDomain("a.example.com", "ws-a", "user-1"); err != nil {
		t.Fatal(err)
	}
	if err := l.BindCustomDomain("b.example.com", "ws-b", "user-1"); err != nil {
		t.Fatal(err)
	}

	idA, _ := l.GetSiteIDByDomain("a.example.com")
	idB, _ := l.GetSiteIDByDomain("b.example.com")
	if idA != "ws-a" || idB != "ws-b" {
		t.Fatalf("expected ws-a/ws-b, got %s/%s", idA, idB)
	}
}
