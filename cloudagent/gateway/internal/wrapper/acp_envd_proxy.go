package wrapper

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	acpEnvdProxyPortPrefix    = "49983-"
	acpSessionEnvdProxyPrefix = "/v1/acp/sessions/"
)

var errInnerEnvdStaleAuth = errors.New("inner envd returned unauthorized")

type envdEnsureCall struct {
	done chan struct{}
	err  error
}

func (runtime ACPSessionRuntime) hasInnerEnvdTarget() bool {
	if strings.TrimSpace(runtime.InnerSandboxID) == "" || strings.TrimSpace(runtime.InnerSandboxDomain) == "" {
		return false
	}
	if runtimeHostTypeFromRuntime(runtime) == runtimeHostTypeLocalWisp {
		return true
	}
	return strings.TrimSpace(runtime.InnerEnvdAccessToken) != ""
}

func (g *ACPGateway) ensureRuntimeProxyIDLocked(session *acpSession) {
	if session == nil || session.RuntimeGeneration == 0 || session.Closed {
		return
	}
	if strings.TrimSpace(session.Runtime.SessionProxyID) != "" {
		return
	}
	if session.Runtime.RuntimeID == "" && session.Runtime.OuterSandboxID == "" {
		return
	}
	session.Runtime.SessionProxyID = "spx-" + randomHex(18)
}

func (g *ACPGateway) markStaleRuntimeProxyLocked(runtime ACPSessionRuntime) {
	proxyID := strings.TrimSpace(runtime.SessionProxyID)
	if proxyID == "" {
		return
	}
	if g.staleProxyIDs == nil {
		g.staleProxyIDs = map[string]struct{}{}
	}
	g.staleProxyIDs[proxyID] = struct{}{}
}

func (s *Server) serveMaybeEnvdProxy(w http.ResponseWriter, r *http.Request) bool {
	host, validPort := splitProxyHost(r.Host)
	if !validPort {
		return false
	}
	proxyDomain := envdProxyDomain()
	if proxyDomain == "" {
		if strings.HasPrefix(host, acpEnvdProxyPortPrefix) {
			writeError(w, http.StatusServiceUnavailable, "envd_proxy_not_configured", "ACP_ENVD_PROXY_DOMAIN is required for envd proxy hosts")
			return true
		}
		return false
	}
	proxyID, ok := parseEnvdProxyHost(host, proxyDomain)
	if !ok {
		return false
	}
	s.acpGate.serveEnvdProxy(w, r, proxyID)
	return true
}

func envdProxyDomain() string {
	return strings.Trim(strings.TrimSpace(os.Getenv("ACP_ENVD_PROXY_DOMAIN")), ".")
}

func parseEnvdProxyHost(host, proxyDomain string) (string, bool) {
	host, validPort := splitProxyHost(host)
	if !validPort {
		return "", false
	}
	host = strings.ToLower(strings.Trim(host, "."))
	proxyDomain = strings.ToLower(strings.Trim(proxyDomain, "."))
	suffix := "." + proxyDomain
	if proxyDomain == "" || !strings.HasSuffix(host, suffix) {
		return "", false
	}
	label := strings.TrimSuffix(host, suffix)
	if !strings.HasPrefix(label, acpEnvdProxyPortPrefix) {
		return "", false
	}
	proxyID := strings.TrimPrefix(label, acpEnvdProxyPortPrefix)
	if !validSessionProxyID(proxyID) {
		return "", false
	}
	return proxyID, true
}

