package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const (
	oauthRelayModeParam              = "relay_mode"
	oauthRelayIssuerRedirectURIParam = "issuer_redirect_uri"
	oauthRelayModeIssuer             = "issuer"
	oauthRelayIssuerHost             = "lightclaw.tech"
)

type oauthRelayState struct {
	Version           int    `json:"v"`
	Mode              string `json:"m"`
	Provider          string `json:"p"`
	Nonce             string `json:"n"`
	IssuerRedirectURI string `json:"iss"`
	TargetCallbackURI string `json:"tcb"`
}

type oauthStartState struct {
	StateParam  string
	CookieValue string
	RedirectURI string
}

func buildOAuthStartState(request *http.Request, provider string, callbackPath string, defaultRedirectURI string, nonce string) (oauthStartState, error) {
	if !isOAuthRelayStart(request) {
		return oauthStartState{
			StateParam:  nonce,
			CookieValue: nonce,
			RedirectURI: strings.TrimSpace(defaultRedirectURI),
		}, nil
	}

	issuerRedirectURI := strings.TrimSpace(request.URL.Query().Get(oauthRelayIssuerRedirectURIParam))
	if err := validateOAuthRelayIssuerRedirectURI(provider, issuerRedirectURI); err != nil {
		return oauthStartState{}, err
	}
	targetCallbackURI, err := deriveOAuthRelayTargetCallbackURI(request, provider, callbackPath)
	if err != nil {
		return oauthStartState{}, err
	}
	state := oauthRelayState{
		Version:           1,
		Mode:              oauthRelayModeIssuer,
		Provider:          provider,
		Nonce:             nonce,
		IssuerRedirectURI: issuerRedirectURI,
		TargetCallbackURI: targetCallbackURI,
	}
	encoded, err := encodeOAuthRelayState(state)
	if err != nil {
		return oauthStartState{}, err
	}
	return oauthStartState{
		StateParam:  encoded,
		CookieValue: nonce,
		RedirectURI: issuerRedirectURI,
	}, nil
}

func isOAuthRelayStart(request *http.Request) bool {
	if request == nil || request.URL == nil {
		return false
	}
	return strings.TrimSpace(request.URL.Query().Get(oauthRelayModeParam)) == oauthRelayModeIssuer
}

func parseOAuthRelayState(rawState string) (oauthRelayState, bool) {
	state, err := decodeOAuthRelayState(rawState)
	if err != nil {
		return oauthRelayState{}, false
	}
	return state, true
}

func encodeOAuthRelayState(state oauthRelayState) (string, error) {
	payload, err := json.Marshal(state)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(payload), nil
}

func decodeOAuthRelayState(raw string) (oauthRelayState, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return oauthRelayState{}, errors.New("empty relay state")
	}
	payload, err := base64.RawURLEncoding.DecodeString(trimmed)
	if err != nil {
		return oauthRelayState{}, err
	}
	var state oauthRelayState
	if err := json.Unmarshal(payload, &state); err != nil {
		return oauthRelayState{}, err
	}
	if state.Version != 1 || state.Mode != oauthRelayModeIssuer {
		return oauthRelayState{}, fmt.Errorf("unsupported relay state version=%d mode=%q", state.Version, state.Mode)
	}
	state.Provider = strings.TrimSpace(state.Provider)
	state.Nonce = strings.TrimSpace(state.Nonce)
	state.IssuerRedirectURI = strings.TrimSpace(state.IssuerRedirectURI)
	state.TargetCallbackURI = strings.TrimSpace(state.TargetCallbackURI)
	if state.Provider == "" || state.Nonce == "" || state.IssuerRedirectURI == "" || state.TargetCallbackURI == "" {
		return oauthRelayState{}, errors.New("incomplete relay state")
	}
	return state, nil
}

func validateOAuthRelayIssuerRedirectURI(provider string, rawURI string) error {
	parsed, err := url.Parse(strings.TrimSpace(rawURI))
	if err != nil {
		return fmt.Errorf("parse issuer redirect uri: %w", err)
	}
	if parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Opaque != "" {
		return errors.New("issuer redirect uri must be an absolute https url without userinfo")
	}
	if !strings.EqualFold(parsed.Hostname(), oauthRelayIssuerHost) {
		return fmt.Errorf("issuer redirect uri host must be %s", oauthRelayIssuerHost)
	}
	if parsed.Port() != "" {
		return errors.New("issuer redirect uri must not include an explicit port")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("issuer redirect uri must not include query or fragment")
	}
	if parsed.Path != oauthProviderCallbackPath(provider) {
		return fmt.Errorf("issuer redirect uri path must be %s", oauthProviderCallbackPath(provider))
	}
	return nil
}

