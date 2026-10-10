package workersapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

const cellServingRouteLabel = "fleet.actor.dev/cell-serving-route"

type cellServingRouteDocument struct {
	Schema                      string `json:"schema"`
	Region                      string `json:"region"`
	PoolName                    string `json:"pool_name"`
	PoolUID                     string `json:"pool_uid"`
	CellName                    string `json:"cell_name"`
	CellUID                     string `json:"cell_uid"`
	Datacenter                  string `json:"datacenter"`
	ActorGatewayAuthority       string `json:"actor_gateway_authority"`
	ActorGatewayServiceUID      string `json:"actor_gateway_service_uid"`
	StatelessExecutorAuthority  string `json:"stateless_executor_authority"`
	StatelessExecutorServiceUID string `json:"stateless_executor_service_uid"`
	ServiceIdentity             string `json:"service_identity"`
	Revision                    int64  `json:"revision"`
	PublishedAt                 string `json:"published_at"`
	ManifestSHA256              string `json:"manifest_sha256"`
}

type ServingRoute struct {
	PoolName          string
	PoolUID           string
	CellName          string
	CellUID           string
	Datacenter        string
	ActorGateway      *url.URL
	StatelessExecutor *url.URL
	ServiceIdentity   string
	Revision          int64
	ManifestSHA256    string
}

type ServingRouteResolver interface {
	RouteForPlacement(context.Context, *registryPlacement) (ServingRoute, error)
	StatelessRoutes(context.Context) ([]ServingRoute, error)
}

type staticServingRouteResolver struct {
	routes map[string]ServingRoute
}

func (resolver *staticServingRouteResolver) RouteForPlacement(_ context.Context, placement *registryPlacement) (ServingRoute, error) {
	if placement == nil {
		return ServingRoute{}, fmt.Errorf("placement is absent")
	}
	route, ok := resolver.routes[placement.CellUID]
	if !ok || !servingRouteMatchesPlacement(route, placement) {
		return ServingRoute{}, fmt.Errorf("placement has no matching serving route")
	}
	return route, nil
}

func (resolver *staticServingRouteResolver) StatelessRoutes(context.Context) ([]ServingRoute, error) {
	result := make([]ServingRoute, 0, len(resolver.routes))
	for _, route := range resolver.routes {
		if route.StatelessExecutor != nil {
			result = append(result, route)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].CellUID < result[j].CellUID })
	if len(result) == 0 {
		return nil, fmt.Errorf("no stateless serving route is available")
	}
	return result, nil
}

type KubernetesServingRouteResolver struct {
	kube            kubernetes.Interface
	namespace       string
	refreshInterval time.Duration
	now             func() time.Time

	mu          sync.Mutex
	routes      map[string]ServingRoute
	highest     map[string]servingRouteRevision
	refreshedAt time.Time
}

type servingRouteRevision struct {
	revision       int64
	manifestSHA256 string
}

func NewKubernetesServingRouteResolver(kube kubernetes.Interface, namespace string, refreshInterval time.Duration) (*KubernetesServingRouteResolver, error) {
	if kube == nil || !namePattern.MatchString(namespace) || refreshInterval <= 0 {
		return nil, fmt.Errorf("serving route resolver configuration is invalid")
	}
	return &KubernetesServingRouteResolver{
		kube: kube, namespace: namespace, refreshInterval: refreshInterval,
		now: time.Now, routes: make(map[string]ServingRoute), highest: make(map[string]servingRouteRevision),
	}, nil
}

func (resolver *KubernetesServingRouteResolver) RouteForPlacement(ctx context.Context, placement *registryPlacement) (ServingRoute, error) {
	routes, err := resolver.snapshot(ctx)
	if err != nil {
		return ServingRoute{}, err
	}
	if placement == nil {
		return ServingRoute{}, fmt.Errorf("placement is absent")
	}
	route, ok := routes[placement.CellUID]
	if !ok || !servingRouteMatchesPlacement(route, placement) {
		return ServingRoute{}, fmt.Errorf("placement has no matching serving route")
	}
	return route, nil
}

func (resolver *KubernetesServingRouteResolver) StatelessRoutes(ctx context.Context) ([]ServingRoute, error) {
	routes, err := resolver.snapshot(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]ServingRoute, 0, len(routes))
	for _, route := range routes {
		result = append(result, route)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].CellUID < result[j].CellUID })
	if len(result) == 0 {
		return nil, fmt.Errorf("no stateless serving route is available")
	}
	return result, nil
}

