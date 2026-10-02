package workerregistry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
	"time"
)

const DefaultMaxRequestBytes int64 = 16 << 20

const maxConcurrentDeploymentWatches = 1024

type API struct {
	store                  RegistryStore
	maxRequestBytes        int64
	maxCompatibilityDate   string
	deploymentWatchPermits chan struct{}
	mux                    *http.ServeMux
}

type apiError struct {
	Group    string `json:"group"`
	Code     string `json:"code"`
	Message  string `json:"message"`
	Metadata any    `json:"metadata"`
}

func NewAPI(store RegistryStore, maxRequestBytes int64) *API {
	return NewAPIWithMaxCompatibilityDate(store, maxRequestBytes, "")
}

func NewAPIWithMaxCompatibilityDate(store RegistryStore, maxRequestBytes int64, maxCompatibilityDate string) *API {
	if maxRequestBytes <= 0 {
		maxRequestBytes = DefaultMaxRequestBytes
	}
	api := &API{
		store:                  store,
		maxRequestBytes:        maxRequestBytes,
		maxCompatibilityDate:   maxCompatibilityDate,
		deploymentWatchPermits: make(chan struct{}, maxConcurrentDeploymentWatches),
		mux:                    http.NewServeMux(),
	}
	api.routes()
	return api
}

func (a *API) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	a.mux.ServeHTTP(writer, request)
}

func (a *API) routes() {
	a.mux.HandleFunc("GET /healthz", a.health)
	a.mux.HandleFunc("GET /readyz", a.ready)
	a.mux.HandleFunc("PUT /v1/namespaces/{namespace}/workers/{worker}", a.putWorker)
	a.mux.HandleFunc("POST /v1/namespaces/{namespace}/workers/{worker}/versions", a.uploadVersion)
	a.mux.HandleFunc("POST /v1/namespaces/{namespace}/workers/{worker}/deployments", a.createDeployment)
	a.mux.HandleFunc("GET /v1/namespaces/{namespace}/workers/{worker}/versions", a.listVersions)
	a.mux.HandleFunc("GET /v1/namespaces/{namespace}/workers/{worker}/deployments", a.listDeployments)
	a.mux.HandleFunc("GET /v1/namespaces/{namespace}/workers/{worker}/deployments/{deployment}", a.getDeployment)
	a.mux.HandleFunc("DELETE /v1/namespaces/{namespace}/workers/{worker}/deployments/{deployment}", a.deleteDeployment)
	a.mux.HandleFunc("GET /v1/namespaces/{namespace}/workers/{worker}", a.getWorker)
	a.mux.HandleFunc("DELETE /v1/namespaces/{namespace}/workers/{worker}", a.deleteWorker)
	a.mux.HandleFunc("GET /v1/namespaces/{namespace}/workers", a.listWorkers)
	a.mux.HandleFunc("GET /v1/namespaces/{namespace}/workers/{worker}/versions/{version}", a.getVersionSummary)
	a.mux.HandleFunc("GET /internal/v1/namespaces/{namespace}/workers/{worker}/versions/{version}", a.getVersion)
	a.mux.HandleFunc("GET /internal/v1/namespaces/{namespace}/deployment-cursor", a.watchDeploymentCursor)
	a.mux.HandleFunc("GET /internal/v1/namespaces/{namespace}/workers/{worker}/objects/{class}/{object}", a.getObject)
	a.mux.HandleFunc("PUT /internal/v1/namespaces/{namespace}/workers/{worker}/objects/{class}/{object}", a.claimObject)
	a.mux.HandleFunc("POST /internal/v1/namespaces/{namespace}/workers/{worker}/objects/{class}/{object}/activate", a.activateObject)
	a.mux.HandleFunc("DELETE /internal/v1/namespaces/{namespace}/workers/{worker}/objects/{class}/{object}", a.deleteObject)
	a.mux.HandleFunc("GET /internal/v1/cells/{cell}/placement-count", a.getCellPlacementCount)
}

