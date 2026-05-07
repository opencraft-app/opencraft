package rules

import (
	"fmt"
	"net/http"
	"strings"

	"go.starlark.net/starlark"
	"go.starlark.net/starlarkstruct"
)

type Request struct {
	RequestID  string
	Caller     string
	RouteID    string
	Method     string
	Path       string
	Query      string
	Headers    http.Header
	Attributes map[string]string
}

type Response struct {
	StatusCode  int
	Headers     http.Header
	UpstreamURL string
}

func Eval(condition string, req Request, resp *Response) (bool, error) {
	condition = strings.TrimSpace(condition)
	if condition == "" {
		return true, nil
	}

	globals := starlark.StringDict{
		"request": starlarkstruct.FromStringDict(starlark.String("request"), starlark.StringDict{
			"route_id":   starlark.String(req.RouteID),
			"request_id": starlark.String(req.RequestID),
			"caller":     starlark.String(req.Caller),
			"method":     starlark.String(strings.ToUpper(req.Method)),
			"path":       starlark.String(req.Path),
			"query":      starlark.String(req.Query),
			"headers":    headersValue(req.Headers),
			"attributes": stringMapValue(req.Attributes),
		}),
	}
	if resp != nil {
		globals["response"] = starlarkstruct.FromStringDict(starlark.String("response"), starlark.StringDict{
			"status_code":  starlark.MakeInt(resp.StatusCode),
			"headers":      headersValue(resp.Headers),
			"upstream_url": starlark.String(resp.UpstreamURL),
		})
	}

	value, err := starlark.Eval(&starlark.Thread{Name: "cloudladdergateway-rule"}, "condition.star", condition, globals)
	if err != nil {
		return false, err
	}
	b, ok := value.(starlark.Bool)
	if !ok {
		return false, fmt.Errorf("condition must evaluate to bool, got %s", value.Type())
	}
	return bool(b), nil
}

func headersValue(headers http.Header) *starlark.Dict {
	dict := starlark.NewDict(len(headers))
	for name, values := range headers {
		items := make([]starlark.Value, 0, len(values))
		for _, value := range values {
			items = append(items, starlark.String(value))
		}
		_ = dict.SetKey(starlark.String(strings.ToLower(name)), starlark.NewList(items))
	}
	return dict
}

func stringMapValue(values map[string]string) *starlark.Dict {
	dict := starlark.NewDict(len(values))
	for key, value := range values {
		_ = dict.SetKey(starlark.String(key), starlark.String(value))
	}
	return dict
}
