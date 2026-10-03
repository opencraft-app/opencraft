package workersapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"mime"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/rivet-dev/rivet/infra/cells/internal/workersapi/objectrouter"
)

const (
	defaultMaxRequestBytes            int64 = 16 << 20
	defaultMaxConcurrentPrepares            = 4
	defaultActorCacheCapacity               = 32_768
	defaultActorCacheIdleTTL                = 10 * time.Minute
	defaultObjectMissCapacity               = 4_096
	defaultDeploymentCacheCapacity          = 4_096
	defaultFetchResponseHeaderTimeout       = 25 * time.Second
	actorInputSchema                        = "minisandbox-durable-object/v1"
	publicOriginalURLHeader                 = "X-Workers-Original-URL"
	internalOriginalURLHeader               = "X-Rivet-Original-URL"
)

var (
	namePattern             = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)
	bindingPattern          = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,127}$`)
	classPattern            = regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$]{0,127}$`)
	objectPattern           = regexp.MustCompile(`^[0-9a-f]{64}$`)
	versionPattern          = regexp.MustCompile(`^v_[0-9a-f]{64}$`)
	deploymentPattern       = regexp.MustCompile(`^d_[0-9a-f]{32}$`)
	deploymentCursorPattern = regexp.MustCompile(`^c_[0-9a-f]{32}$`)
	digestPattern           = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
)

type Config struct {
	RegistryURL                string
	EngineURLs                 []string
	EngineCells                []string
	EngineCellUIDs             []string
	EnginePoolUIDs             []string
	Datacenters                []string
	EngineTokens               []string
	Namespace                  string
	RunnerNameSelector         string
	InternalToken              string
	ObjectRouterTokens         []string
	StatelessExecutorURLs      []string
	StatelessExecutorCellUIDs  []string
	StatelessExecutorTokens    []string
	MaxRequestBytes            int64
	RequestTimeout             time.Duration
	PrepareTimeout             time.Duration
	MaxConcurrentPrepares      int
	ActorReadyTimeout          time.Duration
	FetchResponseHeaderTimeout time.Duration
	ActorCacheCapacity         int
	ActorCacheIdleTTL          time.Duration
	ObjectMissCapacity         int
	DeploymentCacheCapacity    int
	PlacementResolver          PlacementResolver
	ServingRouteResolver       ServingRouteResolver
}

type API struct {
	registry              *url.URL
	engines               []*url.URL
	engineRouteByUID      map[string]engineRoute
	engineTokens          []string
	engineTokensByCell    map[string]string
	dynamicEngineTokens   sync.Map
	namespace             string
	runnerNameSelector    string
	internalToken         string
	objectRouterTokens    []string
	objectRouterSources   []string
	statelessExecutors    []statelessExecutor
	statelessTokensByCell map[string]string
	servingRoutes         ServingRouteResolver
	executorSequence      atomic.Uint64
	maxRequestBytes       int64
	prepareTimeout        time.Duration
	preparePermits        chan struct{}
	actorReadyTimeout     time.Duration
	placementResolver     PlacementResolver
	client                *http.Client
	fetchClient           *http.Client
	mux                   *http.ServeMux
	internalMux           *http.ServeMux
	objectRouter          *objectrouter.Router[actorBinding]
	metrics               *apiMetrics
	deployments           *deploymentCache
	deploymentReads       *deploymentReadGroup
	deploymentWatchOnce   sync.Once
}

type actorBinding struct {
	actorID       string
	engine        *url.URL
	placement     registryPlacement
	routeRevision int64
}

// engineRoute is immutable serving identity for one exact Cell incarnation.
// Cell names are operator-facing labels and may be reused after retirement;
// Cell and Pool UIDs prevent a replacement from inheriting old Object
// placements merely because it has the same name and datacenter.
type engineRoute struct {
	cellName   string
	cellUID    string
	poolUID    string
	datacenter string
	engine     *url.URL
}

type statelessExecutor struct {
	cellUID  string
	pool     string
	endpoint *url.URL
	token    string
}