func validSessionProxyID(proxyID string) bool {
	if proxyID == "" || len(proxyID) > 63 {
		return false
	}
	for _, ch := range proxyID {
		if (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '-' {
			continue
		}
		return false
	}
	return proxyID[0] != '-' && proxyID[len(proxyID)-1] != '-'
}

func splitProxyHost(host string) (string, bool) {
	host = strings.TrimSpace(host)
	if h, _, err := net.SplitHostPort(host); err == nil {
		_, port, _ := net.SplitHostPort(host)
		if port != "80" && port != "443" {
			return "", false
		}
		return h, true
	}
	return host, true
}

func (g *ACPGateway) serveEnvdProxy(w http.ResponseWriter, r *http.Request, proxyID string) {
	start := time.Now()
	scope, errResp := scopeFromRequest(r)
	if errResp != nil {
		status := http.StatusBadRequest
		if errResp.Code == "identity_missing" {
			status = http.StatusUnauthorized
		}
		writeError(w, status, errResp.Code, errResp.Message)
		return
	}
	session, generation, err := g.sessionForProxyID(scope, proxyID)
	if err != nil {
		var stale staleSessionProxyError
		if errors.As(err, &stale) {
			writeError(w, http.StatusGone, "stale_session_proxy", "session proxy id is stale")
			return
		}
		var scopeErr sessionScopeError
		if errors.As(err, &scopeErr) {
			writeError(w, http.StatusForbidden, "scope_mismatch", "session is outside caller scope")
			return
		}
		writeError(w, http.StatusNotFound, "session_proxy_not_found", "session proxy id not found")
		return
	}
	runtime, err := g.ensureInnerEnvdTarget(r.Context(), session.SessionID, scope, generation, false)
	if err != nil {
		var stale staleSessionProxyError
		if errors.As(err, &stale) {
			writeError(w, http.StatusGone, "stale_session_proxy", "session proxy id is stale")
			return
		}
		writeError(w, http.StatusBadGateway, "inner_envd_unavailable", err.Error())
		return
	}
	if !g.proxyEnvd(w, r, r.URL.Path, session, generation, proxyID, runtime, start, envdProxyCanRetry(r)) {
		return
	}
	runtime, err = g.ensureInnerEnvdTarget(r.Context(), session.SessionID, scope, generation, true)
	if err != nil {
		var stale staleSessionProxyError
		if errors.As(err, &stale) {
			writeError(w, http.StatusGone, "stale_session_proxy", "session proxy id is stale")
			return
		}
		writeError(w, http.StatusBadGateway, "inner_envd_unavailable", err.Error())
		return
	}
	fmt.Fprintf(os.Stderr, "timeline source=server event=envd_proxy_retry session_id=%s generation=%d session_proxy_id=%s\n", session.SessionID, generation, proxyID)
	g.proxyEnvd(w, r, r.URL.Path, session, generation, proxyID, runtime, start, false)
}

func (g *ACPGateway) HandleSessionEnvdProxy(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	sessionID, envdPath, ok := parseSessionEnvdProxyPath(r.URL.Path)
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "unknown session envd endpoint")
		return
	}
	scope, errResp := scopeFromRequest(r)
	if errResp != nil {
		status := http.StatusBadRequest
		if errResp.Code == "identity_missing" {
			status = http.StatusUnauthorized
		}
		writeError(w, status, errResp.Code, errResp.Message)
		return
	}
	session, generation, err := g.sessionForSessionID(scope, sessionID)
	if err != nil {
		var stale staleSessionProxyError
		if errors.As(err, &stale) {
			writeError(w, http.StatusGone, "stale_session", "session is stale")
			return
		}
		var scopeErr sessionScopeError
		if errors.As(err, &scopeErr) {
			writeError(w, http.StatusForbidden, "scope_mismatch", "session is outside caller scope")
			return
		}
		writeError(w, http.StatusNotFound, "session_not_found", "session id not found")
		return
	}
	runtime, err := g.ensureInnerEnvdTarget(r.Context(), session.SessionID, scope, generation, false)
	if err != nil {
		var stale staleSessionProxyError
		if errors.As(err, &stale) {
			writeError(w, http.StatusGone, "stale_session", "session is stale")
			return
		}
		writeError(w, http.StatusBadGateway, "inner_envd_unavailable", err.Error())
		return
	}
	proxyID := session.Runtime.SessionProxyID
	if proxyID == "" {
		proxyID = session.SessionID
	}
	if !g.proxyEnvd(w, r, envdPath, session, generation, proxyID, runtime, start, envdProxyCanRetry(r)) {
		return
	}
	runtime, err = g.ensureInnerEnvdTarget(r.Context(), session.SessionID, scope, generation, true)
	if err != nil {
		var stale staleSessionProxyError
		if errors.As(err, &stale) {
			writeError(w, http.StatusGone, "stale_session", "session is stale")
			return
		}
		writeError(w, http.StatusBadGateway, "inner_envd_unavailable", err.Error())
		return
	}
	fmt.Fprintf(os.Stderr, "timeline source=server event=session_envd_proxy_retry session_id=%s generation=%d\n", session.SessionID, generation)
	g.proxyEnvd(w, r, envdPath, session, generation, proxyID, runtime, start, false)
}

