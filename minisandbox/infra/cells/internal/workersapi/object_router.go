package workersapi

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"time"

	"github.com/rivet-dev/rivet/infra/cells/internal/workersapi/objectrouter"
)

const objectRouterTokenHeader = "X-Rivet-Object-Router-Token"
const statelessExecutorTokenHeader = "X-Rivet-Stateless-Executor-Token"

type objectRouterBackend struct{ api *API }

type objectRouterSourceContextKey struct{}

func newObjectRouter(
	api *API, cacheCapacity int, cacheIdleTTL time.Duration, missCapacity int,
) *objectrouter.Router[actorBinding] {
	return objectrouter.New[actorBinding](
		objectRouterBackend{api: api}, cacheCapacity, cacheIdleTTL, missCapacity,
	)
}

func (backend objectRouterBackend) ResolveUncached(
	ctx context.Context, key objectrouter.Key,
) (actorBinding, error) {
	binding, upstream := backend.api.ensureActorUncached(ctx, key.Worker, key.Class, key.ObjectID)
	if upstream != nil {
		return actorBinding{}, upstream
	}
	return binding, nil
}

func (backend objectRouterBackend) Refresh(ctx context.Context, binding actorBinding) (actorBinding, error) {
	refreshed, upstream := backend.api.refreshActorBinding(ctx, binding)
	if upstream != nil {
		return actorBinding{}, upstream
	}
	return refreshed, nil
}

func objectMissContextError(ctx context.Context) *upstreamError {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return &upstreamError{
			Status: http.StatusGatewayTimeout, Code: "actor_ready_timeout",
			Message: "The Agent did not become ready within 3 seconds", Retryable: true,
		}
	}
	return &upstreamError{
		Status: http.StatusServiceUnavailable, Code: "request_cancelled",
		Message: "The Object request was cancelled", Retryable: true,
	}
}

// internalFetchObject is the Cell-to-Hub capability boundary used by trusted
// stateless Worker wrappers. The wrapper resolves a deployment binding to its
// immutable Worker and class before calling this route. User code never
// receives the route token or a raw Fetcher for this endpoint.
func (a *API) internalFetchObject(writer http.ResponseWriter, request *http.Request) {
	source, authenticated := a.objectRouterSource(request)
	if !authenticated {
		http.NotFound(writer, request)
		return
	}
	request = request.WithContext(context.WithValue(request.Context(), objectRouterSourceContextKey{}, source))
	worker, className, objectID, ok := validObjectPath(writer, request)
	if !ok {
		return
	}
	originalURL, err := validateOriginalURL(request.Header.Get(internalOriginalURLHeader))
	if err != nil {
		a.writeError(writer, request, http.StatusBadRequest, "invalid_original_url", err.Error(), false)
		return
	}
	a.fetchActorAtURL(writer, request, worker, className, objectID, originalURL)
}

func (a *API) objectRouterSource(request *http.Request) (string, bool) {
	supplied := request.Header.Get(objectRouterTokenHeader)
	authenticated := 0
	source := "internal"
	for index, token := range a.objectRouterTokens {
		if len(supplied) == len(token) {
			matched := subtle.ConstantTimeCompare([]byte(supplied), []byte(token))
			authenticated |= matched
			if matched == 1 && index < len(a.objectRouterSources) {
				source = a.objectRouterSources[index]
			}
		}
	}
	return source, authenticated == 1
}

func objectRouterSourceFromContext(ctx context.Context) string {
	if source, ok := ctx.Value(objectRouterSourceContextKey{}).(string); ok && source != "" {
		return source
	}
	return "public"
}