func NewAPI(config Config) (*API, error) {
	registry, err := parseBaseURL(config.RegistryURL)
	if err != nil {
		return nil, fmt.Errorf("registry URL: %w", err)
	}
	if config.PlacementResolver == nil {
		return nil, errors.New("a fail-closed placement resolver is required")
	}
	routeCount := len(config.EngineCellUIDs)
	if routeCount == 0 {
		return nil, errors.New("at least one Engine Cell identity is required")
	}
	if len(config.EngineCells) != routeCount {
		return nil, errors.New("Engine Cell count must match Engine Cell UID count")
	}
	if len(config.EnginePoolUIDs) != routeCount {
		return nil, errors.New("Engine Pool UID count must match Engine Cell UID count")
	}
	if len(config.Datacenters) != routeCount {
		return nil, errors.New("datacenter count must match Engine Cell UID count")
	}
	if len(config.EngineURLs) != 0 && len(config.EngineURLs) != routeCount {
		return nil, errors.New("Engine URL count must be zero or match Engine Cell UID count")
	}
	if config.ServingRouteResolver == nil && len(config.EngineURLs) != routeCount {
		return nil, errors.New("static serving routes require one Engine URL per Cell")
	}
	if len(config.EngineTokens) != 0 && len(config.EngineTokens) != routeCount {
		return nil, errors.New("Engine token count must be zero or match Engine Cell UID count")
	}
	objectRouterTokens := append([]string(nil), config.ObjectRouterTokens...)
	if len(objectRouterTokens) != 0 && len(objectRouterTokens) != routeCount {
		return nil, errors.New("Object Router token count must be zero or match Engine Cell UID count")
	}
	seenObjectRouterTokens := make(map[string]struct{}, len(objectRouterTokens))
	for _, token := range objectRouterTokens {
		if len(token) < 16 {
			return nil, errors.New("Object Router token must contain at least 16 characters")
		}
		if _, duplicate := seenObjectRouterTokens[token]; duplicate {
			return nil, errors.New("Object Router tokens must be unique")
		}
		seenObjectRouterTokens[token] = struct{}{}
	}
	statelessConfigured := len(config.StatelessExecutorCellUIDs) != 0 || len(config.StatelessExecutorURLs) != 0 || len(config.StatelessExecutorTokens) != 0
	statelessCellUIDs := append([]string(nil), config.StatelessExecutorCellUIDs...)
	if statelessConfigured && len(statelessCellUIDs) == 0 {
		statelessCellUIDs = append(statelessCellUIDs, config.EngineCellUIDs...)
	}
	if statelessConfigured && (len(statelessCellUIDs) != routeCount || (len(config.StatelessExecutorURLs) != 0 && len(config.StatelessExecutorURLs) != routeCount)) {
		return nil, errors.New("stateless executor Cell/URL counts must match Engine Cell identities")
	}
	if statelessConfigured && config.ServingRouteResolver == nil && len(config.StatelessExecutorURLs) != routeCount {
		return nil, errors.New("static serving routes require one stateless executor URL per Cell")
	}
	if len(config.StatelessExecutorTokens) != 0 && len(config.StatelessExecutorTokens) != routeCount {
		return nil, errors.New("stateless executor token count must be zero or match Cell count")
	}
	statelessExecutors := make([]statelessExecutor, 0, len(config.StatelessExecutorURLs))
	statelessTokensByCell := make(map[string]string, routeCount)
	for index, cellUID := range statelessCellUIDs {
		if !validRouteUID(cellUID) {
			return nil, errors.New("stateless executor Cell UID is invalid")
		}
		token := config.InternalToken
		if len(config.StatelessExecutorTokens) != 0 {
			token = config.StatelessExecutorTokens[index]
		}
		if len(token) < 16 {
			return nil, errors.New("stateless executor token must contain at least 16 characters")
		}
		if _, duplicate := statelessTokensByCell[cellUID]; duplicate {
			return nil, errors.New("stateless executor Cell UID mappings must be unique")
		}
		statelessTokensByCell[cellUID] = token
	}
	for index, raw := range config.StatelessExecutorURLs {
		endpoint, err := parseBaseURL(raw)
		if err != nil {
			return nil, fmt.Errorf("stateless executor URL: %w", err)
		}
		statelessExecutors = append(statelessExecutors, statelessExecutor{
			cellUID: statelessCellUIDs[index], pool: config.EnginePoolUIDs[index], endpoint: endpoint,
			token: statelessTokensByCell[statelessCellUIDs[index]],
		})
	}
	engines := make([]*url.URL, 0, len(config.EngineURLs))
	engineRouteByUID := make(map[string]engineRoute, routeCount)
	cellNames := make(map[string]struct{}, routeCount)
	for index := 0; index < routeCount; index++ {
		cell := config.EngineCells[index]
		cellUID := config.EngineCellUIDs[index]
		poolUID := config.EnginePoolUIDs[index]
		datacenter := config.Datacenters[index]
		if !namePattern.MatchString(cell) || !namePattern.MatchString(datacenter) {
			return nil, errors.New("Engine Cell or datacenter is invalid")
		}
		if !validRouteUID(cellUID) || !validRouteUID(poolUID) {
			return nil, errors.New("Engine Cell or Pool UID is invalid")
		}
		if _, exists := cellNames[cell]; exists {
			return nil, errors.New("Engine Cell mappings must be unique")
		}
		if _, exists := engineRouteByUID[cellUID]; exists {
			return nil, errors.New("Engine Cell UID mappings must be unique")
		}
		cellNames[cell] = struct{}{}
		engineRouteByUID[cellUID] = engineRoute{
			cellName: cell, cellUID: cellUID, poolUID: poolUID,
			datacenter: datacenter,
		}
	}
	for index, raw := range config.EngineURLs {
		engine, err := parseBaseURL(raw)
		if err != nil {
			return nil, fmt.Errorf("Engine URL: %w", err)
		}
		engines = append(engines, engine)
		route := engineRouteByUID[config.EngineCellUIDs[index]]
		route.engine = engine
		engineRouteByUID[config.EngineCellUIDs[index]] = route
	}
	engineTokens := append([]string(nil), config.EngineTokens...)
	if len(engineTokens) == 0 {
		engineTokens = make([]string, routeCount)
		for index := range engineTokens {
			engineTokens[index] = config.InternalToken
		}
	}
	engineTokensByCell := make(map[string]string, routeCount)
	for index, cellUID := range config.EngineCellUIDs {
		engineTokensByCell[cellUID] = engineTokens[index]
	}
	servingRoutes := config.ServingRouteResolver
	if servingRoutes == nil {
		staticRoutes := make(map[string]ServingRoute, routeCount)
		for index, cellUID := range config.EngineCellUIDs {
			route := ServingRoute{
				PoolUID: config.EnginePoolUIDs[index], CellName: config.EngineCells[index],
				CellUID: cellUID, Datacenter: config.Datacenters[index],
				ActorGateway:    engines[index],
				ServiceIdentity: "actor-cell/" + cellUID, Revision: 1,
			}
			if statelessConfigured {
				route.StatelessExecutor = statelessExecutors[index].endpoint
			}
			staticRoutes[cellUID] = route
		}
		servingRoutes = &staticServingRouteResolver{routes: staticRoutes}
	}
	namespace := config.Namespace
	if namespace == "" {
		namespace = "default"
	}
	if !namePattern.MatchString(namespace) {
		return nil, errors.New("namespace is invalid")
	}
	runner := config.RunnerNameSelector
	if runner == "" {
		runner = "workerd"
	}
	if !namePattern.MatchString(runner) {
		return nil, errors.New("runner name selector is invalid")
	}
	requestTimeout := config.RequestTimeout
	if requestTimeout <= 0 {
		requestTimeout = 60 * time.Second
	}
	prepareTimeout := config.PrepareTimeout
	if prepareTimeout <= 0 {
		prepareTimeout = 30 * time.Second
	}
	maxConcurrentPrepares := config.MaxConcurrentPrepares
	if maxConcurrentPrepares <= 0 {
		maxConcurrentPrepares = defaultMaxConcurrentPrepares
	}
	actorReadyTimeout := config.ActorReadyTimeout
	if actorReadyTimeout <= 0 {
		actorReadyTimeout = 3 * time.Second
	}
	fetchResponseHeaderTimeout := config.FetchResponseHeaderTimeout
	if fetchResponseHeaderTimeout <= 0 {
		fetchResponseHeaderTimeout = defaultFetchResponseHeaderTimeout
	}
	actorCacheCapacity := config.ActorCacheCapacity
	if actorCacheCapacity <= 0 {
		actorCacheCapacity = defaultActorCacheCapacity
	}
	actorCacheIdleTTL := config.ActorCacheIdleTTL
	if actorCacheIdleTTL <= 0 {
		actorCacheIdleTTL = defaultActorCacheIdleTTL
	}
	objectMissCapacity := config.ObjectMissCapacity
	if objectMissCapacity <= 0 {
		objectMissCapacity = defaultObjectMissCapacity
	}
	deploymentCacheCapacity := config.DeploymentCacheCapacity
	if deploymentCacheCapacity <= 0 {
		deploymentCacheCapacity = defaultDeploymentCacheCapacity
	}
	maxRequestBytes := config.MaxRequestBytes
	if maxRequestBytes <= 0 {
		maxRequestBytes = defaultMaxRequestBytes
	}
	// A Kubernetes Service may keep an established HTTP/1.1 connection pinned
	// to an Engine Pod after that Pod has been removed from EndpointSlices. A
	// platform rollout must never replay a non-idempotent Worker fetch after an
	// ambiguous transport failure, so do not pool gateway connections across
	// requests. Engine termination first leaves its own Service endpoints and
	// waits for propagation; each subsequent fetch then selects a currently
	// Ready backend. Workers API readiness deliberately does not depend on every
	// Cell Engine: one draining Cell must not remove the global API from service.
	fetchTransport := http.DefaultTransport.(*http.Transport).Clone()
	fetchTransport.DisableKeepAlives = true
	fetchTransport.DialContext = retryEngineDialContext(fetchTransport.DialContext)
	// Bound only the time until Engine produces response headers. Once headers
	// arrive the response body may remain open indefinitely for conversational
	// streaming. Without this deadline a waking or wedged Actor can hold the
	// public request until the caller times out, preventing the API from
	// returning a classified indeterminate_result response.
	fetchTransport.ResponseHeaderTimeout = fetchResponseHeaderTimeout
	api := &API{
		registry:              registry,
		engines:               engines,
		engineRouteByUID:      engineRouteByUID,
		engineTokens:          engineTokens,
		engineTokensByCell:    engineTokensByCell,
		namespace:             namespace,
		runnerNameSelector:    runner,
		internalToken:         config.InternalToken,
		objectRouterTokens:    objectRouterTokens,
		objectRouterSources:   append([]string(nil), config.EngineCellUIDs...),
		statelessExecutors:    statelessExecutors,
		statelessTokensByCell: statelessTokensByCell,
		servingRoutes:         servingRoutes,
		maxRequestBytes:       maxRequestBytes,
		prepareTimeout:        prepareTimeout,
		preparePermits:        make(chan struct{}, maxConcurrentPrepares),
		actorReadyTimeout:     actorReadyTimeout,
		placementResolver:     config.PlacementResolver,
		client:                &http.Client{Timeout: requestTimeout},
		// A conversational fetch may stream for much longer than control-plane
		// operations. Its lifetime is owned by the caller context and the Agent
		// execution policy, not the control client timeout.
		fetchClient:     &http.Client{Transport: fetchTransport},
		mux:             http.NewServeMux(),
		internalMux:     http.NewServeMux(),
		deployments:     newDeploymentCache(deploymentCacheCapacity),
		deploymentReads: newDeploymentReadGroup(deploymentCacheCapacity, requestTimeout),
	}
	api.objectRouter = newObjectRouter(api, actorCacheCapacity, actorCacheIdleTTL, objectMissCapacity)
	api.metrics = newAPIMetrics(namespace, api.objectRouter, api.deploymentReads)
	api.routes()
	return api, nil
}

// Close cancels Registry reads and the Deployment watch during server shutdown.
func (a *API) Close() {
	if a.deploymentReads != nil {
		a.deploymentReads.Close()
	}
}

type dialContextFunc func(context.Context, string, string) (net.Conn, error)

func retryEngineDialContext(dial dialContextFunc) dialContextFunc {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		delay := 10 * time.Millisecond
		for attempt := 0; ; attempt++ {
			connection, err := dial(ctx, network, address)
			if err == nil || attempt == 7 || !retryableEngineDialError(err) {
				return connection, err
			}
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				if !timer.Stop() {
					<-timer.C
				}
				return nil, ctx.Err()
			case <-timer.C:
			}
			if delay < 200*time.Millisecond {
				delay *= 2
				if delay > 200*time.Millisecond {
					delay = 200 * time.Millisecond
				}
			}
		}
	}
}

func retryableEngineDialError(err error) bool {
	return errors.Is(err, syscall.ECONNREFUSED) ||
		errors.Is(err, syscall.EHOSTUNREACH) ||
		errors.Is(err, syscall.ENETUNREACH)
}

func validRouteUID(value string) bool {
	return value != "" && len(value) <= 128 && !strings.ContainsAny(value, "\x00\r\n")
}

func (a *API) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	a.serve(a.mux, writer, request)
}

// InternalHandler returns the capability-gated Object Router listener. It is
// deliberately not mounted below ServeHTTP: Kubernetes can expose the public
// API without making the host-to-Router protocol reachable on that listener.
func (a *API) InternalHandler() http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		a.serve(a.internalMux, writer, request)
	})
}

func (a *API) serve(mux *http.ServeMux, writer http.ResponseWriter, request *http.Request) {
	requestID := request.Header.Get("X-Request-ID")
	if !validRequestID(requestID) {
		requestID = newRequestID()
	}
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.Header().Set("X-Request-ID", requestID)
	mux.ServeHTTP(writer, request.WithContext(context.WithValue(request.Context(), requestIDKey{}, requestID)))
}