func deriveOAuthRelayTargetCallbackURI(request *http.Request, provider string, callbackPath string) (string, error) {
	host := strings.ToLower(strings.TrimSpace(requestHostWithoutPort(request)))
	if !isOAuthRelaySandboxAPIHost(host) {
		return "", fmt.Errorf("relay target host %q is not a sandbox api host", host)
	}
	scheme := requestScheme(request)
	if scheme != "https" {
		return "", errors.New("relay target callback must use https")
	}
	target := scheme + "://" + host + callbackPath
	if err := validateOAuthRelayTargetCallbackURI(provider, target); err != nil {
		return "", err
	}
	return target, nil
}

func validateOAuthRelayTargetCallbackURI(provider string, rawURI string) error {
	parsed, err := url.Parse(strings.TrimSpace(rawURI))
	if err != nil {
		return fmt.Errorf("parse target callback uri: %w", err)
	}
	if parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Opaque != "" {
		return errors.New("target callback uri must be an absolute https url without userinfo")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("target callback uri must not include query or fragment")
	}
	if parsed.Port() != "" {
		return errors.New("target callback uri must not include an explicit port")
	}
	if parsed.Path != oauthProviderCallbackPath(provider) {
		return fmt.Errorf("target callback uri path must be %s", oauthProviderCallbackPath(provider))
	}
	if !isOAuthRelaySandboxAPIHost(strings.ToLower(strings.TrimSpace(parsed.Hostname()))) {
		return errors.New("target callback uri host must be a sandbox api host")
	}
	return nil
}

func validateOAuthRelayStateForProvider(provider string, state oauthRelayState) error {
	if state.Provider != provider {
		return fmt.Errorf("relay provider %q does not match %q", state.Provider, provider)
	}
	if err := validateOAuthRelayIssuerRedirectURI(provider, state.IssuerRedirectURI); err != nil {
		return err
	}
	if err := validateOAuthRelayTargetCallbackURI(provider, state.TargetCallbackURI); err != nil {
		return err
	}
	return nil
}

func isOAuthRelaySandboxAPIHost(host string) bool {
	const prefix = "api-sandbox-"
	const suffix = ".lightclaw.tech"
	normalized := strings.ToLower(strings.TrimSpace(host))
	if !strings.HasPrefix(normalized, prefix) || !strings.HasSuffix(normalized, suffix) {
		return false
	}
	env := strings.TrimSuffix(strings.TrimPrefix(normalized, prefix), suffix)
	lastDash := strings.LastIndex(env, "-")
	if lastDash <= 0 || lastDash == len(env)-1 {
		return false
	}
	region := env[:lastDash]
	number := env[lastDash+1:]
	if region == "" {
		return false
	}
	if _, err := strconv.Atoi(number); err != nil {
		return false
	}
	return true
}

func oauthProviderCallbackPath(provider string) string {
	return "/auth/oauth/" + strings.TrimSpace(provider) + "/callback"
}

func currentOAuthCallbackURI(request *http.Request, callbackPath string) string {
	host := requestHostWithoutPort(request)
	if host == "" {
		return ""
	}
	return requestScheme(request) + "://" + host + callbackPath
}

func isOAuthRelayIssuerCallback(request *http.Request, state oauthRelayState) bool {
	current := currentOAuthCallbackURI(request, oauthProviderCallbackPath(state.Provider))
	return current != "" && current == state.IssuerRedirectURI
}

func isOAuthRelayTargetCallback(request *http.Request, state oauthRelayState) bool {
	current := currentOAuthCallbackURI(request, oauthProviderCallbackPath(state.Provider))
	return current != "" && current == state.TargetCallbackURI
}

func relayCallbackURLWithOriginalQuery(target string, rawQuery string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(target))
	if err != nil {
		return "", err
	}
	parsed.RawQuery = rawQuery
	return parsed.String(), nil
}
