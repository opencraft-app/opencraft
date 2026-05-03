package api

import (
	"net/http/httptest"
	"testing"

	"github.com/SpechtLabs/StaticPages/pkg/config"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestVerifyAgainstBearerPages(t *testing.T) {
	gin.SetMode(gin.TestMode)
	page := &config.Page{
		Git: config.GitConfig{
			Provider:   "bearer",
			Repository: "wisp/mono2",
			Bearer: config.BearerAuth{
				Token: config.EnvValue("test-token"),
			},
		},
	}
	request := httptest.NewRequest("POST", "/api/upload", nil)
	request.Header.Set(staticPagesRepositoryHeader, "wisp/mono2")
	request.Header.Set(staticPagesSHAHeader, "abc123")
	request.Header.Set(staticPagesBranchHeader, "front-test")
	request.Header.Set(staticPagesEnvironmentHeader, "frontsandbox")
	ct, _ := gin.CreateTestContext(httptest.NewRecorder())
	ct.Request = request

	metadata, matched, err := verifyAgainstBearerPages("test-token", []*config.Page{page}, ct)

	require.NoError(t, err)
	assert.True(t, matched)
	assert.Equal(t, "wisp/mono2", metadata.Repository())
	assert.Equal(t, "abc123", metadata.SHA())
	assert.Equal(t, "front-test", metadata.Branch)
	assert.Equal(t, "frontsandbox", metadata.Environment)
}

func TestVerifyAgainstBearerPagesRejectsUnsafeBranchSlug(t *testing.T) {
	gin.SetMode(gin.TestMode)
	page := &config.Page{
		Git: config.GitConfig{
			Provider:   "bearer",
			Repository: "wisp/mono2",
			Bearer: config.BearerAuth{
				Token: config.EnvValue("test-token"),
			},
		},
	}
	request := httptest.NewRequest("POST", "/api/upload", nil)
	request.Header.Set(staticPagesRepositoryHeader, "wisp/mono2")
	request.Header.Set(staticPagesSHAHeader, "abc123")
	request.Header.Set(staticPagesBranchHeader, "frontsandbox/demo")
	ct, _ := gin.CreateTestContext(httptest.NewRecorder())
	ct.Request = request

	metadata, matched, err := verifyAgainstBearerPages("test-token", []*config.Page{page}, ct)

	require.Error(t, err)
	assert.True(t, matched)
	assert.Nil(t, metadata)
}