func (a *API) routes() {
	a.mux.HandleFunc("GET /healthz", a.health)
	a.mux.HandleFunc("GET /readyz", a.ready)
	a.mux.HandleFunc("GET /metrics", a.metrics.serveHTTP)
	a.mux.HandleFunc("GET /v1/workers", a.listWorkers)
	a.mux.HandleFunc("POST /v1/workers/{worker}/versions", a.uploadVersion)
	a.mux.HandleFunc("GET /v1/workers/{worker}/versions", a.listVersions)
	a.mux.HandleFunc("GET /v1/workers/{worker}/versions/{version}", a.getVersion)
	a.mux.HandleFunc("POST /v1/workers/{worker}/deployments", a.createDeployment)
	a.mux.HandleFunc("GET /v1/workers/{worker}/deployment", a.getActiveDeployment)
	a.mux.HandleFunc("GET /v1/workers/{worker}", a.getWorker)
	a.mux.HandleFunc("DELETE /v1/workers/{worker}", a.deleteWorker)
	a.mux.HandleFunc("PUT /v1/workers/{worker}/objects/{class}/{object}", a.putObject)
	a.mux.HandleFunc("DELETE /v1/workers/{worker}/objects/{class}/{object}", a.deleteObject)
	a.mux.HandleFunc("/v1/workers/{worker}/objects/{class}/{object}/fetch", a.fetchObject)
	a.mux.HandleFunc("/v1/workers/{worker}/dispatch", a.dispatchFetch)
	a.mux.HandleFunc("/v1/", a.notFound)
	a.mux.HandleFunc("/v1", a.notFound)
	a.internalMux.HandleFunc("/internal/v1/workers/{worker}/objects/{class}/{object}/fetch", a.internalFetchObject)
	a.internalMux.HandleFunc("/", a.internalNotFound)
}

func (a *API) health(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *API) notFound(writer http.ResponseWriter, request *http.Request) {
	a.writeError(writer, request, http.StatusNotFound, "not_found", "The requested API resource was not found", false)
}

func (a *API) internalNotFound(writer http.ResponseWriter, request *http.Request) {
	http.NotFound(writer, request)
}

func (a *API) ready(writer http.ResponseWriter, request *http.Request) {
	var status map[string]any
	if err := a.requestJSON(request.Context(), http.MethodGet, a.registryURL("/readyz"), nil, &status); err != nil {
		a.writeUpstreamError(writer, request, err)
		return
	}
	// Capacity and Cell reachability are request-scoped states, not process
	// readiness. Existing Objects remain routable while every Cell is closed to
	// new placement, and an outage of one Cell must not withdraw all three Hub
	// replicas. Resolve() still fails closed for a new Object, while a request to
	// an Object whose selected Engine is unavailable receives the public,
	// retryable worker_unavailable response.
	writeJSON(writer, http.StatusOK, map[string]string{"status": "ready"})
}

func (a *API) uploadVersion(writer http.ResponseWriter, request *http.Request) {
	worker, ok := validWorkerPath(writer, request)
	if !ok {
		return
	}
	var input UploadVersionRequest
	if !a.decodeJSON(writer, request, &input) {
		return
	}
	if !a.validateDurableObjects(writer, request, input.DurableObjects) {
		return
	}
	var result registryVersion
	target := a.registryURL(fmt.Sprintf("/v1/namespaces/%s/workers/%s/versions", url.PathEscape(a.namespace), url.PathEscape(worker)))
	if err := a.requestJSON(request.Context(), http.MethodPost, target, input, &result); err != nil {
		a.writeUpstreamError(writer, request, err)
		return
	}
	if !versionPattern.MatchString(result.VersionID) {
		a.writeError(writer, request, http.StatusBadGateway, "invalid_upstream_response", "The code service returned an invalid Version", true)
		return
	}
	writeJSON(writer, http.StatusCreated, publicVersion(worker, result))
}

func (a *API) getWorker(writer http.ResponseWriter, request *http.Request) {
	worker, ok := validWorkerPath(writer, request)
	if !ok {
		return
	}
	result, upstream := a.registryWorker(request.Context(), worker)
	if upstream != nil {
		a.writeUpstreamError(writer, request, upstream)
		return
	}
	writeJSON(writer, http.StatusOK, publicWorker(result))
}

func (a *API) listWorkers(writer http.ResponseWriter, request *http.Request) {
	var result registryWorkerList
	target := a.registryURL(fmt.Sprintf("/v1/namespaces/%s/workers", url.PathEscape(a.namespace)))
	if err := a.requestJSON(request.Context(), http.MethodGet, target, nil, &result); err != nil {
		a.writeUpstreamError(writer, request, err)
		return
	}
	workers := make([]Worker, 0, len(result.Workers))
	for _, worker := range result.Workers {
		workers = append(workers, publicWorker(worker))
	}
	writeJSON(writer, http.StatusOK, map[string]any{"workers": workers})
}

func (a *API) listVersions(writer http.ResponseWriter, request *http.Request) {
	worker, ok := validWorkerPath(writer, request)
	if !ok {
		return
	}
	var result registryVersionList
	target := a.registryURL(fmt.Sprintf("/v1/namespaces/%s/workers/%s/versions", url.PathEscape(a.namespace), url.PathEscape(worker)))
	target.RawQuery = request.URL.RawQuery
	if err := a.requestJSON(request.Context(), http.MethodGet, target, nil, &result); err != nil {
		a.writeUpstreamError(writer, request, err)
		return
	}
	versions := make([]Version, 0, len(result.Versions))
	for _, version := range result.Versions {
		versions = append(versions, publicVersion(worker, version))
	}
	writeJSON(writer, http.StatusOK, map[string]any{"versions": versions, "page": result.Page, "per_page": result.PerPage})
}

func (a *API) getVersion(writer http.ResponseWriter, request *http.Request) {
	worker, ok := validWorkerPath(writer, request)
	if !ok {
		return
	}
	versionID := request.PathValue("version")
	if !versionPattern.MatchString(versionID) {
		a.writeError(writer, request, http.StatusBadRequest, "invalid_version", "Version ID is invalid", false)
		return
	}
	var result registryVersion
	target := a.registryURL(fmt.Sprintf("/v1/namespaces/%s/workers/%s/versions/%s", url.PathEscape(a.namespace), url.PathEscape(worker), url.PathEscape(versionID)))
	if err := a.requestJSON(request.Context(), http.MethodGet, target, nil, &result); err != nil {
		a.writeUpstreamError(writer, request, err)
		return
	}
	writeJSON(writer, http.StatusOK, publicVersion(worker, result))
}

func (a *API) getActiveDeployment(writer http.ResponseWriter, request *http.Request) {
	worker, ok := validWorkerPath(writer, request)
	if !ok {
		return
	}
	result, upstream := a.registryWorker(request.Context(), worker)
	if upstream != nil {
		a.writeUpstreamError(writer, request, upstream)
		return
	}
	writeJSON(writer, http.StatusOK, publicDeployment(worker, result.Deployment))
}

func (a *API) deleteWorker(writer http.ResponseWriter, request *http.Request) {
	worker, ok := validWorkerPath(writer, request)
	if !ok {
		return
	}
	target := a.registryURL(fmt.Sprintf("/v1/namespaces/%s/workers/%s", url.PathEscape(a.namespace), url.PathEscape(worker)))
	if err := a.requestJSON(request.Context(), http.MethodDelete, target, nil, nil); err != nil {
		a.writeUpstreamError(writer, request, err)
		return
	}
	a.objectRouter.DeleteWorker(worker)
	a.deployments.Invalidate()
	writer.WriteHeader(http.StatusNoContent)
}

func (a *API) createDeployment(writer http.ResponseWriter, request *http.Request) {
	worker, ok := validWorkerPath(writer, request)
	if !ok {
		return
	}
	var input CreateDeploymentRequest
	if !a.decodeJSON(writer, request, &input) {
		return
	}
	targets, validationMessage := deploymentTargets(input)
	if validationMessage != "" {
		a.writeError(writer, request, http.StatusBadRequest, "invalid_deployment", validationMessage, false)
		return
	}
	if input.ExpectedDeploymentID != nil && *input.ExpectedDeploymentID != "" && !deploymentPattern.MatchString(*input.ExpectedDeploymentID) {
		a.writeError(writer, request, http.StatusBadRequest, "invalid_deployment", "Expected Deployment ID is invalid", false)
		return
	}
	expectedDeploymentID := ""
	if current, upstream := a.registryWorker(request.Context(), worker); upstream == nil {
		if sameDeploymentTargets(current.Deployment.Versions, targets) {
			writeJSON(writer, http.StatusOK, publicDeployment(worker, current.Deployment))
			return
		}
		expectedDeploymentID = current.Deployment.ID
		if input.ExpectedDeploymentID != nil && *input.ExpectedDeploymentID != expectedDeploymentID {
			a.writeError(writer, request, http.StatusConflict, "deployment_conflict", "The active Worker Deployment changed", false)
			return
		}
	} else if upstream.Status != http.StatusNotFound {
		a.writeUpstreamError(writer, request, upstream)
		return
	} else if input.ExpectedDeploymentID != nil && *input.ExpectedDeploymentID != "" {
		a.writeError(writer, request, http.StatusConflict, "deployment_conflict", "The active Worker Deployment changed", false)
		return
	}
	if !a.acquirePrepare() {
		// Synchronous prepare is deliberately bounded until it moves to its own
		// durable worker pool. Reject before creating a canary Actor instead of
		// allowing an unbounded HTTP backlog to amplify pressure on Engine/FDB.
		writer.Header().Set("Retry-After", "1")
		a.writeError(writer, request, http.StatusTooManyRequests, "prepare_overloaded", "Worker validation capacity is temporarily full", true)
		return
	}
	defer a.releasePrepare()
	for _, target := range targets {
		if err := a.prepareVersion(request.Context(), requestID(request), worker, target.VersionID); err != nil {
			a.writeUpstreamError(writer, request, err)
			return
		}
	}
	var deployed registryWorker
	target := a.registryURL(fmt.Sprintf("/v1/namespaces/%s/workers/%s/deployments", url.PathEscape(a.namespace), url.PathEscape(worker)))
	internal := map[string]any{
		"strategy":               "percentage",
		"versions":               targets,
		"expected_deployment_id": expectedDeploymentID,
	}
	if err := a.requestJSON(request.Context(), http.MethodPost, target, internal, &deployed); err != nil {
		if err.Code == "deployment_conflict" {
			if current, lookup := a.registryWorker(request.Context(), worker); lookup == nil && sameDeploymentTargets(current.Deployment.Versions, targets) {
				writeJSON(writer, http.StatusOK, publicDeployment(worker, current.Deployment))
				return
			}
		}
		a.writeUpstreamError(writer, request, err)
		return
	}
	a.deployments.ApplyCursor(deployed.DeploymentCursor)
	writeJSON(writer, http.StatusCreated, publicDeployment(worker, deployed.Deployment))
}