func (resolver *KubernetesServingRouteResolver) snapshot(ctx context.Context) (map[string]ServingRoute, error) {
	resolver.mu.Lock()
	defer resolver.mu.Unlock()
	if len(resolver.routes) != 0 && resolver.now().Sub(resolver.refreshedAt) < resolver.refreshInterval {
		return cloneServingRoutes(resolver.routes), nil
	}
	items, err := resolver.kube.CoreV1().ConfigMaps(resolver.namespace).List(ctx, metav1.ListOptions{
		LabelSelector: cellServingRouteLabel + "=true", Limit: 1000,
	})
	if err != nil {
		if len(resolver.routes) != 0 {
			return cloneServingRoutes(resolver.routes), nil
		}
		return nil, fmt.Errorf("list Cell serving routes: %w", err)
	}
	if items.Continue != "" {
		return nil, fmt.Errorf("Cell serving route inventory exceeds 1000")
	}
	next := make(map[string]ServingRoute, len(items.Items))
	for index := range items.Items {
		item := &items.Items[index]
		route, err := parseCellServingRoute(item.Data["route.json"])
		if err != nil {
			return nil, fmt.Errorf("parse Cell serving route %s: %w", item.Name, err)
		}
		if item.Name != "actor-cell-serving-route-"+route.CellName ||
			item.Labels[cellServingRouteLabel] != "true" ||
			item.Annotations["fleet.actor.dev/route-revision"] != fmt.Sprint(route.Revision) ||
			item.Annotations["fleet.actor.dev/route-manifest-sha256"] != route.ManifestSHA256 {
			return nil, fmt.Errorf("Cell serving route %s metadata differs", item.Name)
		}
		accepted := resolver.highest[route.CellUID]
		if route.Revision < accepted.revision {
			return nil, fmt.Errorf("Cell serving route %s revision regressed", route.CellName)
		}
		if route.Revision == accepted.revision && route.ManifestSHA256 != accepted.manifestSHA256 {
			return nil, fmt.Errorf("Cell serving route %s revision content changed", route.CellName)
		}
		if _, duplicate := next[route.CellUID]; duplicate {
			return nil, fmt.Errorf("duplicate Cell serving route UID %s", route.CellUID)
		}
		next[route.CellUID] = route
	}
	for uid, route := range next {
		if route.Revision > resolver.highest[uid].revision {
			resolver.highest[uid] = servingRouteRevision{revision: route.Revision, manifestSHA256: route.ManifestSHA256}
		}
	}
	resolver.routes = next
	resolver.refreshedAt = resolver.now()
	return cloneServingRoutes(next), nil
}

func parseCellServingRoute(raw string) (ServingRoute, error) {
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	var document cellServingRouteDocument
	if err := decoder.Decode(&document); err != nil {
		return ServingRoute{}, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return ServingRoute{}, fmt.Errorf("trailing route JSON")
	}
	if document.Schema != "actor-cell-serving-route/v1" || document.Revision < 1 ||
		!namePattern.MatchString(document.PoolName) || !namePattern.MatchString(document.CellName) ||
		!namePattern.MatchString(document.Datacenter) || document.PoolUID == "" || document.CellUID == "" ||
		len(document.PoolUID) > 128 || len(document.CellUID) > 128 ||
		document.ActorGatewayServiceUID == "" || document.StatelessExecutorServiceUID == "" ||
		document.ServiceIdentity != "actor-cell/"+document.CellUID {
		return ServingRoute{}, fmt.Errorf("route identity is invalid")
	}
	if _, err := time.Parse(time.RFC3339, document.PublishedAt); err != nil {
		return ServingRoute{}, fmt.Errorf("route publication time is invalid")
	}
	manifest := document.ManifestSHA256
	document.ManifestSHA256 = ""
	unsigned := map[string]any{}
	encoded, _ := json.Marshal(document)
	_ = json.Unmarshal(encoded, &unsigned)
	delete(unsigned, "manifest_sha256")
	canonical, _ := json.Marshal(unsigned)
	canonical = append(canonical, '\n')
	digest := sha256.Sum256(canonical)
	if manifest != "sha256:"+hex.EncodeToString(digest[:]) {
		return ServingRoute{}, fmt.Errorf("route manifest digest differs")
	}
	actorGateway, err := parsePrivateServingOrigin(document.ActorGatewayAuthority, 6420)
	if err != nil {
		return ServingRoute{}, fmt.Errorf("actor gateway: %w", err)
	}
	stateless, err := parsePrivateServingOrigin(document.StatelessExecutorAuthority, 19084)
	if err != nil {
		return ServingRoute{}, fmt.Errorf("stateless executor: %w", err)
	}
	return ServingRoute{
		PoolName: document.PoolName, PoolUID: document.PoolUID,
		CellName: document.CellName, CellUID: document.CellUID, Datacenter: document.Datacenter,
		ActorGateway: actorGateway, StatelessExecutor: stateless,
		ServiceIdentity: document.ServiceIdentity, Revision: document.Revision, ManifestSHA256: manifest,
	}, nil
}

func parsePrivateServingOrigin(raw string, port int) (*url.URL, error) {
	parsed, err := parseBaseURL(raw)
	if err != nil || parsed.Scheme != "http" || parsed.Path != "" || parsed.RawQuery != "" {
		return nil, fmt.Errorf("invalid private HTTP origin")
	}
	host, actualPort, err := net.SplitHostPort(parsed.Host)
	if err != nil || actualPort != fmt.Sprint(port) {
		return nil, fmt.Errorf("invalid private origin port")
	}
	address := net.ParseIP(host)
	if address == nil || !address.IsPrivate() {
		return nil, fmt.Errorf("origin is not a private IP")
	}
	return parsed, nil
}

func servingRouteMatchesPlacement(route ServingRoute, placement *registryPlacement) bool {
	return route.CellName == placement.CellName && route.CellUID == placement.CellUID &&
		route.PoolUID == placement.PoolUID && route.Datacenter == placement.Datacenter
}

func cloneServingRoutes(source map[string]ServingRoute) map[string]ServingRoute {
	result := make(map[string]ServingRoute, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}
