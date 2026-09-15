package httptransport

import (
	"errors"
	"net/http"
	"sort"
	"strings"
)

// ImplementedRoute 是当前进程真正接线的 method/path。
type ImplementedRoute struct {
	Method string
	Path   string
}

// ImplementedRoutesMiddleware 在 OpenAPI validator 前拒绝尚未实现的规格路径。
func ImplementedRoutesMiddleware(
	routes []ImplementedRoute,
	encoder *ErrorEncoder,
) (Middleware, error) {
	if len(routes) == 0 || encoder == nil {
		return nil, errors.New("已实现路由门禁配置无效")
	}
	patternsByPath := make(map[string]*implementedPathPattern, len(routes))
	for _, route := range routes {
		method := strings.ToUpper(strings.TrimSpace(route.Method))
		path := strings.TrimSpace(route.Path)
		if method == "" || path == "" || path[0] != '/' {
			return nil, errors.New("已实现路由配置无效")
		}
		pattern := patternsByPath[path]
		if pattern == nil {
			var err error
			pattern, err = compileImplementedPath(path)
			if err != nil {
				return nil, err
			}
			patternsByPath[path] = pattern
		}
		pattern.methods[method] = struct{}{}
	}
	patterns := make([]*implementedPathPattern, 0, len(patternsByPath))
	for _, pattern := range patternsByPath {
		patterns = append(patterns, pattern)
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(
			writer http.ResponseWriter,
			request *http.Request,
		) {
			methods, pathExists := matchImplementedPath(
				patterns,
				request.URL.Path,
			)
			if !pathExists {
				encoder.WriteCode(
					writer,
					RequestID(request.Context()),
					"route_not_found",
					nil,
				)
				return
			}
			if _, methodExists := methods[request.Method]; !methodExists {
				allowed := make([]string, 0, len(methods))
				for method := range methods {
					allowed = append(allowed, method)
				}
				sort.Strings(allowed)
				writer.Header().Set("Allow", strings.Join(allowed, ", "))
				encoder.WriteCode(
					writer,
					RequestID(request.Context()),
					"method_not_allowed",
					nil,
				)
				return
			}
			next.ServeHTTP(writer, request)
		})
	}, nil
}

type implementedPathPattern struct {
	segments    []string
	methods     map[string]struct{}
	specificity int
}

func compileImplementedPath(path string) (*implementedPathPattern, error) {
	segments := splitImplementedPath(path)
	if len(segments) == 0 {
		return nil, errors.New("已实现路由配置无效")
	}
	specificity := 0
	for _, segment := range segments {
		if segment == "" {
			return nil, errors.New("已实现路由配置无效")
		}
		if strings.HasPrefix(segment, "{") ||
			strings.HasSuffix(segment, "}") {
			if len(segment) < 3 ||
				segment[0] != '{' ||
				segment[len(segment)-1] != '}' ||
				strings.ContainsAny(segment[1:len(segment)-1], "{}") {
				return nil, errors.New("已实现路由参数配置无效")
			}
			continue
		}
		specificity++
	}
	return &implementedPathPattern{
		segments:    segments,
		methods:     make(map[string]struct{}),
		specificity: specificity,
	}, nil
}

func matchImplementedPath(
	patterns []*implementedPathPattern,
	path string,
) (map[string]struct{}, bool) {
	actual := splitImplementedPath(path)
	bestSpecificity := -1
	var methods map[string]struct{}
	for _, pattern := range patterns {
		if !implementedPathMatches(pattern.segments, actual) {
			continue
		}
		if pattern.specificity < bestSpecificity {
			continue
		}
		if pattern.specificity > bestSpecificity {
			bestSpecificity = pattern.specificity
			methods = make(map[string]struct{}, len(pattern.methods))
		}
		for method := range pattern.methods {
			methods[method] = struct{}{}
		}
	}
	return methods, bestSpecificity >= 0
}

func implementedPathMatches(pattern []string, actual []string) bool {
	if len(pattern) != len(actual) {
		return false
	}
	for index := range pattern {
		segment := pattern[index]
		if segment[0] == '{' && segment[len(segment)-1] == '}' {
			if actual[index] == "" {
				return false
			}
			continue
		}
		if segment != actual[index] {
			return false
		}
	}
	return true
}

func splitImplementedPath(path string) []string {
	if path == "/" {
		return nil
	}
	return strings.Split(strings.TrimPrefix(path, "/"), "/")
}