func deploymentTargets(input CreateDeploymentRequest) ([]DeploymentVersion, string) {
	if input.VersionID != "" && len(input.Versions) != 0 {
		return nil, "Specify either version_id or versions, not both"
	}
	targets := append([]DeploymentVersion(nil), input.Versions...)
	if input.VersionID != "" {
		targets = []DeploymentVersion{{VersionID: input.VersionID, Percentage: 100}}
	}
	if len(targets) == 0 || len(targets) > 2 {
		return nil, "A Deployment must contain one or two Versions"
	}
	seen := make(map[string]struct{}, len(targets))
	total := uint64(0)
	for _, target := range targets {
		if !versionPattern.MatchString(target.VersionID) {
			return nil, "A Deployment contains an invalid Version ID"
		}
		if _, duplicate := seen[target.VersionID]; duplicate {
			return nil, "A Deployment contains a duplicate Version ID"
		}
		seen[target.VersionID] = struct{}{}
		scaled := target.Percentage * 100
		basisPoints := math.Round(scaled)
		if math.IsNaN(scaled) || math.IsInf(scaled, 0) || basisPoints < 1 || basisPoints > 10_000 || math.Abs(scaled-basisPoints) > 1e-9 {
			return nil, "Deployment percentages must use 0.01% precision and be between 0.01 and 100"
		}
		total += uint64(basisPoints)
	}
	if total != 10_000 {
		return nil, "Deployment percentages must sum to 100"
	}
	return targets, ""
}

func sameDeploymentTargets(left, right []DeploymentVersion) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index].VersionID != right[index].VersionID || left[index].Percentage != right[index].Percentage {
			return false
		}
	}
	return true
}

func (a *API) acquirePrepare() bool {
	select {
	case a.preparePermits <- struct{}{}:
		return true
	default:
		return false
	}
}

func (a *API) releasePrepare() {
	<-a.preparePermits
}

func (a *API) putObject(writer http.ResponseWriter, request *http.Request) {
	worker, className, objectID, ok := validObjectPath(writer, request)
	if !ok {
		return
	}
	if _, err := a.ensureActor(request.Context(), worker, className, objectID); err != nil {
		a.writeUpstreamError(writer, request, err)
		return
	}
	writeJSON(writer, http.StatusOK, ObjectRef{Object: resourceObject, ID: objectID, Worker: worker, ClassName: className})
}

