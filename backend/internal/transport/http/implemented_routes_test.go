package httptransport

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestImplementedRoutesMatchesOpenAPIPathParameters(t *testing.T) {
	encoder := NewErrorEncoder(
		fixedRequestIDGenerator{value: "request-1"},
	)
	middleware, err := ImplementedRoutesMiddleware(
		[]ImplementedRoute{
			{
				Method: http.MethodGet,
				Path:   "/v1/servers/{serverId}",
			},
			{
				Method: http.MethodGet,
				Path: "/v1/servers/{serverId}/members/" +
					"{memberId}",
			},
		},
		encoder,
	)
	if err != nil {
		t.Fatal(err)
	}
	next := http.HandlerFunc(func(
		writer http.ResponseWriter,
		_ *http.Request,
	) {
		writer.WriteHeader(http.StatusNoContent)
	})
	handler := middleware(next)

	tests := []struct {
		method string
		path   string
		status int
	}{
		{
			method: http.MethodGet,
			path:   "/v1/servers/019fb1de-56f1-7e53-a610-a06e41409fd1",
			status: http.StatusNoContent,
		},
		{
			method: http.MethodGet,
			path: "/v1/servers/019fb1de-56f1-7e53-a610-a06e41409fd1/" +
				"members/019fb1de-56f1-7e57-a8c7-6d0f739b8d36",
			status: http.StatusNoContent,
		},
		{
			method: http.MethodPost,
			path:   "/v1/servers/019fb1de-56f1-7e53-a610-a06e41409fd1",
			status: http.StatusMethodNotAllowed,
		},
		{
			method: http.MethodGet,
			path: "/v1/servers/019fb1de-56f1-7e53-a610-a06e41409fd1/" +
				"members/too/many",
			status: http.StatusNotFound,
		},
	}
	for _, test := range tests {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(
			recorder,
			httptest.NewRequest(test.method, test.path, nil),
		)
		if recorder.Code != test.status {
			t.Errorf("%s %s status = %d, want %d",
				test.method, test.path, recorder.Code, test.status)
		}
	}
}