func (a *API) watchDeploymentCursor(writer http.ResponseWriter, request *http.Request) {
	namespace := request.PathValue("namespace")
	afterValues, present := request.URL.Query()["after"]
	if !namePattern.MatchString(namespace) || !present || len(afterValues) != 1 || len(request.URL.Query()) != 1 || !validDeploymentCursor(afterValues[0]) {
		writeError(writer, http.StatusBadRequest, "deployment", "invalid_cursor", "Exactly one valid after cursor is required")
		return
	}
	select {
	case a.deploymentWatchPermits <- struct{}{}:
		defer func() { <-a.deploymentWatchPermits }()
	default:
		writer.Header().Set("Retry-After", "1")
		writeError(writer, http.StatusTooManyRequests, "deployment", "watch_overloaded", "Worker deployment watch capacity is full")
		return
	}
	waitContext, cancel := context.WithTimeout(request.Context(), 25*time.Second)
	defer cancel()
	cursor, err := a.store.WatchDeploymentCursor(waitContext, namespace, afterValues[0])
	if err != nil && !errors.Is(err, context.DeadlineExceeded) {
		if errors.Is(err, context.Canceled) && request.Context().Err() != nil {
			return
		}
		slog.Error("watch Worker deployment cursor", "namespace", namespace, "error", err)
		writeError(writer, http.StatusInternalServerError, "worker_registry", "storage_error", "Worker deployment changes could not be watched")
		return
	}
	if !validDeploymentCursor(cursor) {
		writeError(writer, http.StatusInternalServerError, "worker_registry", "storage_error", "Worker deployment cursor is invalid")
		return
	}
	writer.Header().Set("Cache-Control", "no-store")
	writeJSON(writer, http.StatusOK, DeploymentCursor{Schema: DeploymentCursorSchema, Namespace: namespace, Cursor: cursor})
}

func (a *API) getCellPlacementCount(writer http.ResponseWriter, request *http.Request) {
	cellName := request.PathValue("cell")
	cellUID := request.URL.Query().Get("cell_uid")
	if len(request.URL.Query()) != 1 || len(request.URL.Query()["cell_uid"]) != 1 {
		writeError(writer, http.StatusBadRequest, "cell", "invalid_identity", "Exactly one cell_uid query parameter is required")
		return
	}
	if err := validateCellIdentity(cellName, cellUID); err != nil {
		writeError(writer, http.StatusBadRequest, "cell", "invalid_identity", err.Error())
		return
	}
	count, err := a.store.GetCellPlacementCount(request.Context(), cellName, cellUID)
	if err != nil {
		slog.Error("read Cell placement count", "cell", cellName, "error", err)
		writeError(writer, http.StatusInternalServerError, "worker_registry", "storage_error", "Cell placement count could not be read")
		return
	}
	writeJSON(writer, http.StatusOK, CellPlacementCount{
		Schema: CellPlacementCountSchema, CellName: cellName, CellUID: cellUID,
		Count: count, Shards: CellPlacementCountShards,
	})
}

func (a *API) health(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *API) ready(writer http.ResponseWriter, request *http.Request) {
	if err := a.store.Check(request.Context()); err != nil {
		slog.Warn("Worker registry readiness check failed", "error", err)
		writeError(writer, http.StatusServiceUnavailable, "worker_registry", "not_ready", "Worker registry storage is unavailable")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]string{"status": "ready"})
}

func (a *API) putWorker(writer http.ResponseWriter, request *http.Request) {
	input, ok := a.readVersionUpload(writer, request)
	if !ok {
		return
	}

	namespace, worker := request.PathValue("namespace"), request.PathValue("worker")
	result, created, err := a.store.PutWorker(request.Context(), namespace, worker, input)
	if err != nil {
		if errors.Is(err, ErrVersionNotDeployable) {
			writeError(writer, http.StatusConflict, "deployment", "version_not_deployable", "The uploaded content resolves to a Worker version outside the deployable retention window")
			return
		}
		slog.Error("persist Worker version", "namespace", namespace, "worker", worker, "error", err)
		writeError(writer, http.StatusInternalServerError, "worker_registry", "storage_error", "Worker version could not be persisted")
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(writer, status, result)
}

func (a *API) uploadVersion(writer http.ResponseWriter, request *http.Request) {
	input, ok := a.readVersionUpload(writer, request)
	if !ok {
		return
	}
	namespace, worker := request.PathValue("namespace"), request.PathValue("worker")
	result, created, err := a.store.UploadVersion(request.Context(), namespace, worker, input)
	if err != nil {
		slog.Error("persist Worker version", "namespace", namespace, "worker", worker, "error", err)
		writeError(writer, http.StatusInternalServerError, "worker_registry", "storage_error", "Worker version could not be persisted")
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(writer, status, result)
}

func (a *API) readVersionUpload(writer http.ResponseWriter, request *http.Request) (PutWorkerRequest, bool) {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeError(writer, http.StatusUnsupportedMediaType, "worker", "invalid_content_type", "Content-Type must be application/json")
		return PutWorkerRequest{}, false
	}

	request.Body = http.MaxBytesReader(writer, request.Body, a.maxRequestBytes)
	var input PutWorkerRequest
	if err := decodeRequest(request.Body, &input); err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			writeError(writer, http.StatusRequestEntityTooLarge, "worker", "request_too_large", "Worker upload exceeds the request size limit")
			return PutWorkerRequest{}, false
		}
		writeError(writer, http.StatusBadRequest, "worker", "invalid_request", err.Error())
		return PutWorkerRequest{}, false
	}

	namespace, worker := request.PathValue("namespace"), request.PathValue("worker")
	if _, _, _, _, err := prepareVersion(namespace, worker, input); err != nil {
		writeError(writer, http.StatusBadRequest, "worker", "invalid_request", err.Error())
		return PutWorkerRequest{}, false
	}
	if a.maxCompatibilityDate != "" && input.CompatibilityDate > a.maxCompatibilityDate {
		writeError(writer, http.StatusBadRequest, "worker", "unsupported_compatibility_date", fmt.Sprintf("compatibility_date exceeds this runtime release maximum %s", a.maxCompatibilityDate))
		return PutWorkerRequest{}, false
	}
	return input, true
}