func (a *API) deleteObject(writer http.ResponseWriter, request *http.Request) {
	worker, className, objectID, ok := validObjectPath(writer, request)
	if !ok {
		return
	}
	record, upstream := a.deleteObjectRecord(request.Context(), worker, className, objectID)
	if upstream != nil {
		a.writeUpstreamError(writer, request, upstream)
		return
	}
	a.objectRouter.Delete(objectrouter.Key{Worker: worker, Class: className, ObjectID: objectID})
	actorID := record.ActorID
	// A DELETE for an Object that has never been claimed creates a terminal
	// tombstone without a placement. No Actor can exist in that state because
	// placement is durably committed before Actor creation.
	if actorID == "" && record.Placement == nil {
		writer.WriteHeader(http.StatusNoContent)
		return
	}
	engine, upstream := a.engineForPlacement(request.Context(), record.Placement)
	if upstream != nil {
		a.writeUpstreamError(writer, request, upstream)
		return
	}
	if actorID == "" {
		actorID, upstream = a.findActor(request.Context(), engine, worker, className, objectID)
		if upstream != nil {
			a.writeUpstreamError(writer, request, upstream)
			return
		}
	}
	if actorID != "" {
		if upstream := a.deleteActor(request.Context(), engine, actorID); upstream != nil {
			a.writeUpstreamError(writer, request, upstream)
			return
		}
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (a *API) fetchObject(writer http.ResponseWriter, request *http.Request) {
	worker, className, objectID, ok := validObjectPath(writer, request)
	if !ok {
		return
	}
	a.fetchActor(writer, request, worker, className, objectID)
}

func (a *API) dispatchFetch(writer http.ResponseWriter, request *http.Request) {
	worker, ok := validWorkerPath(writer, request)
	if !ok {
		return
	}
	metricPoolName := "unassigned"
	metricStatus := http.StatusServiceUnavailable
	metricCode := ""
	finishRouting := a.metrics.beginRouting(a.namespace, "stateless")
	defer func() {
		finishRouting(metricStatus, metricCode)
		a.metrics.dispatch.WithLabelValues(
			a.namespace, metricPool(metricPoolName), metricResult(metricStatus, metricCode),
		).Inc()
	}()
	originalURL, err := validateOriginalURL(request.Header.Get(publicOriginalURLHeader))
	if err != nil {
		metricStatus = http.StatusBadRequest
		a.writeError(writer, request, http.StatusBadRequest, "invalid_original_url", err.Error(), false)
		return
	}
	executors, routeErr := a.statelessServingExecutors(request.Context())
	if routeErr != nil {
		a.writeError(writer, request, http.StatusServiceUnavailable, "executor_unavailable", "No stateless Worker executor is available", true)
		return
	}
	current, upstream := a.activeWorker(request.Context(), worker)
	if upstream != nil {
		a.writeUpstreamError(writer, request, upstream)
		return
	}
	versionID, upstream := selectStatelessVersion(a.namespace, worker, requestID(request), current)
	if upstream != nil {
		a.writeUpstreamError(writer, request, upstream)
		return
	}
	executorIndex := (a.executorSequence.Add(1) - 1) % uint64(len(executors))
	executor := executors[executorIndex]
	metricPoolName = executor.pool
	target := engineURL(executor.endpoint, fmt.Sprintf("/internal/v1/workers/%s/versions/%s/dispatch", url.PathEscape(worker), url.PathEscape(versionID)))
	forwarded, err := http.NewRequestWithContext(request.Context(), request.Method, target.String(), request.Body)
	if err != nil {
		metricStatus = http.StatusInternalServerError
		a.writeError(writer, request, http.StatusInternalServerError, "internal_error", "The Worker request could not be created", false)
		return
	}
	copyHeaders(forwarded.Header, request.Header, true)
	forwarded.Header.Del(publicOriginalURLHeader)
	forwarded.Header.Del("X-Workers-Error")
	stripInternalHeaders(forwarded.Header)
	forwarded.Header.Set(internalOriginalURLHeader, originalURL.String())
	forwarded.Header.Set(statelessExecutorTokenHeader, executor.token)
	response, err := a.fetchClient.Do(forwarded)
	if err != nil {
		slog.WarnContext(request.Context(), "stateless Worker transport failed",
			"request_id", requestID(request), "executor", executor.endpoint.Host, "error", err)
		// The request body may already have entered user code. Retrying on a
		// different executor would duplicate non-idempotent side effects.
		metricStatus, metricCode = http.StatusBadGateway, "indeterminate_result"
		a.writeError(writer, request, metricStatus, metricCode, "The Worker result is indeterminate", false)
		return
	}
	defer response.Body.Close()
	metricStatus = response.StatusCode
	copyHeaders(writer.Header(), response.Header, false)
	writer.Header().Del("X-Workers-Error")
	writer.WriteHeader(response.StatusCode)
	if _, err := io.Copy(writer, response.Body); err != nil {
		// Response headers have already reached the caller, so it is no longer
		// possible to replace the partial response with a JSON error. Abort the
		// downstream stream instead of returning normally: net/http would
		// otherwise terminate chunked encoding cleanly and make a truncated user
		// response look successful. ErrAbortHandler closes HTTP/1 connections or
		// resets HTTP/2 streams without a server stack trace. Never replay the
		// request because user code may already have committed side effects.
		metricStatus, metricCode = http.StatusBadGateway, "indeterminate_result"
		slog.WarnContext(request.Context(), "stateless Worker response stream failed",
			"request_id", requestID(request), "executor", executor.endpoint.Host, "error", err)
		panic(http.ErrAbortHandler)
	}
}

func selectStatelessVersion(namespace, worker, rolloutKey string, current registryWorker) (string, *upstreamError) {
	if current.Name != worker || current.Deployment.Worker != worker || !deploymentPattern.MatchString(current.Deployment.ID) || len(current.Deployment.Versions) == 0 || len(current.Deployment.Versions) > 2 {
		return "", &upstreamError{Status: http.StatusBadGateway, Code: "invalid_upstream_response", Message: "The code service returned an invalid active Deployment", Retryable: true}
	}
	available := make(map[string]struct{}, len(current.Versions))
	for _, version := range current.Versions {
		available[version.VersionID] = struct{}{}
	}
	hash := sha256.New()
	for _, component := range []string{"rivet-worker-request-assignment/v1", namespace, worker, rolloutKey} {
		_, _ = hash.Write([]byte(component))
		_, _ = hash.Write([]byte{0})
	}
	digestBytes := hash.Sum(nil)
	bucket := binary.BigEndian.Uint64(digestBytes[:8]) % 10_000
	widths := make([]uint64, 0, len(current.Deployment.Versions))
	total := uint64(0)
	seen := make(map[string]struct{}, len(current.Deployment.Versions))
	for _, target := range current.Deployment.Versions {
		if !versionPattern.MatchString(target.VersionID) {
			return "", invalidDeploymentUpstream()
		}
		if _, ok := available[target.VersionID]; !ok {
			return "", invalidDeploymentUpstream()
		}
		if _, duplicate := seen[target.VersionID]; duplicate {
			return "", invalidDeploymentUpstream()
		}
		seen[target.VersionID] = struct{}{}
		scaled := target.Percentage * 100
		basisPoints := math.Round(scaled)
		if !math.IsNaN(scaled) && !math.IsInf(scaled, 0) && basisPoints >= 1 && basisPoints <= 10_000 && math.Abs(scaled-basisPoints) <= 1e-9 {
			width := uint64(basisPoints)
			widths = append(widths, width)
			total += width
		} else {
			return "", invalidDeploymentUpstream()
		}
	}
	if total != 10_000 {
		return "", invalidDeploymentUpstream()
	}
	upper := uint64(0)
	for index, target := range current.Deployment.Versions {
		upper += widths[index]
		if bucket < upper {
			return target.VersionID, nil
		}
	}
	return "", invalidDeploymentUpstream()
}

func invalidDeploymentUpstream() *upstreamError {
	return &upstreamError{Status: http.StatusBadGateway, Code: "invalid_upstream_response", Message: "The code service returned an invalid active Deployment", Retryable: true}
}

func (a *API) fetchActor(writer http.ResponseWriter, request *http.Request, worker, className, objectID string) {
	originalURL, err := validateOriginalURL(request.Header.Get(publicOriginalURLHeader))
	if err != nil {
		a.writeError(writer, request, http.StatusBadRequest, "invalid_original_url", err.Error(), false)
		return
	}
	a.fetchActorAtURL(writer, request, worker, className, objectID, originalURL)
}

func (a *API) fetchActorAtURL(writer http.ResponseWriter, request *http.Request, worker, className, objectID string, originalURL *url.URL) {
	started := time.Now()
	sourceCell := objectRouterSourceFromContext(request.Context())
	targetCell := "unassigned"
	metricStatus := http.StatusServiceUnavailable
	metricCode := ""
	finishRouting := a.metrics.beginRouting(a.namespace, "object")
	defer func() {
		finishRouting(metricStatus, metricCode)
		a.metrics.objectDuration.WithLabelValues(
			a.namespace, metricCell(sourceCell), metricCell(targetCell),
		).Observe(time.Since(started).Seconds())
		a.metrics.objectRequests.WithLabelValues(
			a.namespace, metricCell(sourceCell), metricCell(targetCell),
			metricResult(metricStatus, metricCode),
		).Inc()
	}()
	binding, upstream := a.ensureActor(request.Context(), worker, className, objectID)
	if upstream != nil {
		metricStatus, metricCode = upstream.Status, upstream.Code
		a.writeUpstreamError(writer, request, upstream)
		return
	}
	if binding.actorID == "" || binding.engine == nil {
		metricStatus, metricCode = http.StatusServiceUnavailable, "placement_unavailable"
		a.writeError(writer, request, http.StatusServiceUnavailable, "placement_unavailable", "The Object placement is unavailable", true)
		return
	}
	targetCell = binding.placement.CellName
	a.metrics.setRouteRevision(binding.placement.PoolUID, targetCell, binding.routeRevision)
	a.metrics.indeterminate.WithLabelValues(a.namespace, metricCell(targetCell)).Add(0)
	inflight := a.metrics.objectInflight.WithLabelValues(a.namespace, metricCell(targetCell))
	inflight.Inc()
	defer inflight.Dec()
	engine := binding.engine
	target := engineURL(engine, "/gateway/"+url.PathEscape(binding.actorID)+"/")
	forwarded, err := http.NewRequestWithContext(request.Context(), request.Method, target.String(), request.Body)
	if err != nil {
		metricStatus = http.StatusInternalServerError
		a.writeError(writer, request, http.StatusInternalServerError, "internal_error", "The Worker request could not be created", false)
		return
	}
	copyHeaders(forwarded.Header, request.Header, true)
	forwarded.Header.Del(publicOriginalURLHeader)
	forwarded.Header.Del(objectRouterTokenHeader)
	forwarded.Header.Del("X-Workers-Error")
	stripInternalHeaders(forwarded.Header)
	forwarded.Header.Set(internalOriginalURLHeader, originalURL.String())
	if token := a.tokenForURL(engine); token != "" {
		forwarded.Header.Set("Authorization", "Bearer "+token)
	}
	forwarded, transportTrace := traceFetchRequest(forwarded)
	response, err := a.fetchClient.Do(forwarded)
	if err != nil {
		attrs := append(transportTrace.attributes(),
			slog.String("request_id", requestID(request)), slog.String("engine", engine.Host),
			slog.Any("error", err))
		slog.Default().LogAttrs(request.Context(), slog.LevelWarn, "Worker fetch transport failed", attrs...)
		// Once the request is handed to the HTTP transport, the target Object may
		// already have executed and committed a side effect even if no response
		// headers reached the Router. Do not advertise a transparent retry: doing
		// so would turn single-active ownership into a false exactly-once promise.
		metricStatus, metricCode = http.StatusBadGateway, "indeterminate_result"
		a.metrics.indeterminate.WithLabelValues(a.namespace, metricCell(targetCell)).Inc()
		a.writeError(writer, request, metricStatus, metricCode, "The Worker result is indeterminate", false)
		return
	}
	defer response.Body.Close()
	metricStatus = response.StatusCode
	copyHeaders(writer.Header(), response.Header, false)
	writer.Header().Del("X-Workers-Error")
	writer.WriteHeader(response.StatusCode)
	if _, err := io.Copy(writer, response.Body); err != nil {
		metricStatus, metricCode = http.StatusBadGateway, "indeterminate_result"
		a.metrics.indeterminate.WithLabelValues(a.namespace, metricCell(targetCell)).Inc()
		slog.WarnContext(request.Context(), "Worker response stream failed",
			"request_id", requestID(request), "engine", engine.Host, "error", err)
		panic(http.ErrAbortHandler)
	}
}

func (a *API) ensureActor(ctx context.Context, worker, className, objectID string) (actorBinding, *upstreamError) {
	binding, err := a.objectRouter.Resolve(ctx, objectrouter.Key{
		Worker: worker, Class: className, ObjectID: objectID,
	})
	if err == nil {
		return binding, nil
	}
	var upstream *upstreamError
	if errors.As(err, &upstream) {
		return actorBinding{}, upstream
	}
	if errors.Is(err, objectrouter.ErrOverloaded) {
		return actorBinding{}, &upstreamError{
			Status: http.StatusServiceUnavailable, Code: "object_router_overloaded",
			Message: "The Object Router has too many concurrent placement misses", Retryable: true,
		}
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return actorBinding{}, objectMissContextError(ctx)
	}
	return actorBinding{}, &upstreamError{
		Status: http.StatusInternalServerError, Code: "internal_error",
		Message: "The Object Router failed", Retryable: false,
	}
}

func (a *API) ensureActorUncached(ctx context.Context, worker, className, objectID string) (actorBinding, *upstreamError) {
	cacheKey := objectCacheKey(worker, className, objectID)
	readyContext, cancel := context.WithTimeout(ctx, a.actorReadyTimeout)
	defer cancel()
	ctx = readyContext
	var placement *registryPlacement
	if className != "" {
		record, err := a.claimObject(ctx, worker, className, objectID, nil)
		if err != nil && err.Code == "placement_required" {
			decision, resolveErr := a.placementResolver.Resolve(ctx, cacheKey)
			if resolveErr != nil {
				return actorBinding{}, placementUpstreamError(resolveErr)
			}
			record, err = a.claimObject(ctx, worker, className, objectID, &decision)
		}
		if err != nil {
			return actorBinding{}, actorReadyError(readyContext, err)
		}
		if record.Placement == nil {
			return actorBinding{}, &upstreamError{Status: http.StatusBadGateway, Code: "invalid_upstream_response", Message: "The code service returned an object without placement", Retryable: true}
		}
		placement = record.Placement
		if record.ActorID != "" {
			engine, upstream := a.engineForPlacement(ctx, record.Placement)
			if upstream != nil {
				return actorBinding{}, upstream
			}
			route, _ := a.servingRoutes.RouteForPlacement(ctx, record.Placement)
			return actorBinding{
				actorID: record.ActorID, engine: engine, placement: *record.Placement,
				routeRevision: route.Revision,
			}, nil
		}
	} else {
		current, err := a.registryWorker(ctx, worker)
		if err != nil {
			return actorBinding{}, actorReadyError(readyContext, err)
		}
		if _, ok := activeVersionSummary(current); !ok {
			return actorBinding{}, &upstreamError{Status: http.StatusBadGateway, Code: "invalid_upstream_response", Message: "The code service returned an invalid active Version", Retryable: true}
		}
		decision, resolveErr := a.placementResolver.Resolve(ctx, cacheKey)
		if resolveErr != nil {
			return actorBinding{}, placementUpstreamError(resolveErr)
		}
		placement = &decision
	}
	actorID := ""
	identity := className
	if identity == "" {
		identity = "default"
	}
	input := ""
	if className != "" {
		encoded, _ := json.Marshal(map[string]string{"schema": actorInputSchema, "class_name": className})
		input = base64.StdEncoding.EncodeToString(encoded)
	}
	body := map[string]any{
		"name":                 "mf-" + digest(worker, identity)[:24],
		"key":                  objectID,
		"worker":               map[string]string{"worker": worker},
		"runner_name_selector": a.runnerNameSelector,
		"crash_policy":         "restart",
	}
	if input != "" {
		body["input"] = input
	}
	engine, upstream := a.engineForPlacement(ctx, placement)
	if upstream != nil {
		return actorBinding{}, upstream
	}
	body["datacenter"] = placement.Datacenter
	target := engineURL(engine, "/actors")
	target.RawQuery = url.Values{"namespace": []string{a.namespace}}.Encode()
	var created actorCreateResponse
	if err := a.requestJSON(ctx, http.MethodPut, target, body, &created); err != nil {
		return actorBinding{}, actorReadyError(readyContext, err)
	}
	if created.Actor.ActorID == "" {
		return actorBinding{}, &upstreamError{Status: http.StatusBadGateway, Code: "invalid_upstream_response", Message: "The runtime omitted the Actor ID", Retryable: true}
	}
	if className != "" {
		record, err := a.activateObject(ctx, worker, className, objectID, created.Actor.ActorID)
		if err != nil {
			if errors.Is(readyContext.Err(), context.DeadlineExceeded) {
				// Activation may have committed and only lost its response. Deleting
				// here would race a retry that observes the durable Actor binding.
				return actorBinding{}, actorReadyError(readyContext, err)
			}
			if cleanup := a.deleteActor(context.WithoutCancel(ctx), engine, created.Actor.ActorID); cleanup != nil {
				slog.Warn("delete rejected Durable Object Actor", "actorID", created.Actor.ActorID, "error", cleanup)
			}
			return actorBinding{}, err
		}
		actorID = record.ActorID
	} else {
		actorID = created.Actor.ActorID
	}
	route, _ := a.servingRoutes.RouteForPlacement(ctx, placement)
	return actorBinding{
		actorID: actorID, engine: engine, placement: *placement, routeRevision: route.Revision,
	}, nil
}

func actorReadyError(ctx context.Context, err *upstreamError) *upstreamError {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return &upstreamError{
			Status:    http.StatusGatewayTimeout,
			Code:      "actor_ready_timeout",
			Message:   "The Agent did not become ready within 3 seconds",
			Retryable: true,
		}
	}
	return err
}

func placementUpstreamError(err error) *upstreamError {
	slog.Warn("Agent placement unavailable", "error", err)
	return &upstreamError{
		Status: http.StatusServiceUnavailable, Code: "no_admission_capacity",
		Message: "No fresh admitted Cell is available", Retryable: true,
	}
}

func (a *API) claimObject(ctx context.Context, worker, className, objectID string, placement *registryPlacement) (registryObject, *upstreamError) {
	started := time.Now()
	var record registryObject
	target := a.objectRegistryURL(worker, className, objectID)
	err := a.requestJSON(ctx, http.MethodPut, target, claimObjectRequest{Placement: placement}, &record)
	a.metrics.observeRegistry(a.namespace, "claim", started, err)
	return record, err
}

func (a *API) activateObject(ctx context.Context, worker, className, objectID, actorID string) (registryObject, *upstreamError) {
	started := time.Now()
	var record registryObject
	target := a.objectRegistryURL(worker, className, objectID)
	target.Path += "/activate"
	err := a.requestJSON(ctx, http.MethodPost, target, map[string]string{"actor_id": actorID}, &record)
	a.metrics.observeRegistry(a.namespace, "activate", started, err)
	return record, err
}

func (a *API) deleteObjectRecord(ctx context.Context, worker, className, objectID string) (registryObject, *upstreamError) {
	started := time.Now()
	var record registryObject
	err := a.requestJSON(ctx, http.MethodDelete, a.objectRegistryURL(worker, className, objectID), nil, &record)
	a.metrics.observeRegistry(a.namespace, "delete", started, err)
	return record, err
}

func (a *API) objectRegistryURL(worker, className, objectID string) *url.URL {
	return a.registryURL(fmt.Sprintf("/internal/v1/namespaces/%s/workers/%s/objects/%s/%s", url.PathEscape(a.namespace), url.PathEscape(worker), url.PathEscape(className), url.PathEscape(objectID)))
}

func (a *API) findActor(ctx context.Context, engine *url.URL, worker, className, objectID string) (string, *upstreamError) {
	identity := className
	if identity == "" {
		identity = "default"
	}
	target := engineURL(engine, "/actors")
	target.RawQuery = url.Values{
		"namespace":         []string{a.namespace},
		"name":              []string{"mf-" + digest(worker, identity)[:24]},
		"key":               []string{objectID},
		"include_destroyed": []string{"false"},
		"limit":             []string{"2"},
	}.Encode()
	var listed actorListResponse
	if err := a.requestJSON(ctx, http.MethodGet, target, nil, &listed); err != nil {
		return "", err
	}
	if len(listed.Actors) == 0 {
		return "", nil
	}
	if len(listed.Actors) != 1 || listed.Actors[0].ActorID == "" {
		return "", &upstreamError{Status: http.StatusBadGateway, Code: "invalid_upstream_response", Message: "The runtime returned an ambiguous Durable Object identity", Retryable: true}
	}
	return listed.Actors[0].ActorID, nil
}

func (a *API) deleteActor(ctx context.Context, engine *url.URL, actorID string) *upstreamError {
	target := engineURL(engine, "/actors/"+url.PathEscape(actorID))
	target.RawQuery = url.Values{"namespace": []string{a.namespace}}.Encode()
	return a.requestJSON(ctx, http.MethodDelete, target, nil, nil)
}

func objectCacheKey(worker, className, objectID string) string {
	return worker + "\x00" + className + "\x00" + objectID
}

func (a *API) prepareVersion(ctx context.Context, requestID, worker, versionID string) *upstreamError {
	prepareContext, cancel := context.WithTimeout(ctx, a.prepareTimeout)
	defer cancel()
	version, upstream := a.immutableVersion(prepareContext, worker, versionID)
	if upstream != nil {
		return upstream
	}
	if upstream := a.prepareStatelessEntrypoint(prepareContext, worker, versionID); upstream != nil {
		return upstream
	}
	classes := make([]string, 0, len(version.Content.Exports))
	for className, export := range version.Content.Exports {
		if !classPattern.MatchString(className) || export.Type != "durable_object" || export.Storage != "sqlite" {
			return &upstreamError{Status: http.StatusBadGateway, Code: "invalid_upstream_response", Message: "The code service returned invalid Worker exports", Retryable: true}
		}
		classes = append(classes, className)
	}
	slices.Sort(classes)
	for index, className := range classes {
		if err := a.prepareEntrypoint(prepareContext, requestID, worker, versionID, className, index); err != nil {
			return err
		}
	}
	return nil
}

func (a *API) prepareStatelessEntrypoint(ctx context.Context, worker, versionID string) *upstreamError {
	executors, err := a.statelessServingExecutors(ctx)
	if err != nil {
		return &upstreamError{Status: http.StatusServiceUnavailable, Code: "executor_unavailable", Message: "No stateless Worker executor is available", Retryable: true}
	}
	for _, executor := range executors {
		target := engineURL(executor.endpoint, fmt.Sprintf("/internal/v1/workers/%s/versions/%s/prepare", url.PathEscape(worker), url.PathEscape(versionID)))
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), nil)
		if err != nil {
			return &upstreamError{Status: http.StatusInternalServerError, Code: "internal_error", Message: "The Worker validation request could not be created"}
		}
		request.Header.Set(statelessExecutorTokenHeader, executor.token)
		response, err := a.fetchClient.Do(request)
		if err != nil {
			return &upstreamError{Status: http.StatusServiceUnavailable, Code: "worker_prepare_failed", Message: "The stateless Worker executor was unavailable", Retryable: true}
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
		response.Body.Close()
		if response.StatusCode == http.StatusNoContent {
			continue
		}
		if response.StatusCode >= 500 {
			return &upstreamError{Status: http.StatusServiceUnavailable, Code: "worker_prepare_failed", Message: "The stateless Worker executor was unavailable", Retryable: true}
		}
		return &upstreamError{Status: http.StatusUnprocessableEntity, Code: "worker_prepare_failed", Message: "workerd rejected the default entrypoint"}
	}
	return nil
}

