package platform

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"velachat/agent/internal/common"
)

var ErrInvalidComputerProfileCapability = errors.New(
	"Computer Agent Profile capability 无效",
)

type ProfileCapabilityWarning struct {
	Code    string `json:"code"`
	Message string `json:"message,omitempty"`
}

type ProfileCapabilitySubject struct {
	ComputerID               string `json:"computerId"`
	RuntimeKind              string `json:"runtimeKind"`
	ProfileKind              string `json:"profileKind"`
	ProfileFingerprint       string `json:"profileFingerprint"`
	WorkspacePath            string `json:"workspacePath"`
	ContextGeneration        int64  `json:"contextGeneration"`
	AuthorityContextKey      string `json:"authorityContextKey"`
	RuntimeContextGeneration int64  `json:"runtimeContextGeneration"`
	ObservedThroughSequence  int64  `json:"observedThroughSequence"`
}

type ProfileCapabilitySource struct {
	Protocol       string `json:"protocol"`
	RuntimeVersion string `json:"runtimeVersion"`
	DiscoveryMode  string `json:"discoveryMode"`
	ForceReload    bool   `json:"forceReload"`
}

type ProfileCapabilityModel struct {
	ID                        string   `json:"id"`
	Label                     string   `json:"label"`
	Provider                  *string  `json:"provider,omitempty"`
	Description               *string  `json:"description,omitempty"`
	Verified                  *string  `json:"verified,omitempty"`
	SupportedReasoningEfforts []string `json:"supportedReasoningEfforts"`
	DefaultReasoningEffort    *string  `json:"defaultReasoningEffort,omitempty"`
	ServiceTiers              []string `json:"serviceTiers"`
	DefaultServiceTier        *string  `json:"defaultServiceTier,omitempty"`
}

type ProfileCapabilitySkill struct {
	ID                     string   `json:"id"`
	Name                   string   `json:"name"`
	Description            string   `json:"description"`
	DisplayName            *string  `json:"displayName,omitempty"`
	ShortDescription       *string  `json:"shortDescription,omitempty"`
	Enabled                bool     `json:"enabled"`
	Availability           string   `json:"availability"`
	Scope                  string   `json:"scope"`
	MissingDependencyCount int      `json:"missingDependencyCount"`
	MissingDependencyTypes []string `json:"missingDependencyTypes"`
}

type ProfileCapabilityModelSection struct {
	Status                  string                     `json:"status"`
	EffectiveDefaultModelID *string                    `json:"effectiveDefaultModelId"`
	Items                   []ProfileCapabilityModel   `json:"items"`
	Truncated               bool                       `json:"truncated"`
	Warnings                []ProfileCapabilityWarning `json:"warnings"`
	ErrorCode               *string                    `json:"errorCode"`
}

type ProfileCapabilitySkillSection struct {
	Status    string                     `json:"status"`
	Items     []ProfileCapabilitySkill   `json:"items"`
	Truncated bool                       `json:"truncated"`
	Warnings  []ProfileCapabilityWarning `json:"warnings"`
	ErrorCode *string                    `json:"errorCode"`
}

type ComputerAgentProfileCapabilityResult struct {
	SchemaVersion            int                           `json:"schemaVersion"`
	Status                   string                        `json:"status"`
	ContextGeneration        int64                         `json:"contextGeneration"`
	AuthorityContextKey      string                        `json:"authorityContextKey"`
	RuntimeKind              string                        `json:"runtimeKind"`
	RuntimeContextGeneration int64                         `json:"runtimeContextGeneration"`
	ObservedThroughSequence  int64                         `json:"observedThroughSequence"`
	Subject                  *ProfileCapabilitySubject     `json:"subject"`
	Source                   *ProfileCapabilitySource      `json:"source"`
	Models                   ProfileCapabilityModelSection `json:"models"`
	Skills                   ProfileCapabilitySkillSection `json:"skills"`
	ErrorCode                *string                       `json:"errorCode"`
	ObservedAt               time.Time                     `json:"observedAt"`
}