func (a *API) createDeployment(writer http.ResponseWriter, request *http.Request) {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeError(writer, http.StatusUnsupportedMediaType, "deployment", "invalid_content_type", "Content-Type must be application/json")
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, 64<<10)
	var input CreateDeploymentRequest
	if err := decodeRequest(request.Body, &input); err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			writeError(writer, http.StatusRequestEntityTooLarge, "deployment", "request_too_large", "Worker deployment exceeds the request size limit")
			return
		}
		writeError(writer, http.StatusBadRequest, "deployment", "invalid_request", err.Error())
		return
	}
	if err := validateDeploymentRequest(input); err != nil {
		writeError(writer, http.StatusBadRequest, "deployment", "invalid_request", err.Error())
		return
	}
	namespace, worker := request.PathValue("namespace"), request.PathValue("worker")
	if err := validateIdentity(namespace, worker); err != nil {
		writeError(writer, http.StatusBadRequest, "deployment", "invalid_name", err.Error())
		return
	}
	result, err := a.store.CreateDeployment(request.Context(), namespace, worker, input)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeError(writer, http.StatusNotFound, "deployment", "version_not_found", "A Worker version in the deployment was not found")
			return
		}
		if errors.Is(err, ErrVersionNotDeployable) {
			writeError(writer, http.StatusConflict, "deployment", "version_not_deployable", "A Worker version is outside the deployable retention window")
			return
		}
		if errors.Is(err, ErrDeploymentConflict) {
			writeError(writer, http.StatusConflict, "deployment", "deployment_conflict", "The active Worker deployment changed")
			return
		}
		if errors.Is(err, ErrIncompatibleRolloutBindings) {
			writeError(writer, http.StatusConflict, "deployment", "incompatible_rollout_bindings", "A Durable Object binding changes namespace across rollout versions")
			return
		}
		slog.Error("persist Worker deployment", "namespace", namespace, "worker", worker, "error", err)
		writeError(writer, http.StatusInternalServerError, "worker_registry", "storage_error", "Worker deployment could not be persisted")
		return
	}
	writeJSON(writer, http.StatusCreated, result)
}

func (a *API) listVersions(writer http.ResponseWriter, request *http.Request) {
	if err := validateIdentity(request.PathValue("namespace"), request.PathValue("worker")); err != nil {
		writeError(writer, http.StatusBadRequest, "worker", "invalid_name", err.Error())
		return
	}
	page, perPage, ok := readPagination(writer, request)
	if !ok {
		return
	}
	result, err := a.store.ListVersions(request.Context(), request.PathValue("namespace"), request.PathValue("worker"), page, perPage)
	if err != nil {
		a.writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, result)
}

func (a *API) listDeployments(writer http.ResponseWriter, request *http.Request) {
	if err := validateIdentity(request.PathValue("namespace"), request.PathValue("worker")); err != nil {
		writeError(writer, http.StatusBadRequest, "worker", "invalid_name", err.Error())
		return
	}
	page, perPage, ok := readPagination(writer, request)
	if !ok {
		return
	}
	result, err := a.store.ListDeployments(request.Context(), request.PathValue("namespace"), request.PathValue("worker"), page, perPage)
	if err != nil {
		a.writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, result)
}