func (a *API) statelessServingExecutors(ctx context.Context) ([]statelessExecutor, error) {
	candidates, err := a.placementResolver.AdmissionCandidates(ctx)
	if err != nil {
		return nil, fmt.Errorf("read stateless admission candidates: %w", err)
	}
	if len(candidates) == 0 {
		return nil, ErrNoAdmissionCapacity
	}
	admitted := make(map[string]registryPlacement, len(candidates))
	for _, candidate := range candidates {
		if candidate.CellUID == "" {
			return nil, fmt.Errorf("stateless admission candidate has no Cell UID")
		}
		if _, duplicate := admitted[candidate.CellUID]; duplicate {
			return nil, fmt.Errorf("stateless admission candidate Cell UID is duplicated")
		}
		admitted[candidate.CellUID] = candidate
	}
	routes, err := a.servingRoutes.StatelessRoutes(ctx)
	if err != nil {
		return nil, err
	}
	executors := make([]statelessExecutor, 0, len(admitted))
	for _, route := range routes {
		candidate, accepting := admitted[route.CellUID]
		if !accepting {
			// Serving routes outlive admission so existing Durable Objects remain
			// reachable while a Cell is draining. They must not keep receiving
			// ordinary Worker fetches merely because that route still exists.
			continue
		}
		if !servingRouteMatchesPlacement(route, &candidate) {
			return nil, fmt.Errorf("stateless admission identity differs from serving route %s", route.CellName)
		}
		token, ok := a.statelessTokensByCell[route.CellUID]
		if !ok {
			// The route namespace can contain a freshly published Cell before this
			// release has received its capability. Network discovery alone must not
			// authorize dispatch into that Cell.
			continue
		}
		if len(token) < 16 || route.StatelessExecutor == nil {
			return nil, fmt.Errorf("stateless serving route %s has no matching capability", route.CellName)
		}
		pool := route.PoolName
		if pool == "" {
			pool = route.PoolUID
		}
		executors = append(executors, statelessExecutor{cellUID: route.CellUID, pool: pool, endpoint: route.StatelessExecutor, token: token})
	}
	if len(executors) != len(admitted) {
		return nil, fmt.Errorf("one or more admitted stateless Cells have no authorized serving route")
	}
	return executors, nil
}

