package api

import (
	"context"
	"crypto/subtle"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/SpechtLabs/StaticPages/pkg/config"
	"github.com/SpechtLabs/StaticPages/pkg/s3_client"
	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gin-gonic/gin"
	"github.com/sierrasoftworks/humane-errors-go"
)

const (
	staticPagesRepositoryHeader  = "X-StaticPages-Repository"
	staticPagesBranchHeader      = "X-StaticPages-Branch"
	staticPagesSHAHeader         = "X-StaticPages-SHA"
	staticPagesEnvironmentHeader = "X-StaticPages-Environment"
)

var previewNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

func (r *RestApi) extractAndVerifyAuth(ctx context.Context, ct *gin.Context) (*s3_client.PageIndexData, humane.Error) {
	ctx, span := r.tracer.Start(ctx, "restApi.extractAndVerifyAuth")
	defer span.End()

	rawToken, err := extractBearerToken(ct.GetHeader("Authorization"))
	if err != nil {
		return nil, err
	}

	if metadata, matched, err := verifyAgainstBearerPages(rawToken, r.conf.Pages, ct); matched || err != nil {
		return metadata, err
	}

	issuerSet, err := collectUniqueIssuers(r.conf.Pages)
	if err != nil {
		return nil, err
	}

	return verifyAgainstIssuers(ctx, rawToken, issuerSet)
}

func verifyAgainstBearerPages(rawToken string, pages []*config.Page, ct *gin.Context) (*s3_client.PageIndexData, bool, humane.Error) {
	for _, page := range pages {
		if page.Git.Provider != "bearer" {
			continue
		}

		expectedToken := page.Git.Bearer.Token.String()
		if expectedToken == "" || subtle.ConstantTimeCompare([]byte(rawToken), []byte(expectedToken)) != 1 {
			continue
		}

		metadata, err := metadataFromStaticPagesHeaders(page, ct)
		return metadata, true, err
	}
	return nil, false, nil
}

func metadataFromStaticPagesHeaders(page *config.Page, ct *gin.Context) (*s3_client.PageIndexData, humane.Error) {
	repository := strings.TrimSpace(ct.GetHeader(staticPagesRepositoryHeader))
	sha := strings.TrimSpace(ct.GetHeader(staticPagesSHAHeader))
	branch := strings.TrimSpace(ct.GetHeader(staticPagesBranchHeader))
	environment := strings.TrimSpace(ct.GetHeader(staticPagesEnvironmentHeader))

	if repository == "" {
		return nil, humane.New("missing StaticPages repository header", "Set X-StaticPages-Repository in the upload request.")
	}
	if repository != page.Git.Repository {
		return nil, humane.New("repository not authorized", "The upload token is not allowed to publish this repository.")
	}
	if sha == "" {
		return nil, humane.New("missing StaticPages SHA header", "Set X-StaticPages-SHA in the upload request.")
	}
	if branch == "" {
		return nil, humane.New("missing StaticPages branch header", "Set X-StaticPages-Branch to a DNS-safe preview slug.")
	}
	if !previewNamePattern.MatchString(branch) {
		return nil, humane.New("invalid StaticPages branch header", "X-StaticPages-Branch must be a DNS-safe slug: [a-z0-9][a-z0-9-]{0,62}.")
	}
	if environment != "" && !previewNamePattern.MatchString(environment) {
		return nil, humane.New("invalid StaticPages environment header", "X-StaticPages-Environment must be a DNS-safe slug: [a-z0-9][a-z0-9-]{0,62}.")
	}

	return s3_client.NewPageCommitMetadata(repository, sha, branch, environment, time.Now()), nil
}

func waitForAllErrors(errs <-chan humane.Error) <-chan humane.Error {
	done := make(chan humane.Error, 1)

	go func() {
		var first humane.Error
		for err := range errs {
			if first == nil {
				first = err
			}

			// drain all other errors silently
		}

		done <- first
		close(done)
	}()

	return done
}

func extractBearerToken(authHeader string) (string, humane.Error) {
	if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
		return "", humane.New("missing or invalid Authorization header", "Make sure the Authorization header is correctly formatted and try again.")
	}
	return strings.TrimPrefix(authHeader, "Bearer "), nil
}

func collectUniqueIssuers(pages []*config.Page) (map[string]config.ClaimMap, humane.Error) {
	issuerSet := make(map[string]config.ClaimMap)
	for _, page := range pages {
		if page.Git.Provider == "bearer" {
			continue
		}
		issuer, err := page.Git.GetOidcIssuer()
		if err != nil {
			return nil, humane.Wrap(err, "failed to get OIDC issuer")
		}

		claimMap, err := page.Git.GetOidcClaimMapping()
		if err != nil {
			return nil, humane.Wrap(err, "failed to get OIDC claim mapping")
		}

		issuerSet[issuer] = claimMap // deduplicates issuers
	}
	if len(issuerSet) == 0 {
		return nil, humane.New("no OIDC issuer configured", "Configure a Git OIDC provider or use a valid bearer upload token.")
	}
	return issuerSet, nil
}

func verifyAgainstIssuers(ctx context.Context, rawToken string, issuerSet map[string]config.ClaimMap) (*s3_client.PageIndexData, humane.Error) {
	var (
		wg         sync.WaitGroup
		metadataCh = make(chan *s3_client.PageIndexData, 1)
		errorCh    = make(chan humane.Error, len(issuerSet))
	)

	for issuer, claimMap := range issuerSet {
		issuer := issuer
		claimMap := claimMap

		wg.Add(1)
		go func() {
			defer wg.Done()

			provider, err := oidc.NewProvider(ctx, issuer)
			if err != nil {
				errorCh <- humane.Wrap(err, "failed to initialize OIDC provider")
				return
			}

			verifier := provider.VerifierContext(ctx, &oidc.Config{SkipClientIDCheck: true})
			idToken, err := verifier.Verify(ctx, rawToken)
			if err != nil {
				errorCh <- humane.Wrap(err, "failed to verify OIDC token")
				return
			}

			claims := make(map[string]interface{})
			if err := idToken.Claims(&claims); err != nil {
				errorCh <- humane.Wrap(err, "failed to extract claims from token")
				return
			}

			var (
				repository  string
				commit      string
				branch      string
				environment string
			)

			if r, ok := claims[claimMap[config.RepositoryClaim]].(string); ok {
				repository = r
			} else {
				errorCh <- humane.New("failed to extract repository claim")
			}

			if c, ok := claims[claimMap[config.CommitClaim]].(string); ok {
				commit = c
			} else {
				errorCh <- humane.New("failed to extract commit claim")
			}

			if b, ok := claims[claimMap[config.BranchClaim]].(string); ok {
				branch, _ = strings.CutPrefix(b, "refs/heads/")
			} else {
				errorCh <- humane.New("failed to extract branch claim")
			}

			if e, ok := claims[claimMap[config.EnvironmentClaim]].(string); ok {
				environment = e
			}

			metadataCh <- s3_client.NewPageCommitMetadata(
				repository,
				commit,
				branch,
				environment,
				time.Now(),
			)
		}()
	}

	go func() {
		wg.Wait()
		close(errorCh)
	}()

	select {
	case metadata := <-metadataCh:
		return metadata, nil

	case <-ctx.Done():
		return nil, humane.Wrap(ctx.Err(), "context cancelled while verifying token")

	case <-time.After(10 * time.Second):
		return nil, humane.New("OIDC verification timed out")

	case err := <-waitForAllErrors(errorCh):
		return nil, humane.Wrap(err, "none of the configured OIDC providers accepted the token")
	}
}