func (a *API) getDeployment(writer http.ResponseWriter, request *http.Request) {
	namespace, worker, deploymentID := request.PathValue("namespace"), request.PathValue("worker"), request.PathValue("deployment")
	if err := validateIdentity(namespace, worker); err != nil || !validDeploymentID(deploymentID) {
		writeError(writer, http.StatusBadRequest, "deployment", "invalid_deployment", "Worker identity or deployment ID is invalid")
		return
	}
	result, err := a.store.GetDeployment(request.Context(), namespace, worker, deploymentID)
	if err != nil {
		a.writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, result)
}

func (a *API) deleteDeployment(writer http.ResponseWriter, request *http.Request) {
	namespace, worker, deploymentID := request.PathValue("namespace"), request.PathValue("worker"), request.PathValue("deployment")
	if err := validateIdentity(namespace, worker); err != nil || !validDeploymentID(deploymentID) {
		writeError(writer, http.StatusBadRequest, "deployment", "invalid_deployment", "Worker identity or deployment ID is invalid")
		return
	}
	if err := a.store.DeleteDeployment(request.Context(), namespace, worker, deploymentID); err != nil {
		if errors.Is(err, ErrActiveDeployment) {
			writeError(writer, http.StatusConflict, "deployment", "active_deployment", "The active Worker deployment cannot be deleted")
			return
		}
		a.writeStoreError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (a *API) deleteWorker(writer http.ResponseWriter, request *http.Request) {
	namespace, worker := request.PathValue("namespace"), request.PathValue("worker")
	if err := validateIdentity(namespace, worker); err != nil {
		writeError(writer, http.StatusBadRequest, "worker", "invalid_name", err.Error())
		return
	}
	if err := a.store.DeleteWorker(request.Context(), namespace, worker); err != nil {
		a.writeStoreError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (a *API) getWorker(writer http.ResponseWriter, request *http.Request) {
	namespace, worker := request.PathValue("namespace"), request.PathValue("worker")
	if err := validateIdentity(namespace, worker); err != nil {
		writeError(writer, http.StatusBadRequest, "worker", "invalid_name", err.Error())
		return
	}
	result, err := a.store.GetWorker(request.Context(), namespace, worker)
	if err != nil {
		a.writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, result)
}

func (a *API) listWorkers(writer http.ResponseWriter, request *http.Request) {
	namespace := request.PathValue("namespace")
	if !namePattern.MatchString(namespace) {
		writeError(writer, http.StatusBadRequest, "worker", "invalid_name", fmt.Sprintf("namespace must match %s", namePattern.String()))
		return
	}
	workers, err := a.store.ListWorkers(request.Context(), namespace)
	if err != nil {
		a.writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, WorkerList{Workers: workers})
}

func (a *API) getVersionSummary(writer http.ResponseWriter, request *http.Request) {
	version, ok := a.readVersion(writer, request)
	if !ok {
		return
	}
	writeJSON(writer, http.StatusOK, summarizeVersion(version))
}

func (a *API) getVersion(writer http.ResponseWriter, request *http.Request) {
	version, ok := a.readVersion(writer, request)
	if !ok {
		return
	}
	etag := `"` + version.Digest + `"`
	writer.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	writer.Header().Set("ETag", etag)
	if request.Header.Get("If-None-Match") == etag {
		writer.WriteHeader(http.StatusNotModified)
		return
	}
	writeJSON(writer, http.StatusOK, version)
}

func (a *API) claimObject(writer http.ResponseWriter, request *http.Request) {
	namespace, worker, className, objectID, ok := readObjectIdentity(writer, request)
	if !ok {
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, 8<<10)
	var input ClaimObjectRequest
	if err := decodeRequest(request.Body, &input); err != nil {
		writeError(writer, http.StatusBadRequest, "object", "invalid_request", "Object placement claim is invalid")
		return
	}
	record, err := a.store.ClaimObject(request.Context(), namespace, worker, className, objectID, input.Placement)
	if err != nil {
		a.writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, record)
}

func (a *API) getObject(writer http.ResponseWriter, request *http.Request) {
	namespace, worker, className, objectID, ok := readObjectIdentity(writer, request)
	if !ok {
		return
	}
	record, err := a.store.GetObject(request.Context(), namespace, worker, className, objectID)
	if err != nil {
		a.writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, record)
}

func (a *API) activateObject(writer http.ResponseWriter, request *http.Request) {
	namespace, worker, className, objectID, ok := readObjectIdentity(writer, request)
	if !ok {
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, 4<<10)
	var input ActivateObjectRequest
	if err := decodeRequest(request.Body, &input); err != nil || validateActorID(input.ActorID) != nil {
		writeError(writer, http.StatusBadRequest, "object", "invalid_request", "Actor activation is invalid")
		return
	}
	record, err := a.store.ActivateObject(request.Context(), namespace, worker, className, objectID, input.ActorID)
	if err != nil {
		a.writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, record)
}

func (a *API) deleteObject(writer http.ResponseWriter, request *http.Request) {
	namespace, worker, className, objectID, ok := readObjectIdentity(writer, request)
	if !ok {
		return
	}
	record, err := a.store.DeleteObject(request.Context(), namespace, worker, className, objectID)
	if err != nil {
		a.writeStoreError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, record)
}

func (a *API) readVersion(writer http.ResponseWriter, request *http.Request) (WorkerVersion, bool) {
	namespace, worker, versionID := request.PathValue("namespace"), request.PathValue("worker"), request.PathValue("version")
	if err := validateIdentity(namespace, worker); err != nil || !validVersionID(versionID) {
		writeError(writer, http.StatusBadRequest, "worker", "invalid_version", "Worker identity or version ID is invalid")
		return WorkerVersion{}, false
	}
	version, err := a.store.GetVersion(request.Context(), namespace, worker, versionID)
	if err != nil {
		a.writeStoreError(writer, err)
		return WorkerVersion{}, false
	}
	return version, true
}

func (a *API) writeStoreError(writer http.ResponseWriter, err error) {
	if errors.Is(err, ErrObjectDeleted) {
		writeError(writer, http.StatusGone, "object", "object_deleted", "The Durable Object was permanently deleted")
		return
	}
	if errors.Is(err, ErrObjectClassNotFound) {
		writeError(writer, http.StatusNotFound, "object", "object_class_not_found", "The active Worker does not export this Durable Object class")
		return
	}
	if errors.Is(err, ErrObjectConflict) {
		writeError(writer, http.StatusConflict, "object", "object_conflict", "The Durable Object Actor identity changed")
		return
	}
	if errors.Is(err, ErrPlacementRequired) {
		writeError(writer, http.StatusPreconditionRequired, "object", "placement_required", "A fresh admission placement is required")
		return
	}
	if errors.Is(err, ErrDurableObjectNamespaces) {
		writeError(writer, http.StatusConflict, "worker", "durable_object_namespaces", "Worker deletion is blocked while Durable Object namespaces are associated")
		return
	}
	if errors.Is(err, ErrNotFound) {
		writeError(writer, http.StatusNotFound, "worker", "not_found", "Worker or version was not found")
		return
	}
	slog.Error("read Worker registry storage", "error", err)
	writeError(writer, http.StatusInternalServerError, "worker_registry", "storage_error", "Worker registry storage is inconsistent or unavailable")
}

func readObjectIdentity(writer http.ResponseWriter, request *http.Request) (string, string, string, string, bool) {
	namespace, worker := request.PathValue("namespace"), request.PathValue("worker")
	className, objectID := request.PathValue("class"), request.PathValue("object")
	if err := validateObjectIdentity(namespace, worker, className, objectID); err != nil {
		writeError(writer, http.StatusBadRequest, "object", "invalid_object", "Durable Object identity is invalid")
		return "", "", "", "", false
	}
	return namespace, worker, className, objectID, true
}

func readPagination(writer http.ResponseWriter, request *http.Request) (int, int, bool) {
	page, perPage := 1, defaultListPageSize
	for name, destination := range map[string]*int{"page": &page, "per_page": &perPage} {
		value := request.URL.Query().Get(name)
		if value == "" {
			continue
		}
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 {
			writeError(writer, http.StatusBadRequest, "pagination", "invalid_pagination", "page and per_page must be positive integers")
			return 0, 0, false
		}
		*destination = parsed
	}
	if perPage > maxListPageSize || page > maxListPage {
		writeError(writer, http.StatusBadRequest, "pagination", "invalid_pagination", fmt.Sprintf("per_page and page must not exceed %d", maxListPageSize))
		return 0, 0, false
	}
	return page, perPage, true
}

func decodeRequest(reader io.Reader, destination any) error {
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return fmt.Errorf("request must contain one JSON value")
		}
		return err
	}
	return nil
}

func writeError(writer http.ResponseWriter, status int, group, code, message string) {
	writeJSON(writer, status, apiError{Group: group, Code: code, Message: message, Metadata: nil})
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}