func (a *API) immutableVersion(ctx context.Context, worker, versionID string) (registryImmutableVersion, *upstreamError) {
	var result registryImmutableVersion
	target := a.registryURL(fmt.Sprintf("/internal/v1/namespaces/%s/workers/%s/versions/%s", url.PathEscape(a.namespace), url.PathEscape(worker), url.PathEscape(versionID)))
	if err := a.requestJSON(ctx, http.MethodGet, target, nil, &result); err != nil {
		return result, err
	}
	if result.VersionID != versionID || result.Content.Schema != "rivet-worker-registry/v5" {
		return result, &upstreamError{Status: http.StatusBadGateway, Code: "invalid_upstream_response", Message: "The code service returned an invalid immutable Version", Retryable: true}
	}
	return result, nil
}

func (a *API) prepareEntrypoint(ctx context.Context, requestID, worker, versionID, className string, index int) (result *upstreamError) {
	placementKey := worker + "\x00" + versionID + "\x00" + className
	decision, resolveErr := a.placementResolver.Resolve(ctx, placementKey)
	if resolveErr != nil {
		return placementUpstreamError(resolveErr)
	}
	engine, upstream := a.engineForPlacement(ctx, &decision)
	if upstream != nil {
		return upstream
	}
	identity := className
	if identity == "" {
		identity = "default"
	}
	input := ""
	if className != "" {
		encoded, _ := json.Marshal(map[string]string{"schema": actorInputSchema, "class_name": className})
		input = base64.StdEncoding.EncodeToString(encoded)
	}
	body := map[string]any{
		"name":                 "wa-prepare-" + digest(worker, versionID, identity, requestID, fmt.Sprint(index))[:24],
		"key":                  versionID,
		"worker":               map[string]string{"worker": worker, "version_id": versionID},
		"runner_name_selector": a.runnerNameSelector,
		"crash_policy":         "sleep",
	}
	if input != "" {
		body["input"] = input
	}
	body["datacenter"] = decision.Datacenter
	target := engineURL(engine, "/actors")
	target.RawQuery = url.Values{"namespace": []string{a.namespace}}.Encode()
	var created actorCreateResponse
	if err := a.requestJSON(ctx, http.MethodPut, target, body, &created); err != nil {
		return err
	}
	actorID := created.Actor.ActorID
	if actorID == "" {
		return &upstreamError{Status: http.StatusBadGateway, Code: "invalid_upstream_response", Message: "The runtime omitted the prepare Actor ID", Retryable: true}
	}
	defer func() {
		deleteTarget := engineURL(engine, "/actors/"+url.PathEscape(actorID))
		deleteTarget.RawQuery = url.Values{"namespace": []string{a.namespace}}.Encode()
		if cleanup := a.requestJSON(context.WithoutCancel(ctx), http.MethodDelete, deleteTarget, nil, nil); cleanup != nil {
			slog.Warn("delete Worker prepare Actor", "actorID", actorID, "error", cleanup)
			if result == nil {
				result = &upstreamError{Status: http.StatusServiceUnavailable, Code: "prepare_cleanup_failed", Message: "The Worker validation probe could not be cleaned up", Retryable: true}
			}
		}
	}()
	deadline := time.Now().Add(a.prepareTimeout)
	for time.Now().Before(deadline) {
		listTarget := engineURL(engine, "/actors")
		listTarget.RawQuery = url.Values{"namespace": []string{a.namespace}, "actor_ids": []string{actorID}}.Encode()
		var listed actorListResponse
		if err := a.requestJSON(ctx, http.MethodGet, listTarget, nil, &listed); err != nil {
			return err
		}
		if len(listed.Actors) > 0 {
			actor := listed.Actors[0]
			if actor.ConnectableTS != nil {
				return nil
			}
			if actor.Error != nil || actor.SleepTS != nil || actor.DestroyTS != nil {
				return &upstreamError{Status: http.StatusUnprocessableEntity, Code: "worker_prepare_failed", Message: fmt.Sprintf("workerd rejected %s", entrypointLabel(className))}
			}
		}
		select {
		case <-ctx.Done():
			return &upstreamError{Status: http.StatusServiceUnavailable, Code: "request_cancelled", Message: "Worker validation was cancelled", Retryable: true}
		case <-time.After(100 * time.Millisecond):
		}
	}
	return &upstreamError{Status: http.StatusGatewayTimeout, Code: "worker_prepare_timeout", Message: "Worker validation timed out", Retryable: true}
}

func (a *API) registryWorker(ctx context.Context, worker string) (registryWorker, *upstreamError) {
	var result registryWorker
	target := a.registryURL(fmt.Sprintf("/v1/namespaces/%s/workers/%s", url.PathEscape(a.namespace), url.PathEscape(worker)))
	return result, a.requestJSON(ctx, http.MethodGet, target, nil, &result)
}

func (a *API) engineForPlacement(ctx context.Context, placement *registryPlacement) (*url.URL, *upstreamError) {
	if placement == nil {
		return nil, &upstreamError{Status: http.StatusBadGateway, Code: "invalid_upstream_response", Message: "The code service returned an object without placement", Retryable: true}
	}
	route, err := a.servingRoutes.RouteForPlacement(ctx, placement)
	if err != nil || route.ActorGateway == nil {
		return nil, &upstreamError{Status: http.StatusServiceUnavailable, Code: "placement_unavailable", Message: "The Object placement has no matching Engine route", Retryable: true}
	}
	token, exists := a.engineTokensByCell[placement.CellUID]
	if !exists {
		return nil, &upstreamError{Status: http.StatusServiceUnavailable, Code: "placement_unavailable", Message: "The Object placement has no matching Engine capability", Retryable: true}
	}
	a.dynamicEngineTokens.Store(route.ActorGateway.Scheme+"://"+route.ActorGateway.Host, token)
	return route.ActorGateway, nil
}

