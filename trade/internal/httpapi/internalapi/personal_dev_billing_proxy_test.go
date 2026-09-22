package internalapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/trade/internal/personaldevbilling"
)

type recordingPersonalDevBillingForwarder struct {
	kind     string
	path     string
	rawQuery string
	uin      string
	headers  http.Header
	body     string
	response *personaldevbilling.Response
	err      error
}

func (f *recordingPersonalDevBillingForwarder) Forward(
	_ context.Context,
	kind, path, rawQuery, uin string,
	headers http.Header,
	body []byte,
) (*personaldevbilling.Response, error) {
	f.kind = kind
	f.path = path
	f.rawQuery = rawQuery
	f.uin = uin
	f.headers = headers.Clone()
	f.body = string(body)
	return f.response, f.err
}

func newPersonalDevBillingInternalRouter(forwarder personalDevBillingForwarder) *gin.Engine {
	router := gin.New()
	group := router.Group("/internal/trade")
	group.Use(authMiddleware("internal-token"))
	group.POST("/personal-dev/billing-proxy/:kind/*path", personalDevBillingProxyHandler(forwarder))
	return router
}

func TestPersonalDevBillingProxyInternalRouteRequiresAuthAndForwardsUIN(t *testing.T) {
	forwarder := &recordingPersonalDevBillingForwarder{response: &personaldevbilling.Response{
		StatusCode: http.StatusOK,
		Header: http.Header{
			"Content-Type":            []string{"application/json"},
			"X-Qcloud-Transaction-Id": []string{"tx-test"},
		},
		Body: []byte(`{"ok":true}`),
	}}
	router := newPersonalDevBillingInternalRouter(forwarder)

	unauthorized := httptest.NewRequest(http.MethodPost, "/internal/trade/personal-dev/billing-proxy/jifei/resource-center/interface", strings.NewReader(`{}`))
	unauthorizedRecorder := httptest.NewRecorder()
	router.ServeHTTP(unauthorizedRecorder, unauthorized)
	if unauthorizedRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status=%d", unauthorizedRecorder.Code)
	}

	request := httptest.NewRequest(http.MethodPost, "/internal/trade/personal-dev/billing-proxy/jifei/resource-center/interface?trace=1", strings.NewReader(`{"request":1}`))
	request.Header.Set("Authorization", "Bearer internal-token")
	request.Header.Set(personaldevbilling.DeveloperUINHeader, "450860000023")
	request.Header.Set("X-Test-Header", "preserved")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || strings.TrimSpace(recorder.Body.String()) != `{"ok":true}` {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("X-Qcloud-Transaction-Id") != "tx-test" {
		t.Fatalf("transaction header=%q", recorder.Header().Get("X-Qcloud-Transaction-Id"))
	}
	if forwarder.kind != "jifei" || forwarder.path != "/resource-center/interface" ||
		forwarder.rawQuery != "trace=1" || forwarder.uin != "450860000023" ||
		forwarder.body != `{"request":1}` || forwarder.headers.Get("X-Test-Header") != "preserved" {
		t.Fatalf("forwarded=%+v", forwarder)
	}
}

func TestPersonalDevBillingProxyReadinessDoesNotCallBillingForwarder(t *testing.T) {
	forwarder := &recordingPersonalDevBillingForwarder{response: &personaldevbilling.Response{
		StatusCode: http.StatusTeapot,
	}}
	router := newPersonalDevBillingInternalRouter(forwarder)
	request := httptest.NewRequest(http.MethodPost, "/internal/trade/personal-dev/billing-proxy/cloudapi/?Action=DescribeOrderList", nil)
	request.Header.Set("Authorization", "Bearer internal-token")
	request.Header.Set(personaldevbilling.DeveloperUINHeader, "450860000023")
	request.Header.Set("X-TC-Action", "DescribeOrderList")
	request.Header.Set(personaldevbilling.OriginalAuthorizationHeader, personalDevBillingReadinessAuthorization)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || strings.TrimSpace(recorder.Body.String()) != `{"code":"OK","message":"ready"}` {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if forwarder.kind != "" || forwarder.path != "" {
		t.Fatalf("billing forwarder was called: %+v", forwarder)
	}
}

func TestPersonalDevBillingProxyInternalRouteDoesNotExposeForwarderError(t *testing.T) {
	const sensitive = "lvdt1.450860000023.secret-capability"
	forwarder := &recordingPersonalDevBillingForwarder{err: errors.New("upstream failed with " + sensitive)}
	router := newPersonalDevBillingInternalRouter(forwarder)
	request := httptest.NewRequest(http.MethodPost, "/internal/trade/personal-dev/billing-proxy/jifei/resource-center/interface", strings.NewReader(`{}`))
	request.Header.Set("Authorization", "Bearer internal-token")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), sensitive) {
		t.Fatalf("forwarder error leaked sensitive value: %s", recorder.Body.String())
	}
}