func parseSessionEnvdProxyPath(requestPath string) (string, string, bool) {
	rest := strings.TrimPrefix(requestPath, acpSessionEnvdProxyPrefix)
	if rest == requestPath {
		return "", "", false
	}
	sessionID, envdPath, found := strings.Cut(rest, "/envd")
	sessionID = strings.TrimSpace(sessionID)
	if !found || sessionID == "" || strings.Contains(sessionID, "/") {
		return "", "", false
	}
	if envdPath == "" {
		envdPath = "/"
	}
	if !strings.HasPrefix(envdPath, "/") {
		envdPath = "/" + envdPath
	}
	return sessionID, envdPath, true
}

func (g *ACPGateway) proxyEnvd(w http.ResponseWriter, r *http.Request, envdPath string, session *acpSession, generation int64, proxyID string, runtime ACPSessionRuntime, start time.Time, allowRetry bool) bool {
	if g.handleSessionWorkspaceFileTransfer(w, r, envdPath, session, generation, runtime, start) {
		return false
	}
	target, err := innerEnvdURL(runtime)
	if err != nil {
		writeError(w, http.StatusBadGateway, "inner_envd_unavailable", err.Error())
		return false
	}
	g.noteRuntimeActivity(session.Scope, session.SessionID, generation, "envd_proxy")
	fmt.Fprintf(os.Stderr, "timeline source=server event=envd_proxy_start session_id=%s generation=%d session_proxy_id=%s inner_sandbox_id=%s path=%s\n", session.SessionID, generation, proxyID, runtime.InnerSandboxID, envdPath)
	shouldRetry := false
	proxy := &httputil.ReverseProxy{
		Director: func(out *http.Request) {
			out.URL.Scheme = target.Scheme
			out.URL.Host = target.Host
			out.URL.Path = singleJoiningSlash(target.Path, envdPath)
			out.URL.RawPath = ""
			out.URL.RawQuery = sanitizedEnvdQuery(r.URL.Query()).Encode()
			out.Host = target.Host
			stripEnvdCredentialHeaders(out.Header)
			out.Header.Set("X-Access-Token", runtime.InnerEnvdAccessToken)
			out.Header.Set("Authorization", basicAuthHeader(envdProxyUser()))
			wrapRawEnvdFileUpload(out, r)
		},
		FlushInterval: -1,
		ErrorHandler: func(rw http.ResponseWriter, req *http.Request, proxyErr error) {
			fmt.Fprintf(os.Stderr, "timeline source=server event=envd_proxy_failed session_id=%s generation=%d session_proxy_id=%s error=%s\n", session.SessionID, generation, proxyID, quoteServerField(proxyErr.Error()))
			g.invalidateInnerEnvdTarget(session.SessionID, generation)
			if allowRetry {
				shouldRetry = true
				return
			}
			writeError(rw, http.StatusBadGateway, "inner_envd_transport_failed", proxyErr.Error())
		},
		ModifyResponse: func(resp *http.Response) error {
			stripUpstreamCORSHeaders(resp.Header)
			if resp.StatusCode == http.StatusUnauthorized {
				g.invalidateInnerEnvdTarget(session.SessionID, generation)
				if allowRetry {
					_ = resp.Body.Close()
					return errInnerEnvdStaleAuth
				}
			}
			fmt.Fprintf(os.Stderr, "timeline source=server event=envd_proxy_done session_id=%s generation=%d session_proxy_id=%s status=%d elapsed_ms=%d\n", session.SessionID, generation, proxyID, resp.StatusCode, time.Since(start).Milliseconds())
			return nil
		},
	}
	proxy.ServeHTTP(w, r)
	return shouldRetry
}

