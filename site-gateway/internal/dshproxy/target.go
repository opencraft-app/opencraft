package dshproxy

import (
	"net/http"

	"git.woa.com/wisp/mono/site-gateway/internal/tatproxy"
)

const (
	HeaderBotID            = "X-LightVela-DSH-Bot-Id"
	HeaderDelegatedSession = "X-LightVela-Delegated-Session"
)

type Target = tatproxy.Target

// stripExternalAccessHeaders removes values from the old proxy-injected
// contract. Browser requests must never be able to supply DSH authorization.
func stripExternalAccessHeaders(r *http.Request) {
	r.Header.Del(HeaderBotID)
	r.Header.Del(HeaderDelegatedSession)
}
