package dshproxy

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStripExternalAccessHeadersAlwaysRemovesBrowserSuppliedValues(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "https://"+testBotHost+"/", nil)
	req.Header.Add(HeaderBotID, "bot-1")
	req.Header.Add(HeaderBotID, "bot-2")
	req.Header.Add(HeaderDelegatedSession, "delegated-1")
	req.Header.Add(HeaderDelegatedSession, "delegated-2")

	stripExternalAccessHeaders(req)

	if len(req.Header.Values(HeaderBotID)) != 0 || len(req.Header.Values(HeaderDelegatedSession)) != 0 {
		t.Fatal("external DSH access headers remained on the request")
	}
}