type ProfileCapabilitySubmissionResult struct {
	Accepted bool   `json:"accepted"`
	Reason   string `json:"reason"`
}

func (c *Client) PutComputerAgentProfileCapabilityResult(
	ctx context.Context,
	token ComputerAccessToken,
	agentID string,
	operationID string,
	result ComputerAgentProfileCapabilityResult,
) (ProfileCapabilitySubmissionResult, error) {
	if c == nil || ctx == nil || token.Reveal() == "" ||
		!validUUIDv7(agentID) || !validUUIDv7(operationID) ||
		!validProfileCapabilityResult(result) {
		return ProfileCapabilitySubmissionResult{},
			ErrInvalidComputerProfileCapability
	}
	body, err := common.Marshal(result)
	if err != nil {
		return ProfileCapabilitySubmissionResult{}, err
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPut,
		c.baseURL+"/computer/agents/"+url.PathEscape(agentID)+
			"/profile-capability-results/"+url.PathEscape(operationID),
		bytes.NewReader(body),
	)
	if err != nil {
		return ProfileCapabilitySubmissionResult{},
			ErrInvalidComputerProfileCapability
	}
	request.Header.Set("Authorization", "Bearer "+token.Reveal())
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Cache-Control", "no-store")
	response, err := c.httpClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ProfileCapabilitySubmissionResult{}, ctx.Err()
		}
		return ProfileCapabilitySubmissionResult{}, newRequestError(true, 0)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized ||
		response.StatusCode == http.StatusForbidden {
		return ProfileCapabilitySubmissionResult{}, ErrCredentialRejected
	}
	if response.StatusCode != http.StatusOK {
		return ProfileCapabilitySubmissionResult{}, newRequestError(
			response.StatusCode == http.StatusTooManyRequests ||
				response.StatusCode >= http.StatusInternalServerError,
			parseRetryAfter(response.Header.Get("Retry-After"), c.now().UTC()),
		)
	}
	var payload ProfileCapabilitySubmissionResult
	if err := decodeLimited(response.Body, &payload); err != nil ||
		!validProfileCapabilitySubmission(payload) {
		return ProfileCapabilitySubmissionResult{},
			ErrInvalidComputerProfileCapability
	}
	return payload, nil
}

func validProfileCapabilityResult(value ComputerAgentProfileCapabilityResult) bool {
	if value.SchemaVersion != 1 || value.ContextGeneration < 1 ||
		len(value.AuthorityContextKey) != 43 ||
		value.RuntimeContextGeneration < 1 ||
		value.ObservedThroughSequence < 0 || value.ObservedAt.IsZero() ||
		!validCapabilityRuntime(value.RuntimeKind) ||
		len(value.Models.Items) > 2000 || len(value.Skills.Items) > 2000 ||
		len(value.Models.Warnings) > 32 || len(value.Skills.Warnings) > 32 {
		return false
	}
	if value.Status == "succeeded" {
		return value.Subject != nil && value.Source != nil &&
			value.ErrorCode == nil &&
			validCapabilitySection(value.Models.Status, value.Models.ErrorCode) &&
			validCapabilitySection(value.Skills.Status, value.Skills.ErrorCode) &&
			(value.Models.Status == "succeeded" || value.Skills.Status == "succeeded")
	}
	return value.Status == "failed" && value.ErrorCode != nil &&
		strings.TrimSpace(*value.ErrorCode) == *value.ErrorCode &&
		*value.ErrorCode != ""
}

func validCapabilitySection(status string, errorCode *string) bool {
	if status == "succeeded" {
		return errorCode == nil
	}
	return status == "failed" && errorCode != nil &&
		strings.TrimSpace(*errorCode) == *errorCode && *errorCode != ""
}

func validCapabilityRuntime(value string) bool {
	return value == "codex" || value == "hermes-acp" ||
		value == "hermes-gateway"
}

func validProfileCapabilitySubmission(value ProfileCapabilitySubmissionResult) bool {
	if value.Accepted {
		return value.Reason == "accepted" || value.Reason == "duplicate"
	}
	return value.Reason == "duplicate" || value.Reason == "superseded"
}