func (g *ACPGateway) handleSessionWorkspaceFileTransfer(w http.ResponseWriter, r *http.Request, envdPath string, session *acpSession, generation int64, runtime ACPSessionRuntime, start time.Time) bool {
	if !strings.HasPrefix(r.URL.Path, acpSessionEnvdProxyPrefix) || envdPath != "/files" || !runtime.isWispOuterRuntime() {
		return false
	}
	manager, ok := g.runtimeManager.(ACPSessionWorkspaceFileManager)
	if !ok {
		writeError(w, http.StatusNotImplemented, "workspace_transfer_unavailable", "workspace file transfer is not supported by this runtime")
		return true
	}
	workspacePath := strings.TrimSpace(r.URL.Query().Get("path"))
	if workspacePath == "" {
		writeError(w, http.StatusBadRequest, "invalid_workspace_path", "path query is required")
		return true
	}
	switch r.Method {
	case http.MethodPost:
		content, err := readWorkspaceTransferUploadBody(r)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_upload_body", err.Error())
			return true
		}
		g.noteRuntimeActivity(session.Scope, session.SessionID, generation, "workspace_file_upload")
		fmt.Fprintf(os.Stderr, "timeline source=server event=workspace_file_upload_start session_id=%s generation=%d path=%s bytes=%d\n", session.SessionID, generation, quoteServerField(workspacePath), len(content))
		if err := manager.UploadSessionWorkspaceFile(r.Context(), runtime, workspacePath, content); err != nil {
			writeError(w, http.StatusBadGateway, "workspace_file_upload_failed", err.Error())
			return true
		}
		fmt.Fprintf(os.Stderr, "timeline source=server event=workspace_file_upload_done session_id=%s generation=%d path=%s elapsed_ms=%d\n", session.SessionID, generation, quoteServerField(workspacePath), time.Since(start).Milliseconds())
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "path": workspacePath})
		return true
	case http.MethodGet:
		g.noteRuntimeActivity(session.Scope, session.SessionID, generation, "workspace_file_download")
		fmt.Fprintf(os.Stderr, "timeline source=server event=workspace_file_download_start session_id=%s generation=%d path=%s\n", session.SessionID, generation, quoteServerField(workspacePath))
		content, err := manager.DownloadSessionWorkspaceFile(r.Context(), runtime, workspacePath)
		if err != nil {
			if isWorkspaceFileNotFoundText(err.Error()) {
				writeError(w, http.StatusNotFound, "workspace_file_not_found", err.Error())
				return true
			}
			writeError(w, http.StatusBadGateway, "workspace_file_download_failed", err.Error())
			return true
		}
		fmt.Fprintf(os.Stderr, "timeline source=server event=workspace_file_download_done session_id=%s generation=%d path=%s bytes=%d elapsed_ms=%d\n", session.SessionID, generation, quoteServerField(workspacePath), len(content), time.Since(start).Milliseconds())
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(content)
		return true
	default:
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "workspace file transfer supports GET and POST")
		return true
	}
}

func readWorkspaceTransferUploadBody(r *http.Request) ([]byte, error) {
	contentType := strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Type")))
	if strings.HasPrefix(contentType, "multipart/form-data") {
		reader, err := r.MultipartReader()
		if err != nil {
			return nil, err
		}
		for {
			part, err := reader.NextPart()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return nil, err
			}
			if part.FileName() == "" && part.FormName() != "file" {
				continue
			}
			return io.ReadAll(part)
		}
		return nil, fmt.Errorf("multipart upload missing file part")
	}
	if r.Body == nil || r.Body == http.NoBody {
		return []byte{}, nil
	}
	return io.ReadAll(r.Body)
}

func stripUpstreamCORSHeaders(h http.Header) {
	for _, name := range []string{
		"Access-Control-Allow-Origin",
		"Access-Control-Allow-Credentials",
		"Access-Control-Allow-Methods",
		"Access-Control-Allow-Headers",
		"Access-Control-Expose-Headers",
		"Access-Control-Max-Age",
	} {
		h.Del(name)
	}
	removeHeaderToken(h, "Vary", "Origin")
}

func removeHeaderToken(h http.Header, name, token string) {
	values := h.Values(name)
	if len(values) == 0 {
		return
	}
	h.Del(name)
	for _, value := range values {
		parts := strings.Split(value, ",")
		kept := make([]string, 0, len(parts))
		for _, part := range parts {
			part = strings.TrimSpace(part)
			if part == "" || strings.EqualFold(part, token) {
				continue
			}
			kept = append(kept, part)
		}
		if len(kept) > 0 {
			h.Add(name, strings.Join(kept, ", "))
		}
	}
}

func envdProxyCanRetry(r *http.Request) bool {
	return r.Body == nil || r.Body == http.NoBody || r.ContentLength == 0
}

