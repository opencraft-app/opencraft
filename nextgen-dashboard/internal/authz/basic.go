package authz

import (
	"crypto/subtle"
	"net/http"
)

func BasicAuth(username string, password string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		givenUser, givenPass, ok := r.BasicAuth()
		if !ok || !secureEquals(givenUser, username) || !secureEquals(givenPass, password) {
			w.Header().Set("WWW-Authenticate", `Basic realm="Lightclaw Admin", charset="UTF-8"`)
			http.Error(w, http.StatusText(http.StatusUnauthorized), http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func secureEquals(left string, right string) bool {
	if len(left) != len(right) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

