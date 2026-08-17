package httptransport

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sort"
	"strings"
	"testing"

	"chatserver/internal/api/openapi"

	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers/gorillamux"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// ContractHarness 是测试侧的 strict interface 编译门禁。
//
// 具体 operation response 由下方 Schema 驱动的 test server 生成，避免把 80 个空
// 业务实现放进生产二进制。
type ContractHarness struct {
	openapi.StrictServerInterface
}

var _ openapi.StrictServerInterface = (*ContractHarness)(nil)

func TestEveryOperationHasRouteCaseAndValidSuccessResponse(t *testing.T) {
	spec, err := openapi.GetSwagger()
	if err != nil {
		t.Fatalf("GetSwagger() error = %v", err)
	}
	registerPlatformFormats()
	router, err := gorillamux.NewRouter(spec)
	if err != nil {
		t.Fatalf("NewRouter() error = %v", err)
	}

	type contractCase struct {
		path      string
		method    string
		operation string
	}
	cases := make([]contractCase, 0, 99)
	for path, pathItem := range spec.Paths.Map() {
		for method, operation := range pathItem.Operations() {
			cases = append(cases, contractCase{
				path:      concreteContractPath(path),
				method:    strings.ToUpper(method),
				operation: operation.OperationID,
			})
		}
	}
	sort.Slice(cases, func(left int, right int) bool {
		return cases[left].operation < cases[right].operation
	})
	if len(cases) != 104 {
		t.Fatalf("contract cases = %d, want 104", len(cases))
	}

	for _, test := range cases {
		t.Run(test.operation, func(t *testing.T) {
			request := httptest.NewRequest(
				test.method,
				"/v1"+test.path,
				nil,
			)
			route, pathParams, err := router.FindRoute(request)
			if err != nil {
				t.Fatalf("FindRoute(%s %s) error = %v", test.method, test.path, err)
			}
			if route.Operation.OperationID != test.operation {
				t.Fatalf(
					"route operation = %q, want %q",
					route.Operation.OperationID,
					test.operation,
				)
			}

			response, err := buildContractResponse(route.Operation)
			if err != nil {
				t.Fatalf("buildContractResponse() error = %v", err)
			}
			recorder := httptest.NewRecorder()
			for name, values := range response.header {
				for _, value := range values {
					recorder.Header().Add(name, value)
				}
			}
			recorder.WriteHeader(response.status)
			if len(response.body) > 0 {
				if _, err := recorder.Write(response.body); err != nil {
					t.Fatalf("Write(response) error = %v", err)
				}
			}

			input := &openapi3filter.ResponseValidationInput{
				RequestValidationInput: &openapi3filter.RequestValidationInput{
					Request:    request,
					PathParams: pathParams,
					Route:      route,
				},
				Status: recorder.Code,
				Header: recorder.Header(),
				Body:   io.NopCloser(bytes.NewReader(recorder.Body.Bytes())),
				Options: &openapi3filter.Options{
					IncludeResponseStatus: true,
				},
			}
			if err := openapi3filter.ValidateResponse(context.Background(), input); err != nil {
				t.Fatalf(
					"ValidateResponse() error = %v; status=%d body=%s",
					err,
					recorder.Code,
					recorder.Body,
				)
			}
		})
	}
}

func TestNilSecretFieldsAreOmittedFromGeneratedDTOs(t *testing.T) {
	values := map[string]any{
		"auth": openapi.AuthResult{
			Account: openapi.Account{
				Email: openapi_types.Email("contract@example.cn"),
			},
		},
		"im":       openapi.ImSession{},
		"invite":   openapi.InviteSecret{},
		"terminal": openapi.TerminalSession{},
	}
	for name, value := range values {
		t.Run(name, func(t *testing.T) {
			data, err := json.Marshal(value)
			if err != nil {
				t.Fatalf("Marshal() error = %v", err)
			}
			for _, secretKey := range []string{
				`"accessToken"`,
				`"refreshToken"`,
				`"userSig"`,
				`"token"`,
				`"script"`,
				`"webSocketUrl"`,
			} {
				if bytes.Contains(data, []byte(secretKey)) {
					t.Errorf("zero DTO serialized secret key %s: %s", secretKey, data)
				}
			}
		})
	}
}

var contractPathParameter = regexp.MustCompile(`\{([^}]+)\}`)

func concreteContractPath(template string) string {
	return contractPathParameter.ReplaceAllStringFunc(template, func(value string) string {
		name := strings.TrimSuffix(strings.TrimPrefix(value, "{"), "}")
		if name == "slug" {
			return "contract-server"
		}
		return "01989c24-7540-7f12-a27b-c83243215dd1"
	})
}

func TestContractHarnessDoesNotEnterProductionRouter(t *testing.T) {
	var _ openapi.StrictServerInterface = &ContractHarness{}
	if http.DefaultServeMux == nil {
		t.Fatal("unreachable")
	}
}