type staleSessionProxyError struct{}

func (e staleSessionProxyError) Error() string { return "stale session proxy id" }

type sessionScopeError struct{}

func (e sessionScopeError) Error() string { return "session is outside caller scope" }

func (g *ACPGateway) sessionForProxyID(scope Scope, proxyID string) (*acpSession, int64, error) {
	g.mu.Lock()
	if g.staleProxyIDs != nil {
		if _, stale := g.staleProxyIDs[proxyID]; stale {
			g.mu.Unlock()
			return nil, 0, staleSessionProxyError{}
		}
	}
	for _, session := range g.sessions {
		if session.Runtime.SessionProxyID != proxyID {
			continue
		}
		if !sameScope(scope, session.Scope) {
			g.mu.Unlock()
			return nil, 0, sessionScopeError{}
		}
		generation := session.RuntimeGeneration
		out := cloneSession(session)
		g.mu.Unlock()
		return out, generation, nil
	}
	g.mu.Unlock()
	if g.store == nil {
		return nil, 0, fmt.Errorf("session proxy not found")
	}
	session, proxyGeneration, err := g.store.LoadACPSessionByProxyID(proxyID)
	if err != nil {
		return nil, 0, err
	}
	if !sameScope(scope, session.Scope) {
		return nil, 0, sessionScopeError{}
	}
	if proxyGeneration != session.RuntimeGeneration || session.Runtime.SessionProxyID != proxyID || session.Closed {
		return nil, 0, staleSessionProxyError{}
	}
	g.mu.Lock()
	g.sessions[session.SessionID] = session
	g.mu.Unlock()
	return cloneSession(session), proxyGeneration, nil
}

func (g *ACPGateway) sessionForSessionID(scope Scope, sessionID string) (*acpSession, int64, error) {
	g.mu.Lock()
	if session := g.sessions[sessionID]; session != nil {
		if !sameScope(scope, session.Scope) {
			g.mu.Unlock()
			return nil, 0, sessionScopeError{}
		}
		if session.Closed || session.State == acpRuntimeStateClosing || session.State == acpRuntimeStateClosed {
			g.mu.Unlock()
			return nil, 0, staleSessionProxyError{}
		}
		generation := session.RuntimeGeneration
		out := cloneSession(session)
		g.mu.Unlock()
		return out, generation, nil
	}
	g.mu.Unlock()

	if g.store == nil {
		return nil, 0, fmt.Errorf("session not found")
	}
	session, err := g.store.LoadACPSession(scope, sessionID)
	if err != nil {
		return nil, 0, err
	}
	if !sameScope(scope, session.Scope) {
		return nil, 0, sessionScopeError{}
	}
	if session.Closed || session.State == acpRuntimeStateClosing || session.State == acpRuntimeStateClosed {
		return nil, 0, staleSessionProxyError{}
	}
	g.mu.Lock()
	g.sessions[session.SessionID] = session
	g.mu.Unlock()
	return cloneSession(session), session.RuntimeGeneration, nil
}

func (g *ACPGateway) invalidateInnerEnvdTarget(sessionID string, generation int64) {
	g.mu.Lock()
	defer g.mu.Unlock()
	session, ok := g.sessions[sessionID]
	if !ok || session.RuntimeGeneration != generation {
		return
	}
	key := envdEnsureKey(sessionID, generation)
	if g.forceEnvdEnsures == nil {
		g.forceEnvdEnsures = map[string]struct{}{}
	}
	g.forceEnvdEnsures[key] = struct{}{}
	session.Runtime.InnerSandboxID = ""
	session.Runtime.InnerSandboxDomain = ""
	session.Runtime.InnerEnvdAccessToken = ""
	session.UpdatedAt = time.Now().UTC()
	g.persistSession(session)
	fmt.Fprintf(os.Stderr, "timeline source=server event=inner_envd_target_invalidated session_id=%s generation=%d\n", sessionID, generation)
}

