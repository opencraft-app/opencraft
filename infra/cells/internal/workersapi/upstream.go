package workersapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxUpstreamResponseBytes int64 = 20 << 20

type upstreamError struct {
	Status    int
	Code      string
	Message   string
	Retryable bool
}

func (e *upstreamError) Error() string { return e.Message }

type registryVersion struct {
	VersionID               string                           `json:"version_id"`
	Digest                  string                           `json:"digest"`
	CreatedAt               time.Time                        `json:"created_at"`
	MainModule              string                           `json:"main_module"`
	ModuleCount             int                              `json:"module_count"`
	CompatibilityDate       string                           `json:"compatibility_date"`
	DurableObjectNamespaces []registryDurableObjectNamespace `json:"durable_object_namespaces,omitempty"`
}

type registryDurableObjectNamespace struct {
	ClassName string `json:"class_name"`
	Storage   string `json:"storage"`
}

type registryBinding struct {
	Type      string `json:"type"`
	ClassName string `json:"class_name"`
}

type registryExport struct {
	Type    string `json:"type"`
	Storage string `json:"storage"`
}

type registryVersionContent struct {
	Schema   string                     `json:"schema"`
	Bindings map[string]registryBinding `json:"bindings,omitempty"`
	Exports  map[string]registryExport  `json:"exports,omitempty"`
}

type registryImmutableVersion struct {
	VersionID string                 `json:"version_id"`
	Content   registryVersionContent `json:"content"`
}

type registryDeployment struct {
	ID         string              `json:"id"`
	Worker     string              `json:"worker"`
	Versions   []DeploymentVersion `json:"versions"`
	DeployedAt time.Time           `json:"deployed_at"`
}

type registryWorker struct {
	Name             string             `json:"name"`
	Deployment       registryDeployment `json:"deployment"`
	Versions         []registryVersion  `json:"versions"`
	DeploymentCursor string             `json:"deployment_cursor"`
}

type registryDeploymentCursor struct {
	Schema    string `json:"schema"`
	Namespace string `json:"namespace"`
	Cursor    string `json:"cursor"`
}

type registryWorkerList struct {
	Workers []registryWorker `json:"workers"`
}

type registryVersionList struct {
	Versions []registryVersion `json:"versions"`
	Page     int               `json:"page"`
	PerPage  int               `json:"per_page"`
}

type registryErrorEnvelope struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type registryObject struct {
	ActorID   string             `json:"actor_id,omitempty"`
	State     string             `json:"state"`
	Placement *registryPlacement `json:"placement,omitempty"`
}

type actorState struct {
	ActorID       string `json:"actor_id"`
	ConnectableTS *int64 `json:"connectable_ts"`
	SleepTS       *int64 `json:"sleep_ts"`
	DestroyTS     *int64 `json:"destroy_ts"`
	Error         any    `json:"error"`
}

type actorCreateResponse struct {
	Actor actorState `json:"actor"`
}

type actorListResponse struct {
	Actors []actorState `json:"actors"`
}

func (a *API) registryURL(path string) *url.URL {
	result := *a.registry
	result.Path = strings.TrimSuffix(a.registry.Path, "/") + path
	result.RawQuery = ""
	return &result
}

func engineURL(base *url.URL, path string) *url.URL {
	result := *base
	result.Path = strings.TrimSuffix(base.Path, "/") + path
	result.RawQuery = ""
	return &result
}

func (a *API) requestJSON(
	ctx context.Context,
	method string,
	target *url.URL,
	input any,
	output any,
) *upstreamError {
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return &upstreamError{Status: http.StatusInternalServerError, Code: "internal_error", Message: "The request could not be encoded"}
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, target.String(), body)
	if err != nil {
		return &upstreamError{Status: http.StatusInternalServerError, Code: "internal_error", Message: "The upstream request could not be created"}
	}
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if token := a.tokenForURL(target); token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := a.client.Do(request)
	if err != nil {
		status := http.StatusServiceUnavailable
		code := "upstream_unavailable"
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			status = http.StatusGatewayTimeout
			code = "upstream_timeout"
		}
		return &upstreamError{Status: status, Code: code, Message: "An internal service is unavailable", Retryable: true}
	}
	defer response.Body.Close()
	encoded, err := io.ReadAll(io.LimitReader(response.Body, maxUpstreamResponseBytes+1))
	if err != nil {
		return &upstreamError{Status: http.StatusBadGateway, Code: "invalid_upstream_response", Message: "An internal service returned an unreadable response", Retryable: true}
	}
	if int64(len(encoded)) > maxUpstreamResponseBytes {
		return &upstreamError{Status: http.StatusBadGateway, Code: "invalid_upstream_response", Message: "An internal service returned an oversized response", Retryable: true}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var envelope registryErrorEnvelope
		_ = json.Unmarshal(encoded, &envelope)
		code := envelope.Code
		if code == "" {
			code = "upstream_error"
		}
		message := envelope.Message
		if message == "" {
			message = fmt.Sprintf("An internal service returned HTTP %d", response.StatusCode)
		}
		return &upstreamError{
			Status:    response.StatusCode,
			Code:      code,
			Message:   message,
			Retryable: response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500,
		}
	}
	if output == nil || response.StatusCode == http.StatusNoContent {
		return nil
	}
	if err := json.Unmarshal(encoded, output); err != nil {
		return &upstreamError{Status: http.StatusBadGateway, Code: "invalid_upstream_response", Message: "An internal service returned malformed JSON", Retryable: true}
	}
	return nil
}

func (a *API) tokenForURL(target *url.URL) string {
	if token, ok := a.dynamicEngineTokens.Load(target.Scheme + "://" + target.Host); ok {
		return token.(string)
	}
	for index, engine := range a.engines {
		basePath := strings.TrimSuffix(engine.Path, "/")
		if target.Scheme == engine.Scheme && target.Host == engine.Host &&
			(target.Path == basePath || strings.HasPrefix(target.Path, basePath+"/")) {
			return a.engineTokens[index]
		}
	}
	return a.internalToken
}

func publicVersion(worker string, version registryVersion) Version {
	return Version{
		Object:            resourceVersion,
		ID:                version.VersionID,
		Worker:            worker,
		Digest:            version.Digest,
		CreatedAt:         version.CreatedAt,
		MainModule:        version.MainModule,
		ModuleCount:       version.ModuleCount,
		CompatibilityDate: version.CompatibilityDate,
	}
}

func publicDeployment(worker string, deployment registryDeployment) Deployment {
	return Deployment{
		Object:     resourceDeployment,
		ID:         deployment.ID,
		Worker:     worker,
		Versions:   deployment.Versions,
		DeployedAt: deployment.DeployedAt,
	}
}

func publicWorker(worker registryWorker) Worker {
	versions := make([]Version, 0, len(worker.Versions))
	for _, version := range worker.Versions {
		versions = append(versions, publicVersion(worker.Name, version))
	}
	deployment := publicDeployment(worker.Name, worker.Deployment)
	return Worker{
		Object:     resourceWorker,
		Name:       worker.Name,
		Deployment: &deployment,
		Versions:   versions,
	}
}