func (a *API) refreshActorBinding(ctx context.Context, binding actorBinding) (actorBinding, *upstreamError) {
	route, err := a.servingRoutes.RouteForPlacement(ctx, &binding.placement)
	if err != nil || route.ActorGateway == nil {
		return actorBinding{}, &upstreamError{Status: http.StatusServiceUnavailable, Code: "placement_unavailable", Message: "The Object placement has no matching Engine route", Retryable: true}
	}
	token, ok := a.engineTokensByCell[binding.placement.CellUID]
	if !ok {
		return actorBinding{}, &upstreamError{Status: http.StatusServiceUnavailable, Code: "placement_unavailable", Message: "The Object placement has no matching Engine capability", Retryable: true}
	}
	a.dynamicEngineTokens.Store(route.ActorGateway.Scheme+"://"+route.ActorGateway.Host, token)
	if binding.routeRevision != route.Revision || binding.engine == nil || binding.engine.String() != route.ActorGateway.String() {
		binding.engine = route.ActorGateway
		binding.routeRevision = route.Revision
	}
	return binding, nil
}

func (a *API) decodeJSON(writer http.ResponseWriter, request *http.Request, destination any) bool {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		a.writeError(writer, request, http.StatusUnsupportedMediaType, "invalid_content_type", "Content-Type must be application/json", false)
		return false
	}
	request.Body = http.MaxBytesReader(writer, request.Body, a.maxRequestBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			a.writeError(writer, request, http.StatusRequestEntityTooLarge, "request_too_large", "The request exceeds the size limit", false)
		} else {
			a.writeError(writer, request, http.StatusBadRequest, "invalid_request", "The JSON request is invalid", false)
		}
		return false
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		a.writeError(writer, request, http.StatusBadRequest, "invalid_request", "The request must contain one JSON value", false)
		return false
	}
	return true
}

func (a *API) writeUpstreamError(writer http.ResponseWriter, request *http.Request, err *upstreamError) {
	status := err.Status
	if status < 400 || status > 599 {
		status = http.StatusBadGateway
	}
	a.writeError(writer, request, status, publicUpstreamCode(err), publicUpstreamMessage(err), err.Retryable)
}

func publicUpstreamCode(err *upstreamError) string {
	switch err.Code {
	case "not_found", "version_not_found", "version_not_deployable", "unsupported_compatibility_date",
		"invalid_request", "invalid_name", "invalid_version", "invalid_deployment", "deployment_conflict", "request_too_large", "upstream_timeout",
		"upstream_unavailable", "invalid_upstream_response", "worker_prepare_failed", "worker_prepare_timeout",
		"prepare_cleanup_failed", "request_cancelled", "object_class_not_found", "object_deleted", "object_conflict", "actor_ready_timeout",
		"no_admission_capacity", "placement_unavailable", "worker_unavailable", "executor_unavailable", "executor_overloaded", "indeterminate_result":
		return err.Code
	case "durable_object_namespaces":
		return "worker_has_durable_objects"
	default:
		if err.Retryable || err.Status >= 500 {
			return "upstream_unavailable"
		}
		return "upstream_rejected"
	}
}

func publicUpstreamMessage(err *upstreamError) string {
	switch err.Code {
	case "not_found":
		return "The requested Worker resource was not found"
	case "version_not_found":
		return "The requested Version was not found"
	case "version_not_deployable":
		return "The Version is outside the deployable retention window"
	case "deployment_conflict":
		return "The active Worker Deployment changed"
	case "unsupported_compatibility_date":
		return "The compatibility date is not supported by this runtime"
	case "invalid_request", "invalid_name", "invalid_version", "request_too_large":
		return "The Worker request is invalid"
	case "upstream_timeout":
		return "An internal service timed out"
	case "actor_ready_timeout":
		return "The Agent did not become ready within 3 seconds"
	case "no_admission_capacity":
		return "No fresh admitted Cell is available"
	case "placement_unavailable":
		return "The Object placement is unavailable"
	case "worker_unavailable":
		return "The Worker is temporarily unavailable"
	case "executor_unavailable":
		return "No stateless Worker executor is available"
	case "executor_overloaded":
		return "The stateless Worker executor is overloaded"
	case "indeterminate_result":
		return "The Worker result is indeterminate"
	case "worker_prepare_failed", "worker_prepare_timeout", "prepare_cleanup_failed":
		return err.Message
	case "durable_object_namespaces":
		return "Worker deletion is blocked while Durable Object namespaces are associated"
	case "object_class_not_found":
		return err.Message
	case "object_deleted":
		return "The Durable Object was permanently deleted"
	case "object_conflict":
		return "The Durable Object identity is temporarily inconsistent"
	default:
		if err.Retryable || err.Status >= 500 {
			return "An internal service is temporarily unavailable"
		}
		return "An internal service rejected the request"
	}
}

func (a *API) writeError(writer http.ResponseWriter, request *http.Request, status int, code, message string, retryable bool) {
	writer.Header().Set("X-Workers-Error", "true")
	writeJSON(writer, status, ErrorResponse{Error: APIError{Code: code, Message: message, Retryable: retryable, RequestID: requestID(request)}})
}

func validWorkerPath(writer http.ResponseWriter, request *http.Request) (string, bool) {
	worker := request.PathValue("worker")
	if !namePattern.MatchString(worker) {
		writePublicError(writer, request, http.StatusBadRequest, "invalid_worker", "Worker name is invalid", false)
		return "", false
	}
	return worker, true
}

func validObjectPath(writer http.ResponseWriter, request *http.Request) (string, string, string, bool) {
	worker, ok := validWorkerPath(writer, request)
	if !ok {
		return "", "", "", false
	}
	className, objectID := request.PathValue("class"), request.PathValue("object")
	if !classPattern.MatchString(className) || !objectPattern.MatchString(objectID) {
		writePublicError(writer, request, http.StatusBadRequest, "invalid_object", "Durable Object class or ID is invalid", false)
		return "", "", "", false
	}
	return worker, className, objectID, true
}

func activeVersion(deployment registryDeployment) string {
	if len(deployment.Versions) == 1 && deployment.Versions[0].Percentage == 100 {
		return deployment.Versions[0].VersionID
	}
	return ""
}

func activeVersionSummary(worker registryWorker) (registryVersion, bool) {
	versionID := activeVersion(worker.Deployment)
	if versionID == "" {
		return registryVersion{}, false
	}
	for _, version := range worker.Versions {
		if version.VersionID == versionID {
			return version, true
		}
	}
	return registryVersion{}, false
}

func (a *API) validateDurableObjects(writer http.ResponseWriter, request *http.Request, bindings map[string]string) bool {
	for binding, className := range bindings {
		if !bindingPattern.MatchString(binding) || !classPattern.MatchString(className) {
			a.writeError(writer, request, http.StatusBadRequest, "invalid_durable_object", "Durable Object bindings or class names are invalid", false)
			return false
		}
	}
	return true
}

func entrypointLabel(className string) string {
	if className == "" {
		return "the default entrypoint"
	}
	return "Durable Object class " + className
}

func validateOriginalURL(raw string) (*url.URL, error) {
	if raw == "" || len(raw) > 8192 {
		return nil, errors.New("The original request URL is missing or too long")
	}
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
		return nil, errors.New("The original request URL must be an absolute HTTP or HTTPS URL without credentials")
	}
	return parsed, nil
}

func stripInternalHeaders(headers http.Header) {
	for name := range headers {
		if strings.HasPrefix(strings.ToLower(name), "x-rivet-") {
			headers.Del(name)
		}
	}
}

func copyHeaders(destination, source http.Header, request bool) {
	for name, values := range source {
		if hopByHopHeader(name) || (request && strings.EqualFold(name, "Host")) {
			continue
		}
		for _, value := range values {
			destination.Add(name, value)
		}
	}
}

func hopByHopHeader(name string) bool {
	switch strings.ToLower(name) {
	case "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade":
		return true
	default:
		return false
	}
}

func parseBaseURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("must be an absolute HTTP or HTTPS URL without credentials, query, or fragment")
	}
	return parsed, nil
}

func digest(parts ...string) string {
	hash := sha256.New()
	for _, part := range parts {
		_, _ = hash.Write([]byte(part))
		_, _ = hash.Write([]byte{0})
	}
	return hex.EncodeToString(hash.Sum(nil))
}

type requestIDKey struct{}

func requestID(request *http.Request) string {
	value, _ := request.Context().Value(requestIDKey{}).(string)
	if value == "" {
		return "req_unknown"
	}
	return value
}

func newRequestID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "req_" + digest(fmt.Sprint(time.Now().UnixNano()))[:32]
	}
	return "req_" + hex.EncodeToString(value[:])
}

func validRequestID(value string) bool {
	if len(value) < 5 || len(value) > 96 {
		return false
	}
	for _, character := range value {
		if !(character == '-' || character == '_' || character >= '0' && character <= '9' || character >= 'A' && character <= 'Z' || character >= 'a' && character <= 'z') {
			return false
		}
	}
	return true
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func writePublicError(writer http.ResponseWriter, request *http.Request, status int, code, message string, retryable bool) {
	writer.Header().Set("X-Workers-Error", "true")
	writeJSON(writer, status, ErrorResponse{Error: APIError{Code: code, Message: message, Retryable: retryable, RequestID: requestID(request)}})
}