func (g *ACPGateway) ensureInnerEnvdTarget(ctx context.Context, sessionID string, scope Scope, generation int64, force bool) (ACPSessionRuntime, error) {
	key := envdEnsureKey(sessionID, generation)
	for {
		g.mu.Lock()
		session, ok := g.sessions[sessionID]
		if !ok {
			g.mu.Unlock()
			return ACPSessionRuntime{}, fmt.Errorf("session not found")
		}
		if !sameScope(scope, session.Scope) {
			g.mu.Unlock()
			return ACPSessionRuntime{}, sessionScopeError{}
		}
		if session.RuntimeGeneration != generation || session.Closed || session.State == acpRuntimeStateClosing || session.State == acpRuntimeStateClosed {
			g.mu.Unlock()
			return ACPSessionRuntime{}, staleSessionProxyError{}
		}
		effectiveForce := force
		if g.forceEnvdEnsures != nil {
			if _, pending := g.forceEnvdEnsures[key]; pending {
				effectiveForce = true
			}
		}
		if session.Runtime.hasInnerEnvdTarget() && !effectiveForce {
			g.mu.Unlock()
			if err := g.refreshSessionRuntimeIfIdle(scope, sessionID, "envd_proxy"); err != nil {
				return ACPSessionRuntime{}, err
			}
			g.mu.Lock()
			current, ok := g.sessions[sessionID]
			if !ok {
				g.mu.Unlock()
				return ACPSessionRuntime{}, fmt.Errorf("session not found")
			}
			if !sameScope(scope, current.Scope) {
				g.mu.Unlock()
				return ACPSessionRuntime{}, sessionScopeError{}
			}
			if current.RuntimeGeneration != generation || current.Closed || current.State == acpRuntimeStateClosing || current.State == acpRuntimeStateClosed {
				g.mu.Unlock()
				return ACPSessionRuntime{}, staleSessionProxyError{}
			}
			runtime := current.Runtime
			g.mu.Unlock()
			return runtime, nil
		}
		if g.envdEnsures == nil {
			g.envdEnsures = map[string]*envdEnsureCall{}
		}
		if call := g.envdEnsures[key]; call != nil {
			done := call.done
			g.mu.Unlock()
			select {
			case <-done:
				if call.err != nil {
					return ACPSessionRuntime{}, call.err
				}
				continue
			case <-ctx.Done():
				return ACPSessionRuntime{}, ctx.Err()
			}
		}
		manager, ok := g.runtimeManager.(ACPSessionEnvdRuntimeManager)
		if !ok {
			g.mu.Unlock()
			return ACPSessionRuntime{}, fmt.Errorf("runtime manager does not support ensure-inner envd")
		}
		runtime := session.Runtime
		call := &envdEnsureCall{done: make(chan struct{})}
		g.envdEnsures[key] = call
		g.mu.Unlock()

		fmt.Fprintf(os.Stderr, "timeline source=server event=inner_envd_ensure_start session_id=%s generation=%d outer_sandbox_id=%s force=%t cached_target=%t\n", sessionID, generation, runtime.OuterSandboxID, effectiveForce, runtime.hasInnerEnvdTarget())
		update, err := manager.EnsureSessionEnvdRuntime(ctx, runtime, ACPSessionRuntimeEnsureRequest{
			SessionID:  sessionID,
			Scope:      scope,
			Generation: generation,
			Force:      effectiveForce,
		})

		g.mu.Lock()
		delete(g.envdEnsures, key)
		var ensuredRuntime ACPSessionRuntime
		if err == nil {
			current, ok := g.sessions[sessionID]
			if !ok || current.RuntimeGeneration != generation || current.Closed || current.State == acpRuntimeStateClosing || current.State == acpRuntimeStateClosed {
				err = staleSessionProxyError{}
			} else {
				if update.InnerSandboxID != "" {
					current.Runtime.InnerSandboxID = update.InnerSandboxID
				}
				if update.InnerSandboxDomain != "" {
					current.Runtime.InnerSandboxDomain = update.InnerSandboxDomain
				}
				if update.InnerEnvdAccessToken != "" {
					current.Runtime.InnerEnvdAccessToken = update.InnerEnvdAccessToken
				}
				if !current.Runtime.hasInnerEnvdTarget() {
					err = fmt.Errorf("ensure-inner returned incomplete envd identity")
				} else {
					current.UpdatedAt = time.Now().UTC()
					if g.forceEnvdEnsures != nil {
						delete(g.forceEnvdEnsures, key)
					}
					g.persistSession(current)
					ensuredRuntime = current.Runtime
					fmt.Fprintf(os.Stderr, "timeline source=server event=inner_envd_ensure_done session_id=%s generation=%d inner_sandbox_id=%s\n", sessionID, generation, current.Runtime.InnerSandboxID)
				}
			}
		}
		call.err = err
		close(call.done)
		g.mu.Unlock()
		if err != nil {
			fmt.Fprintf(os.Stderr, "timeline source=server event=inner_envd_ensure_failed session_id=%s generation=%d outer_sandbox_id=%s error=%s\n", sessionID, generation, runtime.OuterSandboxID, quoteServerField(err.Error()))
			return ACPSessionRuntime{}, err
		}
		return ensuredRuntime, nil
	}
}

