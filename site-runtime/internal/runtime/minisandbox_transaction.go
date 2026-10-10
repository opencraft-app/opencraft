package runtime

import (
	"context"
	"fmt"
	"net/http"
)

var _ transactionalManagedRunner = (*minisandboxClient)(nil)

// A pending journal is never replayed into a differently configured region,
// endpoint or site, even when two registries happen to expose the same names.
func (c *minisandboxClient) DeploymentIdentity(site string) (string, error) {
	if _, err := c.workerPath(site); err != nil {
		return "", err
	}
	return sha256Hex([]byte("lightvela-native-deployment-v1\x00" + c.base + "\x00" + c.scope + "\x00" + site)), nil
}

func (c *minisandboxClient) Snapshot(ctx context.Context, site string) (DeploymentState, error) {
	worker, err := c.workerPath(site)
	if err != nil {
		return DeploymentState{}, err
	}
	var current minisandboxDeployment
	status, err := c.jsonRequest(ctx, http.MethodGet, worker+"/deployment", nil, &current)
	if status == http.StatusNotFound {
		return DeploymentState{}, nil
	}
	if err != nil {
		return DeploymentState{}, err
	}
	if !validMinisandboxDeployment(current) {
		return DeploymentState{}, fmt.Errorf("invalid native deployment snapshot")
	}
	return DeploymentState{Exists: true, ID: current.ID, Targets: current.Versions}, nil
}

// Immutable source publication has no active-pointer or application side effect.
func (c *minisandboxClient) Stage(ctx context.Context, site string, bundles map[string]Bundle) (PreparedPackage, error) {
	p, err := buildMinisandboxPackage(bundles)
	if err != nil {
		return PreparedPackage{}, err
	}
	worker, err := c.workerPath(site)
	if err != nil {
		return PreparedPackage{}, err
	}
	var version struct {
		ID string `json:"id"`
	}
	if _, err = c.jsonRequest(ctx, http.MethodPost, worker+"/versions", p, &version); err != nil {
		return PreparedPackage{}, err
	}
	if !versionPattern.MatchString(version.ID) {
		return PreparedPackage{}, fmt.Errorf("invalid staged native version")
	}
	return PreparedPackage{VersionID: version.ID, PackageID: p.PackageID}, nil
}

func (c *minisandboxClient) ActivateCAS(ctx context.Context, site string, before DeploymentState, version string) (ActivationResult, error) {
	if !validDeploymentState(before) || !versionPattern.MatchString(version) {
		return ActivationResult{}, fmt.Errorf("invalid native activation intent")
	}
	return c.activateTargets(ctx, site, before.ID, map[string]string{"version_id": version, "expected_deployment_id": before.ID}, []minisandboxTarget{{VersionID: version, Percentage: 100}})
}

func (c *minisandboxClient) activateTargets(ctx context.Context, site, expectedID string, input any, targets []minisandboxTarget) (ActivationResult, error) {
	result := ActivationResult{Ownership: ActivationUnknown}
	worker, err := c.workerPath(site)
	if err != nil {
		return result, err
	}
	if expectedID != "" && !deploymentPattern.MatchString(expectedID) {
		return result, fmt.Errorf("invalid native CAS fence")
	}
	var deployed minisandboxDeployment
	status, err := c.jsonRequest(ctx, http.MethodPost, worker+"/deployments", input, &deployed)
	result.HTTPStatus = status
	if err != nil {
		return result, err
	}
	if status != http.StatusCreated && status != http.StatusOK {
		return result, fmt.Errorf("invalid native activation status")
	}
	if !validMinisandboxDeployment(deployed) || !sameMinisandboxTargets(targets, deployed.Versions) {
		return result, fmt.Errorf("invalid native activation result")
	}
	result.Deployment = DeploymentState{Exists: true, ID: deployed.ID, Targets: deployed.Versions}
	if status == http.StatusCreated {
		result.Ownership = ActivationOwned
	} else {
		result.Ownership = ActivationBorrowed
	}
	return result, nil
}

// Confirm the exact control-plane identity both before and after execution
// probes. A deployment with the same code but a different ID is not our fence.
func (c *minisandboxClient) VerifyPrepared(ctx context.Context, site string, expected DeploymentState, packageID string) error {
	if !validDeploymentState(expected) || !expected.Exists || !digestPattern.MatchString(packageID) {
		return fmt.Errorf("invalid native readiness intent")
	}
	worker, err := c.workerPath(site)
	if err != nil {
		return err
	}
	verifySnapshot := func() error {
		current, err := c.Snapshot(ctx, site)
		if err != nil {
			return err
		}
		if !current.Exists || current.ID != expected.ID || !sameMinisandboxTargets(current.Targets, expected.Targets) {
			return fmt.Errorf("native deployment fence changed")
		}
		return nil
	}
	if err := verifySnapshot(); err != nil {
		return err
	}
	if err := c.verifyPrivatePackage(ctx, worker+"/dispatch", packageID); err != nil {
		return err
	}
	if err := c.verifyDurablePackage(ctx, site, packageID); err != nil {
		return err
	}
	return verifySnapshot()
}

// Native does not expose an absent-pointer CAS restoration. First publication
// therefore follows the journal's explicit finish-verified-publication policy;
// it must never substitute Worker/DO deletion or fabricate an empty rollout.
func (c *minisandboxClient) RestoreCAS(ctx context.Context, site, expectedID string, before DeploymentState) (ActivationResult, error) {
	if !before.Exists || !validDeploymentState(before) || !deploymentPattern.MatchString(expectedID) {
		return ActivationResult{}, fmt.Errorf("native deployment cannot restore an absent or invalid pointer")
	}
	input := map[string]any{"versions": before.Targets, "expected_deployment_id": expectedID}
	return c.activateTargets(ctx, site, expectedID, input, before.Targets)
}