func envdEnsureKey(sessionID string, generation int64) string {
	return fmt.Sprintf("%s:%d", sessionID, generation)
}

func innerEnvdURL(runtime ACPSessionRuntime) (*url.URL, error) {
	if runtimeHostTypeFromRuntime(runtime) == runtimeHostTypeLocalWisp {
		return nil, fmt.Errorf("local_wisp envd proxy is not supported")
	}
	domain := strings.TrimSpace(runtime.InnerSandboxDomain)
	if domain == "" || strings.TrimSpace(runtime.InnerSandboxID) == "" {
		return nil, fmt.Errorf("inner envd target is incomplete")
	}
	if strings.HasPrefix(domain, "http://") || strings.HasPrefix(domain, "https://") {
		return url.Parse(domain)
	}
	return url.Parse(fmt.Sprintf("https://%d-%s.%s", defaultAGSEnvdPort, runtime.InnerSandboxID, domain))
}

func stripEnvdCredentialHeaders(h http.Header) {
	for name := range h {
		switch strings.ToLower(name) {
		case "authorization", "x-access-token", "e2b-traffic-access-token":
			h.Del(name)
		}
	}
}

func sanitizedEnvdQuery(in url.Values) url.Values {
	out := url.Values{}
	for key, values := range in {
		if envdCredentialQueryKey(key) {
			continue
		}
		for _, value := range values {
			out.Add(key, value)
		}
	}
	if user := envdProxyUser(); user != "" {
		out.Set("username", user)
	}
	return out
}

func wrapRawEnvdFileUpload(out *http.Request, original *http.Request) {
	if original.Method != http.MethodPost || out.URL.Path != "/files" {
		return
	}
	contentType := strings.ToLower(strings.TrimSpace(original.Header.Get("Content-Type")))
	if strings.HasPrefix(contentType, "multipart/form-data") {
		return
	}
	if original.Body == nil || original.Body == http.NoBody {
		return
	}
	workspacePath := strings.TrimSpace(out.URL.Query().Get("path"))
	filename := "upload"
	if parts := strings.Split(strings.TrimRight(workspacePath, "/"), "/"); len(parts) > 0 && parts[len(parts)-1] != "" {
		filename = parts[len(parts)-1]
	}
	reader, writer := io.Pipe()
	multipartWriter := multipart.NewWriter(writer)
	go func() {
		part, err := multipartWriter.CreateFormFile("file", filename)
		if err == nil {
			_, err = io.Copy(part, original.Body)
		}
		if closeErr := multipartWriter.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			_ = writer.CloseWithError(err)
			return
		}
		_ = writer.Close()
	}()
	out.Body = reader
	out.ContentLength = -1
	out.Header.Del("Content-Length")
	out.Header.Set("Content-Type", multipartWriter.FormDataContentType())
}

func envdCredentialQueryKey(key string) bool {
	switch strings.ToLower(key) {
	case "access_token", "username", "signature", "expires", "expiry", "expires_at",
		"x-amz-signature", "x-amz-credential", "x-amz-algorithm", "x-amz-date",
		"x-amz-expires", "x-amz-signedheaders", "x-amz-security-token":
		return true
	default:
		return false
	}
}

func envdProxyUser() string {
	user := strings.TrimSpace(firstEnv("GATEWAY_ENVD_USER", "E2B_USER"))
	if user == "" {
		return "user"
	}
	return user
}

func basicAuthHeader(user string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"))
}

func singleJoiningSlash(a, b string) string {
	aslash := strings.HasSuffix(a, "/")
	bslash := strings.HasPrefix(b, "/")
	switch {
	case aslash && bslash:
		return a + b[1:]
	case !aslash && !bslash:
		return a + "/" + b
	default:
		return a + b
	}
}
