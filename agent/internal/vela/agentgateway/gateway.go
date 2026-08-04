// Package agentgateway exposes the minimum Agent-facing Vela capability API
// on a loopback-only listener. It never accepts an arbitrary upstream URL.
package agentgateway

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/agentapi"
	rootstate "github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/state"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/attachmentstore"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/im"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/messageindex"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/platform"
	"github.com/google/uuid"
)

const (
	maximumRequestBytes    = 1 << 20
	maximumUploadOverhead  = 1 << 20
	maximumHistoryMessages = 100
	maximumMessageRefs     = 5000
	maximumSearchTargets   = 20
	maximumSearchPages     = 10
	maximumSearchResults   = 2000
)

var (
	ErrInvalidConfig           = errors.New("Vela Agent Gateway 配置无效")
	ErrInvalidMessage          = errors.New("Vela Agent Gateway 消息无效")
	ErrGatewayUnavailable      = errors.New("Vela Agent Gateway 不可用")
	ErrLaunchAlreadyRegistered = errors.New(
		"Vela Agent launch 已注册",
	)
)

type Config struct {
	AgentID                  string
	ServerID                 string
	RuntimeEpoch             string
	StateRoot                string
	Executable               string
	Transport                *TransportSlot
	PlatformClient           *platform.Client
	AttachmentFetcher        AttachmentFetcher
	Now                      func() time.Time
	DirectoryRefreshInterval time.Duration
}

type AttachmentFetcher func(context.Context, string) ([]byte, string, error)

// Hub owns the daemon-wide loopback listener. Each registered Gateway is one
// launch-scoped capability context selected only by its unguessable token.
type Hub struct {
	baseURL  string
	listener net.Listener
	server   *http.Server

	mu            sync.RWMutex
	registrations map[string]*Gateway
	launches      map[string]*Gateway
	closed        bool
	closeOnce     sync.Once
	closeErr      error
}

type Gateway struct {
	config    Config
	token     string
	tokenFile string
	wrapper   string
	baseURL   string
	store     *rootstate.Store
	hub       *Hub
	launchKey string

	mu                sync.RWMutex
	targets           map[string]im.Conversation
	targetAliases     map[string]string
	reverseTargets    map[im.Conversation]string
	memberNames       map[string]string
	messages          []storedMessage
	capabilities      map[string]struct{}
	platformClient    *platform.Client
	accessToken       platform.AccessToken
	directory         platform.RuntimeDirectory
	directoryReady    bool
	directoryRefresh  sync.Mutex
	directoryCancel   context.CancelFunc
	directoryDone     chan struct{}
	messageIndex      *messageindex.Index
	attachmentStore   *attachmentstore.Store
	attachmentFetcher AttachmentFetcher
	now               func() time.Time
	pendingThreads    pendingThreadState

	closeOnce sync.Once
	closeErr  error
}

type storedMessage struct {
	target      string
	message     im.IncomingMessage
	content     string
	delivered   bool
	attachments []attachmentView
}

type attachmentView struct {
	ID        string `json:"id"`
	Filename  string `json:"filename"`
	MIMEType  string `json:"mimeType"`
	SizeBytes int64  `json:"sizeBytes"`
}

func NewHub() (*Hub, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	hub := &Hub{
		baseURL:       "http://" + listener.Addr().String(),
		listener:      listener,
		registrations: make(map[string]*Gateway),
		launches:      make(map[string]*Gateway),
	}
	hub.server = &http.Server{
		Handler:           http.HandlerFunc(hub.serveHTTP),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		_ = hub.server.Serve(listener)
	}()
	return hub, nil
}

func (h *Hub) Register(config Config) (*Gateway, error) {
	if h == nil {
		return nil, ErrInvalidConfig
	}
	if strings.TrimSpace(config.AgentID) == "" ||
		strings.TrimSpace(config.ServerID) == "" ||
		strings.TrimSpace(config.RuntimeEpoch) == "" ||
		!safeLaunchPart(config.RuntimeEpoch) ||
		!filepath.IsAbs(config.StateRoot) ||
		!filepath.IsAbs(config.Executable) ||
		config.Transport == nil || config.DirectoryRefreshInterval < 0 {
		return nil, ErrInvalidConfig
	}
	executableInfo, err := os.Lstat(config.Executable)
	if err != nil ||
		!executableInfo.Mode().IsRegular() ||
		executableInfo.Mode()&os.ModeSymlink != 0 {
		return nil, ErrInvalidConfig
	}
	launchKey := strings.Join(
		[]string{config.ServerID, config.AgentID, config.RuntimeEpoch},
		"\x00",
	)
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return nil, ErrGatewayUnavailable
	}
	if _, exists := h.launches[launchKey]; exists {
		h.mu.Unlock()
		return nil, ErrLaunchAlreadyRegistered
	}
	h.launches[launchKey] = nil
	h.mu.Unlock()
	registered := false
	defer func() {
		if registered {
			return
		}
		h.mu.Lock()
		if h.launches[launchKey] == nil {
			delete(h.launches, launchKey)
		}
		h.mu.Unlock()
	}()
	token, err := newToken()
	if err != nil {
		return nil, err
	}
	store := rootstate.New(filepath.Clean(config.StateRoot))
	messageIndex, err := messageindex.New(config.StateRoot, maximumMessageRefs)
	if err != nil {
		return nil, err
	}
	attachmentStore, err := attachmentstore.New(config.StateRoot)
	if err != nil {
		return nil, err
	}
	pendingThreads, err := loadPendingThreadRegistrations(store)
	if err != nil {
		return nil, err
	}
	attachmentFetcher := config.AttachmentFetcher
	if attachmentFetcher == nil {
		attachmentFetcher = fetchTencentAttachment
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	directoryRefreshInterval := config.DirectoryRefreshInterval
	if directoryRefreshInterval == 0 {
		directoryRefreshInterval = time.Minute
	}
	launchRelative := filepath.Join("launches", config.RuntimeEpoch)
	tokenRelative := filepath.Join(launchRelative, "proxy.token")
	if err := store.WriteFile(
		tokenRelative,
		[]byte(token),
		0o600,
	); err != nil {
		return nil, err
	}
	wrapperRelative := filepath.Join(launchRelative, "bin", "raft")
	slockWrapperRelative := filepath.Join(launchRelative, "bin", "slock")
	wrapper := "#!/bin/sh\n" +
		"exec " +
		shellQuote(config.Executable) +
		" __agent-cli \"$@\"\n"
	if err := store.WriteFile(
		wrapperRelative,
		[]byte(wrapper),
		0o700,
	); err != nil {
		_ = store.Remove(tokenRelative)
		return nil, err
	}
	if err := store.WriteFile(
		slockWrapperRelative,
		[]byte(wrapper),
		0o700,
	); err != nil {
		_ = store.Remove(wrapperRelative)
		_ = store.Remove(tokenRelative)
		return nil, err
	}
	gateway := &Gateway{
		config:            config,
		token:             token,
		tokenFile:         filepath.Join(config.StateRoot, tokenRelative),
		wrapper:           filepath.Join(config.StateRoot, wrapperRelative),
		baseURL:           h.baseURL,
		store:             store,
		hub:               h,
		launchKey:         launchKey,
		targets:           make(map[string]im.Conversation),
		targetAliases:     make(map[string]string),
		reverseTargets:    make(map[im.Conversation]string),
		memberNames:       make(map[string]string),
		capabilities:      make(map[string]struct{}),
		platformClient:    config.PlatformClient,
		messageIndex:      messageIndex,
		attachmentStore:   attachmentStore,
		attachmentFetcher: attachmentFetcher,
		now:               now,
		pendingThreads:    pendingThreadState{items: pendingThreads},
	}
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		_ = store.Remove(tokenRelative)
		_ = store.Remove(wrapperRelative)
		_ = store.Remove(slockWrapperRelative)
		return nil, ErrGatewayUnavailable
	}
	h.registrations[token] = gateway
	h.launches[launchKey] = gateway
	registered = true
	h.mu.Unlock()
	if config.PlatformClient != nil {
		refreshContext, cancel := context.WithCancel(context.Background())
		gateway.directoryCancel = cancel
		gateway.directoryDone = make(chan struct{})
		go gateway.runDirectoryRefresh(
			refreshContext, directoryRefreshInterval, gateway.directoryDone,
		)
	}
	return gateway, nil
}

func safeLaunchPart(value string) bool {
	return value != "." &&
		value != ".." &&
		filepath.Base(value) == value &&
		!strings.ContainsAny(value, `/\\`)
}

func (h *Hub) serveHTTP(
	response http.ResponseWriter,
	request *http.Request,
) {
	token, ok := localBearerToken(request)
	if !ok {
		writeUnauthorized(response)
		return
	}
	h.mu.RLock()
	gateway := h.registrations[token]
	h.mu.RUnlock()
	if gateway == nil {
		writeUnauthorized(response)
		return
	}
	gateway.serveHTTP(response, request)
}

func localBearerToken(request *http.Request) (string, bool) {
	if request == nil {
		return "", false
	}
	const prefix = "Bearer "
	authorization := request.Header.Get("Authorization")
	if !strings.HasPrefix(authorization, prefix) {
		return "", false
	}
	token := strings.TrimPrefix(authorization, prefix)
	if token == "" || strings.TrimSpace(token) != token ||
		strings.ContainsAny(token, " \t\r\n") {
		return "", false
	}
	return token, true
}

func writeUnauthorized(response http.ResponseWriter) {
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(http.StatusUnauthorized)
	_, _ = response.Write([]byte(
		`{"error":"invalid local launch","code":"invalid_local_launch"}`,
	))
}

func (h *Hub) unregister(token string, gateway *Gateway) {
	if h == nil || token == "" || gateway == nil {
		return
	}
	h.mu.Lock()
	if h.registrations[token] == gateway {
		delete(h.registrations, token)
	}
	if h.launches[gateway.launchKey] == gateway {
		delete(h.launches, gateway.launchKey)
	}
	h.mu.Unlock()
}

func (h *Hub) Close(ctx context.Context) error {
	if h == nil {
		return nil
	}
	h.closeOnce.Do(func() {
		if ctx == nil {
			ctx = context.Background()
		}
		h.mu.Lock()
		h.closed = true
		clear(h.registrations)
		clear(h.launches)
		h.mu.Unlock()
		h.closeErr = h.server.Shutdown(ctx)
	})
	return h.closeErr
}

func (g *Gateway) UpdateAuthorization(
	identity platform.AgentIdentity,
) error {
	if g == nil ||
		identity.ID != g.config.AgentID ||
		identity.ServerID != g.config.ServerID {
		return ErrInvalidConfig
	}
	capabilities := make(
		map[string]struct{},
		len(identity.Capabilities),
	)
	for _, capability := range identity.Capabilities {
		capability = strings.TrimSpace(capability)
		if capability != "" {
			capabilities[capability] = struct{}{}
		}
	}
	g.mu.Lock()
	g.capabilities = capabilities
	g.mu.Unlock()
	return nil
}

func (g *Gateway) UpdateSession(session platform.RuntimeSession) error {
	if g == nil ||
		session.Agent.ID != g.config.AgentID ||
		session.Agent.ServerID != g.config.ServerID ||
		strings.TrimSpace(session.AccessToken.Reveal()) == "" {
		return ErrInvalidConfig
	}
	capabilities := make(map[string]struct{}, len(session.Agent.Capabilities))
	for _, capability := range session.Agent.Capabilities {
		capability = strings.TrimSpace(capability)
		if capability != "" {
			capabilities[capability] = struct{}{}
		}
	}

	var (
		directory      platform.RuntimeDirectory
		targets        map[string]im.Conversation
		targetAliases  map[string]string
		reverseTargets map[im.Conversation]string
		memberNames    map[string]string
		directoryReady bool
	)
	if g.platformClient != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		var err error
		directory, err = g.platformClient.GetRuntimeDirectory(
			ctx,
			session.AccessToken,
			g.config.ServerID,
			g.config.AgentID,
		)
		if err != nil {
			return err
		}
		targets, targetAliases, reverseTargets, memberNames, err =
			buildDirectoryIndexes(directory)
		if err != nil {
			return err
		}
		directoryReady = true
	}
	g.mu.Lock()
	g.capabilities = capabilities
	g.accessToken = session.AccessToken
	if directoryReady {
		g.directory = directory
		g.directoryReady = true
		g.targets = targets
		g.targetAliases = targetAliases
		g.reverseTargets = reverseTargets
		g.memberNames = memberNames
	}
	g.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = g.drainPendingThreadRegistrations(ctx)
	return nil
}

func (g *Gateway) refreshDirectory(ctx context.Context, force bool) error {
	if g == nil || ctx == nil {
		return ErrInvalidConfig
	}
	g.directoryRefresh.Lock()
	defer g.directoryRefresh.Unlock()
	now := g.now().UTC()
	g.mu.RLock()
	client := g.platformClient
	token := g.accessToken
	ready := g.directoryReady
	expiresAt := g.directory.ExpiresAt
	g.mu.RUnlock()
	if client == nil || strings.TrimSpace(token.Reveal()) == "" {
		return nil
	}
	if !force && ready && expiresAt.After(now.Add(time.Minute)) {
		return nil
	}
	directory, err := client.GetRuntimeDirectory(
		ctx, token, g.config.ServerID, g.config.AgentID,
	)
	if err != nil {
		if ready && expiresAt.After(now) {
			return nil
		}
		return err
	}
	targets, aliases, reverse, members, err := buildDirectoryIndexes(directory)
	if err != nil {
		return err
	}
	g.mu.Lock()
	g.directory = directory
	g.directoryReady = true
	g.targets = targets
	g.targetAliases = aliases
	g.reverseTargets = reverse
	g.memberNames = members
	g.mu.Unlock()
	return nil
}

func (g *Gateway) runDirectoryRefresh(
	ctx context.Context,
	interval time.Duration,
	done chan<- struct{},
) {
	defer close(done)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			refreshContext, cancel := context.WithTimeout(ctx, 10*time.Second)
			_ = g.refreshDirectory(refreshContext, true)
			cancel()
		}
	}
}

func buildDirectoryIndexes(
	directory platform.RuntimeDirectory,
) (
	map[string]im.Conversation,
	map[string]string,
	map[im.Conversation]string,
	map[string]string,
	error,
) {
	targets := make(map[string]im.Conversation)
	targetAliases := make(map[string]string)
	reverseTargets := make(map[im.Conversation]string)
	memberNames := make(map[string]string, len(directory.Members))
	addTarget := func(alias string, conversation im.Conversation) error {
		key := strings.ToLower(alias)
		if _, duplicate := targetAliases[key]; duplicate {
			return platform.ErrInvalidRuntimeDirectory
		}
		if _, duplicate := reverseTargets[conversation]; duplicate {
			return platform.ErrInvalidRuntimeDirectory
		}
		targets[alias] = conversation
		targetAliases[key] = alias
		reverseTargets[conversation] = alias
		return nil
	}
	for _, channel := range directory.Channels {
		if channel.IMState != "ready" {
			continue
		}
		var (
			conversation im.Conversation
			err          error
		)
		if channel.IMTopicID != "" {
			conversation, err = im.NewTopicConversation(
				channel.IMGroupID,
				channel.IMTopicID,
			)
		} else {
			conversation, err = im.NewGroupConversation(channel.IMGroupID)
		}
		if err != nil || addTarget("#"+channel.Name, conversation) != nil {
			return nil, nil, nil, nil, platform.ErrInvalidRuntimeDirectory
		}
	}
	for _, member := range directory.Members {
		memberNames[member.IMUserID] = member.Handle
		if member.MemberID == directory.Self.MemberID {
			continue
		}
		conversation, err := im.NewC2CConversation(member.IMUserID)
		if err != nil || addTarget("@"+member.Handle, conversation) != nil {
			return nil, nil, nil, nil, platform.ErrInvalidRuntimeDirectory
		}
	}
	return targets, targetAliases, reverseTargets, memberNames, nil
}

func newToken() (string, error) {
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	return "sap_" +
		base64.RawURLEncoding.EncodeToString(random), nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func (g *Gateway) RuntimeEnvironment() map[string]string {
	if g == nil {
		return nil
	}
	binaryDirectory := filepath.Dir(g.wrapper)
	path := binaryDirectory
	if inherited := os.Getenv("PATH"); inherited != "" {
		path += string(os.PathListSeparator) + inherited
	}
	consumed := filepath.Join(
		g.config.StateRoot,
		"runtime",
		"consumed",
	)
	return map[string]string{
		"SLOCK_AGENT_ID":                   g.config.AgentID,
		"SLOCK_SERVER_ID":                  g.config.ServerID,
		"SLOCK_AGENT_PROXY_URL":            g.baseURL,
		"SLOCK_AGENT_PROXY_TOKEN_FILE":     g.tokenFile,
		"SLOCK_CLI_CONSUMED_SEQ_STATE_DIR": consumed,
		"RAFT_AGENT_PROXY_URL":             g.baseURL,
		"RAFT_AGENT_PROXY_TOKEN_FILE":      g.tokenFile,
		"PATH":                             path,
	}
}

func (g *Gateway) RegisterMessage(
	message im.IncomingMessage,
) (string, error) {
	if g == nil ||
		strings.TrimSpace(message.Ref.MessageID()) == "" ||
		strings.TrimSpace(message.SenderUserID) == "" {
		return "", ErrInvalidMessage
	}
	g.mu.Lock()
	canonicalTarget, found := g.reverseTargets[message.Ref.Conversation()]
	if !found {
		if g.directoryReady {
			g.mu.Unlock()
			return "", ErrInvalidMessage
		}
		var err error
		canonicalTarget, err = conversationTarget(message.Ref.Conversation())
		if err != nil {
			g.mu.Unlock()
			return "", err
		}
		g.targets[canonicalTarget] = message.Ref.Conversation()
		g.targetAliases[strings.ToLower(canonicalTarget)] = canonicalTarget
		g.reverseTargets[message.Ref.Conversation()] = canonicalTarget
	}
	g.mu.Unlock()
	if err := g.messageIndex.Add(canonicalTarget, message.Ref); err != nil {
		return "", err
	}
	if err := g.enrichPendingThreadRegistration(message.Ref); err != nil {
		return "", err
	}
	target := g.messageTarget(canonicalTarget, message)
	attachments, err := g.rememberAttachments(canonicalTarget, target, message)
	if err != nil {
		return "", err
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, existing := range g.messages {
		if existing.target == target &&
			existing.message.Ref.MessageID() ==
				message.Ref.MessageID() {
			return target, nil
		}
	}
	g.messages = append(g.messages, storedMessage{
		target:      target,
		message:     message,
		content:     messageText(message),
		attachments: attachments,
	})
	return target, nil
}

func (g *Gateway) rememberAttachments(
	canonicalTarget string,
	displayTarget string,
	message im.IncomingMessage,
) ([]attachmentView, error) {
	views := make([]attachmentView, 0)
	routeID := g.routeIDForTarget(canonicalTarget)
	for _, element := range message.Elements {
		if element.Type != im.ElementAttachment || element.Attachment == nil {
			continue
		}
		record, err := g.attachmentStore.Remember(
			routeID, displayTarget, message.Ref.MessageID(), *element.Attachment,
		)
		if err != nil {
			return nil, err
		}
		views = append(views, attachmentView{
			ID: record.ID, Filename: record.Filename, MIMEType: record.MIMEType,
			SizeBytes: record.SizeBytes,
		})
	}
	return views, nil
}

func (g *Gateway) routeIDForTarget(canonicalTarget string) string {
	g.mu.RLock()
	directory := g.directory
	g.mu.RUnlock()
	if strings.HasPrefix(canonicalTarget, "#") {
		for _, channel := range directory.Channels {
			if strings.EqualFold("#"+channel.Name, canonicalTarget) {
				return channel.ID
			}
		}
	}
	if strings.HasPrefix(canonicalTarget, "@") {
		for _, member := range directory.Members {
			if strings.EqualFold("@"+member.Handle, canonicalTarget) {
				return member.MemberID
			}
		}
	}
	return canonicalTarget
}

func (g *Gateway) messageTarget(
	canonicalTarget string,
	message im.IncomingMessage,
) string {
	metadata, ok := parseThreadCloudMetadata(message.CloudCustomData)
	if !ok || !strings.HasPrefix(canonicalTarget, "#") {
		return canonicalTarget
	}
	if metadata.ServerID != "" && metadata.ServerID != g.config.ServerID {
		return canonicalTarget
	}
	g.mu.RLock()
	directory := g.directory
	g.mu.RUnlock()
	channelMatches := false
	for _, channel := range directory.Channels {
		if (metadata.ChannelID == "" || channel.ID == metadata.ChannelID) &&
			strings.EqualFold("#"+channel.Name, canonicalTarget) {
			channelMatches = true
			break
		}
	}
	if !channelMatches {
		return canonicalTarget
	}
	root, err := g.messageIndex.Resolve(metadata.RootMessageID, canonicalTarget)
	if err != nil || root.Ref.MessageID() != metadata.RootMessageID {
		return canonicalTarget
	}
	return canonicalTarget + ":" + shortMessageID(metadata.RootMessageID)
}

func parseThreadCloudMetadata(value string) (threadCloudMetadata, bool) {
	if strings.TrimSpace(value) == "" || len(value) > 8*1024 {
		return threadCloudMetadata{}, false
	}
	var envelope threadMessageEnvelope
	if err := common.Unmarshal([]byte(value), &envelope); err == nil {
		rootMessageID := strings.TrimSpace(envelope.RootMessageID)
		if envelope.Thread != nil && rootMessageID == "" {
			rootMessageID = strings.TrimSpace(envelope.Thread.RootMessageRef.MessageID)
		}
		if (envelope.Schema == "raft.message/v1" ||
			envelope.Schema == "raft.thread-reply/v1") &&
			len(rootMessageID) >= 8 &&
			(envelope.ServerID == "" || isUUIDv7(envelope.ServerID)) &&
			(envelope.ConversationID == "" || isUUIDv7(envelope.ConversationID)) {
			metadata := threadCloudMetadata{
				ServerID: envelope.ServerID, ChannelID: envelope.ConversationID,
				RootMessageID: rootMessageID,
			}
			if envelope.Thread != nil {
				if envelope.Thread.Role != "reply" || !isUUIDv7(envelope.Thread.ThreadID) ||
					envelope.Thread.RootMessageRef.MessageID != rootMessageID {
					return threadCloudMetadata{}, false
				}
				metadata.ThreadID = envelope.Thread.ThreadID
			}
			return metadata, true
		}
	}
	var legacy legacyThreadCloudMetadata
	if err := common.Unmarshal([]byte(value), &legacy); err != nil ||
		legacy.Type != "raft.thread-reply/v1" ||
		!isUUIDv7(legacy.ThreadID) || !isUUIDv7(legacy.ChannelID) ||
		len(strings.TrimSpace(legacy.RootMessageID)) < 8 {
		return threadCloudMetadata{}, false
	}
	return threadCloudMetadata{
		ThreadID: legacy.ThreadID, ChannelID: legacy.ChannelID,
		RootMessageID: strings.TrimSpace(legacy.RootMessageID),
	}, true
}

func isUUIDv7(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.Version() == 7
}

func shortMessageID(value string) string {
	// Tencent message IDs commonly share a long conversation prefix. Truncating
	// from the front makes distinct messages resolve to the same Thread target.
	// Keep the complete provider ID as the stable, unambiguous reference.
	return value
}

func conversationTarget(
	conversation im.Conversation,
) (string, error) {
	encode := base64.RawURLEncoding.EncodeToString
	switch conversation.Kind() {
	case im.ConversationC2C:
		return "c2c:" +
			encode([]byte(conversation.PeerUserID())), nil
	case im.ConversationGroup:
		return "group:" +
			encode([]byte(conversation.GroupID())), nil
	case im.ConversationTopic:
		return "topic:" +
			encode([]byte(conversation.GroupID())) +
			":" +
			encode([]byte(conversation.TopicID())), nil
	default:
		return "", im.ErrInvalidConversation
	}
}

func messageText(message im.IncomingMessage) string {
	parts := make([]string, 0, len(message.Elements))
	for _, element := range message.Elements {
		if element.Type == im.ElementText &&
			strings.TrimSpace(element.Text) != "" {
			parts = append(parts, strings.TrimSpace(element.Text))
		}
	}
	return strings.Join(parts, "\n")
}

func (g *Gateway) serveHTTP(
	response http.ResponseWriter,
	request *http.Request,
) {
	if !g.authorized(request) {
		g.writeError(
			response,
			http.StatusUnauthorized,
			"invalid_local_launch",
			"本地 launch 凭据无效",
		)
		return
	}
	required := requiredCapability(request.Method, request.URL.Path)
	if required == "" {
		g.writeError(
			response,
			http.StatusNotFound,
			"route_not_exposed",
			"Vela 未开放该本地能力",
		)
		return
	}
	g.mu.RLock()
	_, allowed := g.capabilities[required]
	g.mu.RUnlock()
	if !allowed {
		g.writeError(
			response,
			http.StatusForbidden,
			"capability_denied",
			"当前 Runtime Session 未授权该能力",
		)
		return
	}
	if err := g.refreshDirectory(request.Context(), false); err != nil {
		g.writeError(response, http.StatusServiceUnavailable, "directory_unavailable", "Runtime 协作目录已过期且暂时无法刷新")
		return
	}
	_ = g.drainPendingThreadRegistrations(request.Context())
	switch {
	case request.Method == http.MethodGet &&
		request.URL.Path == agentapi.BasePath+"/inbox":
		g.serveInbox(response)
	case request.Method == http.MethodGet &&
		request.URL.Path == agentapi.BasePath+"/events":
		g.serveEvents(response)
	case request.Method == http.MethodGet &&
		request.URL.Path == agentapi.BasePath+"/history":
		g.serveHistory(response, request)
	case request.Method == http.MethodGet &&
		request.URL.Path == agentapi.BasePath+"/search":
		g.serveSearch(response, request)
	case request.Method == http.MethodGet &&
		isMessageResolvePath(request.URL.Path):
		g.serveMessageResolve(response, request)
	case request.Method == http.MethodPost &&
		request.URL.Path == agentapi.BasePath+"/send":
		g.serveSend(response, request)
	case request.Method == http.MethodPost &&
		request.URL.Path == agentapi.BasePath+"/resolve-channel":
		g.serveResolveChannel(response, request)
	case request.Method == http.MethodPost &&
		request.URL.Path == agentapi.BasePath+"/upload":
		g.serveAttachmentUpload(response, request)
	case request.Method == http.MethodGet &&
		isAttachmentDownloadPath(request.URL.Path):
		g.serveAttachmentDownload(response, request)
	case (request.Method == http.MethodPost || request.Method == http.MethodDelete) &&
		isReactionPath(request.URL.Path):
		g.serveReaction(response, request)
	case request.Method == http.MethodGet &&
		request.URL.Path == agentapi.BasePath+"/server":
		g.serveServer(response)
	case request.Method == http.MethodGet &&
		request.URL.Path == agentapi.BasePath+"/channel-members":
		g.serveChannelMembers(response, request)
	case request.Method == http.MethodGet &&
		request.URL.Path == agentapi.BasePath+"/tasks":
		g.serveTasks(response, request)
	case request.Method == http.MethodPost &&
		request.URL.Path == agentapi.BasePath+"/tasks/claim":
		g.serveTaskClaim(response, request)
	case request.Method == http.MethodPost &&
		request.URL.Path == agentapi.BasePath+"/tasks/update-status":
		g.serveTaskUpdate(response, request)
	case request.Method == http.MethodGet &&
		request.URL.Path == agentapi.BasePath+"/reminders":
		g.serveReminders(response, request)
	case request.Method == http.MethodPost &&
		request.URL.Path == agentapi.BasePath+"/reminders":
		g.serveReminderCreate(response, request)
	case isReminderMutationPath(request.Method, request.URL.Path):
		g.serveReminderMutation(response, request)
	default:
		g.writeError(
			response,
			http.StatusNotFound,
			"route_not_exposed",
			"Vela 未开放该本地能力",
		)
	}
}

func requiredCapability(method, path string) string {
	switch {
	case method == http.MethodGet &&
		(path == agentapi.BasePath+"/inbox" ||
			path == agentapi.BasePath+"/events" ||
			path == agentapi.BasePath+"/history" ||
			path == agentapi.BasePath+"/search" ||
			isMessageResolvePath(path)):
		return "read"
	case method == http.MethodPost &&
		path == agentapi.BasePath+"/send":
		return "send"
	case method == http.MethodPost && path == agentapi.BasePath+"/resolve-channel":
		return "send"
	case method == http.MethodPost && path == agentapi.BasePath+"/upload":
		return "attachments"
	case method == http.MethodGet && isAttachmentDownloadPath(path):
		return "attachments"
	case (method == http.MethodPost || method == http.MethodDelete) &&
		isReactionPath(path):
		return "reactions"
	case method == http.MethodGet &&
		path == agentapi.BasePath+"/server":
		return "server"
	case method == http.MethodGet &&
		path == agentapi.BasePath+"/channel-members":
		return "channels"
	case method == http.MethodGet && path == agentapi.BasePath+"/tasks":
		return "tasks"
	case method == http.MethodPost &&
		(path == agentapi.BasePath+"/tasks/claim" ||
			path == agentapi.BasePath+"/tasks/update-status"):
		return "tasks"
	case path == agentapi.BasePath+"/reminders" &&
		(method == http.MethodGet || method == http.MethodPost):
		return "reminders"
	case isReminderMutationPath(method, path):
		return "reminders"
	default:
		return ""
	}
}

func isReminderMutationPath(method string, path string) bool {
	prefix := agentapi.BasePath + "/reminders/"
	value := strings.TrimPrefix(path, prefix)
	if !strings.HasPrefix(path, prefix) || value == "" {
		return false
	}
	if !strings.Contains(value, "/") {
		return method == http.MethodPatch || method == http.MethodDelete
	}
	parts := strings.Split(value, "/")
	return len(parts) == 2 && parts[0] != "" &&
		(parts[1] == "snooze" && method == http.MethodPost ||
			parts[1] == "log" && method == http.MethodGet)
}

func isAttachmentDownloadPath(path string) bool {
	prefix := agentapi.BasePath + "/attachments/"
	value := strings.TrimPrefix(path, prefix)
	return strings.HasPrefix(path, prefix) && value != "" &&
		!strings.Contains(value, "/")
}

func isReactionPath(path string) bool {
	prefix := agentapi.BasePath + "/messages/"
	return strings.HasPrefix(path, prefix) &&
		strings.HasSuffix(path, "/reactions") &&
		len(strings.TrimSuffix(strings.TrimPrefix(path, prefix), "/reactions")) >= 8
}

func isMessageResolvePath(path string) bool {
	prefix := agentapi.BasePath + "/messages/"
	suffix := "/resolve"
	value := strings.TrimSuffix(strings.TrimPrefix(path, prefix), suffix)
	return strings.HasPrefix(path, prefix) && strings.HasSuffix(path, suffix) &&
		len(value) >= 8 && !strings.Contains(value, "/")
}

func (g *Gateway) authorized(request *http.Request) bool {
	provided, ok := localBearerToken(request)
	if !ok {
		return false
	}
	g.mu.RLock()
	token := g.token
	g.mu.RUnlock()
	if len(provided) != len(token) {
		return false
	}
	return subtle.ConstantTimeCompare(
		[]byte(provided),
		[]byte(token),
	) == 1
}

func (g *Gateway) serveInbox(response http.ResponseWriter) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	type row struct {
		Target           string   `json:"target"`
		PendingCount     int      `json:"pendingCount"`
		FirstPendingID   string   `json:"firstPendingMsgId"`
		LatestMessageID  string   `json:"latestMsgId"`
		LatestSenderName string   `json:"latestSenderName"`
		Flags            []string `json:"flags"`
	}
	byTarget := make(map[string][]storedMessage)
	order := make([]string, 0)
	for _, message := range g.messages {
		if message.delivered {
			continue
		}
		if _, exists := byTarget[message.target]; !exists {
			order = append(order, message.target)
		}
		byTarget[message.target] = append(
			byTarget[message.target],
			message,
		)
	}
	rows := make([]row, 0, len(order))
	for _, target := range order {
		messages := byTarget[target]
		latest := messages[len(messages)-1]
		senderName := g.memberNames[latest.message.SenderUserID]
		if senderName == "" {
			senderName = latest.message.SenderUserID
		}
		rows = append(rows, row{
			Target:           target,
			PendingCount:     len(messages),
			FirstPendingID:   messages[0].message.Ref.MessageID(),
			LatestMessageID:  latest.message.Ref.MessageID(),
			LatestSenderName: senderName,
			Flags:            []string{},
		})
	}
	g.writeJSON(response, http.StatusOK, map[string]any{
		"rows": rows,
	})
}

func (g *Gateway) serveEvents(response http.ResponseWriter) {
	g.mu.Lock()
	defer g.mu.Unlock()
	events := make([]map[string]any, 0, len(g.messages))
	var (
		lastMessageID string
		lastSequence  any
		replyTarget   any
	)
	for index := range g.messages {
		stored := g.messages[index]
		if stored.delivered {
			continue
		}
		message := stored.message
		senderName, senderType := memberPresentation(
			g.directory, g.memberNames, message.SenderUserID,
		)
		timestamp := time.UnixMilli(
			message.Ref.TimestampMS(),
		).UTC().Format(time.RFC3339Nano)
		events = append(events, map[string]any{
			"seq":          message.Ref.Sequence(),
			"id":           message.Ref.MessageID(),
			"message_id":   message.Ref.MessageID(),
			"timestamp":    timestamp,
			"createdAt":    timestamp,
			"sender_type":  senderType,
			"sender_name":  senderName,
			"channel_type": channelType(message.Ref.Conversation(), stored.target),
			"channel_name": stored.target,
			"content":      stored.content,
			"attachments":  stored.attachments,
		})
		lastMessageID = message.Ref.MessageID()
		lastSequence = message.Ref.Sequence()
		replyTarget = stored.target
		g.messages[index].delivered = true
	}
	g.writeJSON(response, http.StatusOK, map[string]any{
		"events":             events,
		"last_seen_msgId":    nullableString(lastMessageID),
		"last_seen_seq":      lastSequence,
		"reply_target":       replyTarget,
		"pending_notice_ids": []string{},
		"wake_reason":        nil,
		"has_more":           false,
	})
}

func (g *Gateway) serveHistory(
	response http.ResponseWriter,
	request *http.Request,
) {
	target := strings.TrimSpace(request.URL.Query().Get("channel"))
	if target == "" {
		g.writeError(
			response,
			http.StatusBadRequest,
			"invalid_request",
			"message read 需要有效 target",
		)
		return
	}
	limit := 50
	if raw := request.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 || parsed > maximumHistoryMessages {
			g.writeError(
				response,
				http.StatusBadRequest,
				"invalid_request",
				"message read limit 无效",
			)
			return
		}
		limit = parsed
	}

	g.mu.RLock()
	canonicalTarget, authorized := g.targetAliases[strings.ToLower(target)]
	conversation := g.targets[canonicalTarget]
	g.mu.RUnlock()
	threadRootMessageID := ""
	if !authorized {
		channelTarget, rootPrefix, threadTarget := splitThreadTarget(target)
		if threadTarget {
			g.mu.RLock()
			canonicalTarget, authorized = g.targetAliases[strings.ToLower(channelTarget)]
			conversation = g.targets[canonicalTarget]
			g.mu.RUnlock()
			if authorized {
				root, err := g.messageIndex.Resolve(rootPrefix, canonicalTarget)
				if err != nil {
					authorized = false
				} else {
					threadRootMessageID = root.Ref.MessageID()
				}
			}
		}
	}
	if !authorized {
		g.writeError(
			response,
			http.StatusForbidden,
			"target_not_authorized",
			"target 未由当前 Host 签发",
		)
		return
	}
	transport := g.config.Transport.Current()
	history, ok := transport.(im.HistoryTransport)
	if !ok {
		g.writeError(response, http.StatusServiceUnavailable, "im_history_unavailable", "腾讯 IM 历史当前不可用")
		return
	}
	cursor := strings.TrimSpace(request.URL.Query().Get("before"))
	afterSequence := int64(0)
	if after := strings.TrimSpace(request.URL.Query().Get("after")); after != "" {
		if parsed, err := strconv.ParseInt(after, 10, 64); err == nil && parsed >= 0 {
			afterSequence = parsed
		} else if entry, err := g.messageIndex.Resolve(after, canonicalTarget); err == nil {
			afterSequence = entry.Ref.Sequence()
		} else {
			g.writeError(response, http.StatusBadRequest, "invalid_request", "message read after 无法解析")
			return
		}
	}
	aroundSequence := int64(0)
	aroundTimestampMS := int64(0)
	if around := strings.TrimSpace(request.URL.Query().Get("around")); around != "" {
		entry, err := g.messageIndex.Resolve(around, canonicalTarget)
		if err != nil {
			g.writeError(
				response,
				http.StatusBadRequest,
				"invalid_request",
				"message read around 无法解析",
			)
			return
		}
		if conversation.Kind() == im.ConversationC2C {
			aroundTimestampMS = entry.Ref.TimestampMS()
		} else {
			aroundSequence = entry.Ref.Sequence()
		}
	}
	messages := make([]im.IncomingMessage, 0, limit)
	completed := false
	seenCursors := make(map[string]struct{})
	for len(messages) < limit && !completed {
		page, err := history.History(request.Context(), im.HistoryRequest{
			Conversation: conversation, Cursor: cursor,
			AfterSequence: afterSequence, AroundSequence: aroundSequence,
			AroundTimestampMS: aroundTimestampMS,
		})
		if err != nil {
			g.writeError(response, http.StatusBadGateway, "im_history_failed", "腾讯 IM 历史读取失败")
			return
		}
		for _, message := range page.Messages {
			if message.Ref.Conversation() != conversation {
				continue
			}
			if threadRootMessageID != "" {
				metadata, ok := parseThreadCloudMetadata(message.CloudCustomData)
				if !ok || metadata.RootMessageID != threadRootMessageID {
					continue
				}
			}
			if err := g.messageIndex.Add(canonicalTarget, message.Ref); err != nil {
				g.writeError(response, http.StatusInternalServerError, "message_index_failed", "消息引用索引写入失败")
				return
			}
			messages = append(messages, message)
		}
		completed = page.Completed
		next := strings.TrimSpace(page.NextCursor)
		if completed || next == "" || next == cursor {
			break
		}
		if _, duplicate := seenCursors[next]; duplicate {
			break
		}
		seenCursors[next] = struct{}{}
		cursor = next
		afterSequence = 0
	}
	if len(messages) > limit {
		messages = messages[len(messages)-limit:]
	}
	rows := make([]map[string]any, 0, len(messages))
	for _, message := range messages {
		senderName, senderType := g.directoryMemberPresentation(message.SenderUserID)
		timestamp := time.UnixMilli(
			message.Ref.TimestampMS(),
		).UTC().Format(time.RFC3339Nano)
		displayTarget := g.messageTarget(canonicalTarget, message)
		attachments, attachmentErr := g.rememberAttachments(canonicalTarget, displayTarget, message)
		if attachmentErr != nil {
			g.writeError(response, http.StatusInternalServerError, "attachment_index_failed", "附件引用索引写入失败")
			return
		}
		rows = append(rows, map[string]any{
			"seq":         message.Ref.Sequence(),
			"id":          message.Ref.MessageID(),
			"message_id":  message.Ref.MessageID(),
			"senderName":  senderName,
			"senderType":  senderType,
			"content":     messageText(message),
			"createdAt":   timestamp,
			"attachments": attachments,
		})
	}
	_ = history.MarkRead(request.Context(), conversation)
	g.writeJSON(response, http.StatusOK, map[string]any{
		"messages":  rows,
		"has_more":  !completed,
		"has_older": !completed,
		"has_newer": false,
	})
}

func (g *Gateway) serveSearch(response http.ResponseWriter, request *http.Request) {
	query := strings.TrimSpace(request.URL.Query().Get("q"))
	if query == "" || len([]rune(query)) > 200 {
		g.writeError(response, http.StatusBadRequest, "invalid_request", "message search query 无效")
		return
	}
	for _, unsupported := range []string{"sender", "before", "after", "sort"} {
		if request.URL.Query().Get(unsupported) != "" {
			g.writeError(response, http.StatusBadRequest, "unsupported_filter", "Vela 尚未开放该搜索过滤条件")
			return
		}
	}
	limit := 20
	if raw := request.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 || parsed > 100 {
			g.writeError(response, http.StatusBadRequest, "invalid_request", "message search limit 无效")
			return
		}
		limit = parsed
	}
	offset := 0
	if raw := request.URL.Query().Get("offset"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 || parsed > 1000 {
			g.writeError(response, http.StatusBadRequest, "invalid_request", "message search offset 无效")
			return
		}
		offset = parsed
	}
	transport, ok := g.config.Transport.Current().(im.SearchTransport)
	if !ok {
		g.writeError(response, http.StatusServiceUnavailable, "im_search_unavailable", "腾讯 IM 搜索当前不可用")
		return
	}
	type targetConversation struct {
		target       string
		conversation im.Conversation
	}
	targets := make([]targetConversation, 0)
	requestedTarget := strings.TrimSpace(request.URL.Query().Get("channel"))
	g.mu.RLock()
	if requestedTarget != "" {
		canonical, exists := g.targetAliases[strings.ToLower(requestedTarget)]
		if exists {
			targets = append(targets, targetConversation{target: canonical, conversation: g.targets[canonical]})
		}
	} else {
		for target, conversation := range g.targets {
			targets = append(targets, targetConversation{target: target, conversation: conversation})
		}
	}
	g.mu.RUnlock()
	if requestedTarget != "" && len(targets) == 0 {
		g.writeError(response, http.StatusForbidden, "target_not_authorized", "target 未由当前 Host 签发")
		return
	}
	sort.Slice(targets, func(i, j int) bool { return targets[i].target < targets[j].target })
	partial := len(targets) > maximumSearchTargets
	if len(targets) > maximumSearchTargets {
		targets = targets[:maximumSearchTargets]
	}
	type resultRow struct {
		message im.IncomingMessage
		target  string
	}
	results := make([]resultRow, 0, limit+offset)
	seenResults := make(map[string]struct{})
	searchComplete := true
searchTargets:
	for _, target := range targets {
		conversation := target.conversation
		cursor := ""
		seenCursors := make(map[string]struct{})
		conversationComplete := false
		for pageIndex := 0; pageIndex < maximumSearchPages; pageIndex++ {
			page, err := transport.Search(request.Context(), im.SearchRequest{
				Conversation: &conversation, Query: query, Cursor: cursor,
				Limit: min(limit+offset, 100),
			})
			if err != nil {
				g.writeError(response, http.StatusBadGateway, "im_search_failed", "腾讯 IM 搜索失败")
				return
			}
			for _, message := range page.Messages {
				if message.Ref.Conversation() != conversation {
					continue
				}
				resultKey := target.target + "\x00" + message.Ref.MessageID()
				if _, duplicate := seenResults[resultKey]; duplicate {
					continue
				}
				if err := g.messageIndex.Add(target.target, message.Ref); err != nil {
					g.writeError(response, http.StatusInternalServerError, "message_index_failed", "消息引用索引写入失败")
					return
				}
				seenResults[resultKey] = struct{}{}
				results = append(results, resultRow{message: message, target: target.target})
				if len(results) >= maximumSearchResults {
					searchComplete = false
					break searchTargets
				}
			}
			if page.Completed {
				conversationComplete = true
				break
			}
			next := strings.TrimSpace(page.NextCursor)
			if next == "" || next == cursor {
				break
			}
			if _, duplicate := seenCursors[next]; duplicate {
				break
			}
			seenCursors[next] = struct{}{}
			cursor = next
		}
		if !conversationComplete {
			searchComplete = false
		}
	}
	partial = partial || !searchComplete
	sort.SliceStable(results, func(i, j int) bool {
		return results[i].message.Ref.TimestampMS() > results[j].message.Ref.TimestampMS()
	})
	if offset > len(results) {
		offset = len(results)
	}
	end := min(len(results), offset+limit)
	partial = partial || end < len(results)
	rows := make([]map[string]any, 0, end-offset)
	for _, result := range results[offset:end] {
		message := result.message
		senderName, senderType := g.directoryMemberPresentation(message.SenderUserID)
		content := messageText(message)
		displayTarget := g.messageTarget(result.target, message)
		attachments, attachmentErr := g.rememberAttachments(result.target, displayTarget, message)
		if attachmentErr != nil {
			g.writeError(response, http.StatusInternalServerError, "attachment_index_failed", "附件引用索引写入失败")
			return
		}
		rows = append(rows, map[string]any{
			"id": message.Ref.MessageID(), "seq": message.Ref.Sequence(),
			"channelId": displayTarget, "channelName": strings.TrimPrefix(displayTarget, "#"),
			"channelType": channelType(message.Ref.Conversation(), displayTarget),
			"senderId":    message.SenderUserID, "senderType": senderType, "senderName": senderName,
			"content": content, "snippet": content,
			"attachments": attachments,
			"createdAt":   time.UnixMilli(message.Ref.TimestampMS()).UTC().Format(time.RFC3339Nano),
		})
	}
	g.writeJSON(response, http.StatusOK, map[string]any{"results": rows, "hasMore": partial})
}

func (g *Gateway) serveMessageResolve(response http.ResponseWriter, request *http.Request) {
	prefix := agentapi.BasePath + "/messages/"
	messageID := strings.TrimSuffix(strings.TrimPrefix(request.URL.Path, prefix), "/resolve")
	entry, err := g.messageIndex.Resolve(messageID, "")
	if err != nil {
		g.writeError(response, http.StatusNotFound, "message_not_indexed", "消息引用不存在或不唯一")
		return
	}
	g.mu.RLock()
	conversation, authorized := g.targets[entry.Target]
	var indexed *im.IncomingMessage
	for index := range g.messages {
		message := g.messages[index].message
		if message.Ref.MessageID() == entry.Ref.MessageID() &&
			message.Ref.Conversation() == entry.Ref.Conversation() {
			copy := message
			indexed = &copy
			break
		}
	}
	g.mu.RUnlock()
	if !authorized || conversation != entry.Ref.Conversation() {
		g.writeError(response, http.StatusForbidden, "message_not_authorized", "消息已不在当前 Runtime 授权目录内")
		return
	}
	message := im.IncomingMessage{}
	if indexed != nil {
		message = *indexed
	} else {
		history, ok := g.config.Transport.Current().(im.HistoryTransport)
		if !ok {
			g.writeError(response, http.StatusServiceUnavailable, "im_history_unavailable", "腾讯 IM 历史当前不可用")
			return
		}
		cursor := ""
		afterSequence := max(int64(0), entry.Ref.Sequence()-1)
		for pageIndex := 0; pageIndex < 10; pageIndex++ {
			page, historyErr := history.History(request.Context(), im.HistoryRequest{
				Conversation: conversation, Cursor: cursor, AfterSequence: afterSequence,
			})
			if historyErr != nil {
				g.writeError(response, http.StatusBadGateway, "im_history_failed", "腾讯 IM 消息解析失败")
				return
			}
			for _, candidate := range page.Messages {
				if candidate.Ref.Conversation() == conversation &&
					candidate.Ref.MessageID() == entry.Ref.MessageID() {
					message = candidate
					break
				}
			}
			if message.Ref.MessageID() != "" || page.Completed ||
				strings.TrimSpace(page.NextCursor) == "" || page.NextCursor == cursor {
				break
			}
			cursor = page.NextCursor
			afterSequence = 0
		}
	}
	if message.Ref.MessageID() == "" {
		g.writeError(response, http.StatusNotFound, "message_not_found", "腾讯 IM 中未找到该消息")
		return
	}
	displayTarget := g.messageTarget(entry.Target, message)
	attachments, err := g.rememberAttachments(entry.Target, displayTarget, message)
	if err != nil {
		g.writeError(response, http.StatusInternalServerError, "attachment_index_failed", "附件引用索引写入失败")
		return
	}
	senderName, senderType := g.directoryMemberPresentation(message.SenderUserID)
	channelName := strings.TrimLeft(displayTarget, "#@")
	row := map[string]any{
		"seq": message.Ref.Sequence(), "id": message.Ref.MessageID(),
		"message_id": message.Ref.MessageID(), "sender_type": senderType,
		"sender_name": senderName, "channel_type": channelType(conversation, displayTarget),
		"channel_name": channelName, "content": messageText(message),
		"timestamp":   time.UnixMilli(message.Ref.TimestampMS()).UTC().Format(time.RFC3339Nano),
		"createdAt":   time.UnixMilli(message.Ref.TimestampMS()).UTC().Format(time.RFC3339Nano),
		"attachments": attachments,
	}
	if channelTarget, rootPrefix, ok := splitThreadTarget(displayTarget); ok {
		row["channel_name"] = "thread-" + rootPrefix
		row["parent_channel_type"] = "channel"
		row["parent_channel_name"] = strings.TrimPrefix(channelTarget, "#")
	}
	g.writeJSON(response, http.StatusOK, map[string]any{"message": row})
}

func (g *Gateway) directoryMemberPresentation(userID string) (string, string) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return memberPresentation(g.directory, g.memberNames, userID)
}

func memberPresentation(
	directory platform.RuntimeDirectory,
	memberNames map[string]string,
	userID string,
) (string, string) {
	name := memberNames[userID]
	kind := "human"
	for _, member := range directory.Members {
		if member.IMUserID == userID {
			if member.Handle != "" {
				name = member.Handle
			}
			if member.Kind == "agent" {
				kind = "agent"
			}
			break
		}
	}
	if name == "" {
		name = userID
	}
	return name, kind
}

func (g *Gateway) serveReaction(response http.ResponseWriter, request *http.Request) {
	prefix := agentapi.BasePath + "/messages/"
	messageID := strings.TrimSuffix(strings.TrimPrefix(request.URL.Path, prefix), "/reactions")
	var payload struct {
		Emoji string `json:"emoji"`
	}
	if err := common.DecodeJson(io.LimitReader(request.Body, maximumRequestBytes+1), &payload); err != nil ||
		strings.TrimSpace(payload.Emoji) == "" || len([]rune(payload.Emoji)) > 32 {
		g.writeError(response, http.StatusBadRequest, "invalid_request", "Reaction 参数无效")
		return
	}
	entry, err := g.messageIndex.Resolve(messageID, "")
	if err != nil {
		g.writeError(response, http.StatusNotFound, "message_not_indexed", "消息引用不存在或不唯一")
		return
	}
	_, _, conversation, authorized := g.resolveAuthorizedTargetWithRefresh(
		request.Context(), entry.Target,
	)
	if !authorized || conversation != entry.Ref.Conversation() {
		g.writeError(response, http.StatusForbidden, "message_not_authorized", "消息已不在当前 Runtime 授权目录内")
		return
	}
	transport, ok := g.config.Transport.Current().(im.ReactionTransport)
	if !ok {
		g.writeError(response, http.StatusServiceUnavailable, "im_reaction_unavailable", "腾讯 IM Reaction 当前不可用")
		return
	}
	if err := transport.SetReaction(
		request.Context(), entry.Ref, strings.TrimSpace(payload.Emoji), request.Method == http.MethodPost,
	); err != nil {
		g.writeError(response, http.StatusBadGateway, "im_reaction_failed", "腾讯 IM Reaction 操作失败，结果不得自动重放")
		return
	}
	g.writeJSON(response, http.StatusOK, map[string]any{"ok": true})
}

func (g *Gateway) serveResolveChannel(
	response http.ResponseWriter,
	request *http.Request,
) {
	var payload struct {
		Target string `json:"target"`
	}
	if err := common.DecodeJson(
		io.LimitReader(request.Body, maximumRequestBytes+1),
		&payload,
	); err != nil {
		g.writeError(response, http.StatusBadRequest, "invalid_request", "target 无效")
		return
	}
	canonical, routeID, _, ok := g.resolveAuthorizedTargetWithRefresh(
		request.Context(), payload.Target,
	)
	if !ok {
		g.writeError(response, http.StatusForbidden, "target_not_authorized", "target 未由当前目录授权")
		return
	}
	g.writeJSON(response, http.StatusOK, map[string]string{
		"channelId": routeID,
		"target":    canonical,
	})
}

func (g *Gateway) resolveAuthorizedTargetWithRefresh(
	ctx context.Context,
	target string,
) (string, string, im.Conversation, bool) {
	canonical, routeID, conversation, ok := g.resolveAuthorizedTarget(target)
	if ok {
		return canonical, routeID, conversation, true
	}
	if err := g.refreshDirectory(ctx, true); err != nil {
		return "", "", im.Conversation{}, false
	}
	return g.resolveAuthorizedTarget(target)
}

func (g *Gateway) resolveAuthorizedTarget(
	target string,
) (string, string, im.Conversation, bool) {
	target = strings.TrimSpace(target)
	g.mu.RLock()
	canonical, ok := g.targetAliases[strings.ToLower(target)]
	conversation := g.targets[canonical]
	g.mu.RUnlock()
	if ok {
		return canonical, g.routeIDForTarget(canonical), conversation, true
	}
	channelTarget, rootPrefix, threadTarget := splitThreadTarget(target)
	if !threadTarget {
		return "", "", im.Conversation{}, false
	}
	g.mu.RLock()
	canonicalChannel, ok := g.targetAliases[strings.ToLower(channelTarget)]
	conversation = g.targets[canonicalChannel]
	g.mu.RUnlock()
	if !ok {
		return "", "", im.Conversation{}, false
	}
	root, err := g.messageIndex.Resolve(rootPrefix, canonicalChannel)
	if err != nil || root.Ref.Conversation() != conversation {
		return "", "", im.Conversation{}, false
	}
	canonical = canonicalChannel + ":" + shortMessageID(root.Ref.MessageID())
	return canonical, g.routeIDForTarget(canonicalChannel), conversation, true
}

func (g *Gateway) targetForRouteID(routeID string) (string, bool) {
	routeID = strings.TrimSpace(routeID)
	g.mu.RLock()
	directory := g.directory
	g.mu.RUnlock()
	for _, channel := range directory.Channels {
		if channel.ID == routeID {
			canonical := "#" + channel.Name
			g.mu.RLock()
			_, ok := g.targets[canonical]
			g.mu.RUnlock()
			return canonical, ok
		}
	}
	for _, member := range directory.Members {
		if member.MemberID == routeID {
			canonical := "@" + member.Handle
			g.mu.RLock()
			_, ok := g.targets[canonical]
			g.mu.RUnlock()
			return canonical, ok
		}
	}
	return "", false
}

func (g *Gateway) serveAttachmentUpload(
	response http.ResponseWriter,
	request *http.Request,
) {
	request.Body = http.MaxBytesReader(
		response,
		request.Body,
		attachmentstore.MaxAttachmentBytes+maximumUploadOverhead,
	)
	if err := request.ParseMultipartForm(1 << 20); err != nil {
		g.writeError(response, http.StatusBadRequest, "invalid_attachment", "附件表单无效或超过 50 MiB")
		return
	}
	if request.MultipartForm != nil {
		defer request.MultipartForm.RemoveAll()
	}
	routeID := strings.TrimSpace(request.FormValue("channelId"))
	target := strings.TrimSpace(request.FormValue("target"))
	if target == "" {
		var ok bool
		target, ok = g.targetForRouteID(routeID)
		if !ok {
			g.writeError(response, http.StatusForbidden, "target_not_authorized", "附件 target 未由当前目录授权")
			return
		}
	} else {
		canonical, resolvedRouteID, _, ok := g.resolveAuthorizedTargetWithRefresh(
			request.Context(), target,
		)
		if !ok || resolvedRouteID != routeID {
			g.writeError(response, http.StatusForbidden, "target_not_authorized", "附件 target 与目录引用不匹配")
			return
		}
		target = canonical
	}
	file, header, err := request.FormFile("file")
	if err != nil || header == nil {
		g.writeError(response, http.StatusBadRequest, "invalid_attachment", "附件文件缺失")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, attachmentstore.MaxAttachmentBytes+1))
	if err != nil || len(data) == 0 {
		g.writeError(response, http.StatusBadRequest, "invalid_attachment", "附件读取失败")
		return
	}
	if len(data) > attachmentstore.MaxAttachmentBytes {
		g.writeError(response, http.StatusRequestEntityTooLarge, "attachment_too_large", "附件超过 50 MiB")
		return
	}
	mimeType := strings.TrimSpace(request.FormValue("mimeType"))
	if mimeType == "" {
		mimeType = strings.TrimSpace(header.Header.Get("Content-Type"))
	}
	if mimeType == "" {
		mimeType = mime.TypeByExtension(filepath.Ext(header.Filename))
	}
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	record, err := g.attachmentStore.Stage(
		routeID, target, header.Filename, mimeType, data,
	)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, attachmentstore.ErrAttachmentTooLarge) {
			status = http.StatusRequestEntityTooLarge
		}
		g.writeError(response, status, "invalid_attachment", "附件暂存失败")
		return
	}
	g.writeJSON(response, http.StatusCreated, map[string]any{
		"id": record.ID, "filename": record.Filename,
		"mimeType": record.MIMEType, "sizeBytes": record.SizeBytes,
		"thumbnailUrl": nil,
	})
}

func (g *Gateway) serveAttachmentDownload(
	response http.ResponseWriter,
	request *http.Request,
) {
	id := strings.TrimPrefix(request.URL.Path, agentapi.BasePath+"/attachments/")
	record, err := g.attachmentStore.Remote(id)
	if err != nil {
		g.writeError(response, http.StatusNotFound, "attachment_not_found", "附件引用不存在")
		return
	}
	authorizationTarget := record.Target
	if channelTarget, _, isThread := splitThreadTarget(record.Target); isThread {
		authorizationTarget = channelTarget
	}
	_, routeID, _, authorized := g.resolveAuthorizedTargetWithRefresh(
		request.Context(), authorizationTarget,
	)
	if !authorized || routeID != record.ChannelID {
		g.writeError(response, http.StatusForbidden, "target_not_authorized", "附件所属会话已不在当前目录授权范围内")
		return
	}
	data, contentType, err := g.attachmentFetcher(request.Context(), record.URL)
	if err != nil || len(data) > attachmentstore.MaxAttachmentBytes ||
		int64(len(data)) != record.SizeBytes {
		g.writeError(response, http.StatusBadGateway, "attachment_download_failed", "腾讯 IM 附件下载失败")
		return
	}
	if strings.TrimSpace(contentType) == "" {
		contentType = record.MIMEType
	}
	response.Header().Set("Content-Type", contentType)
	response.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(record.Filename))
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.Header().Set("Cache-Control", "private, no-store")
	response.WriteHeader(http.StatusOK)
	_, _ = response.Write(data)
}

func fetchTencentAttachment(
	ctx context.Context,
	rawURL string,
) ([]byte, string, error) {
	if err := validateTencentAttachmentURL(rawURL); err != nil {
		return nil, "", err
	}
	client := &http.Client{
		Timeout: 2 * time.Minute,
		Transport: &http.Transport{
			Proxy: nil, DialContext: secureAttachmentDialContext,
			TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12},
		},
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return errors.New("附件重定向过多")
			}
			return validateTencentAttachmentURL(request.URL.String())
		},
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, "", err
	}
	result, err := client.Do(httpRequest)
	if err != nil {
		return nil, "", err
	}
	defer result.Body.Close()
	if result.StatusCode < 200 || result.StatusCode >= 300 {
		return nil, "", errors.New("附件服务返回非成功状态")
	}
	data, err := io.ReadAll(io.LimitReader(result.Body, attachmentstore.MaxAttachmentBytes+1))
	if err != nil || len(data) > attachmentstore.MaxAttachmentBytes {
		return nil, "", attachmentstore.ErrAttachmentTooLarge
	}
	return data, result.Header.Get("Content-Type"), nil
}

func validateTencentAttachmentURL(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil ||
		parsed.Hostname() == "" || (parsed.Port() != "" && parsed.Port() != "443") {
		return errors.New("腾讯附件 URL 无效")
	}
	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	for _, suffix := range []string{
		".myqcloud.com", ".tencentcos.cn", ".cos.tencent-cloud.com", ".qcloud.com",
		".rich.my-imcloud.com",
	} {
		if strings.HasSuffix(host, suffix) && len(host) > len(suffix) {
			return nil
		}
	}
	return errors.New("腾讯附件域名未授权")
}

func secureAttachmentDialContext(
	ctx context.Context,
	network string,
	address string,
) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil || net.ParseIP(host) != nil {
		return nil, errors.New("附件地址无效")
	}
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	dialer := net.Dialer{Timeout: 10 * time.Second}
	for _, candidate := range addresses {
		ip := candidate.IP
		if ip == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() ||
			ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
			continue
		}
		connection, dialErr := dialer.DialContext(
			ctx, network, net.JoinHostPort(ip.String(), port),
		)
		if dialErr == nil {
			return connection, nil
		}
		err = dialErr
	}
	if err != nil {
		return nil, err
	}
	return nil, errors.New("附件域名未解析到公网地址")
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func channelType(conversation im.Conversation, target string) string {
	if _, _, ok := splitThreadTarget(target); ok {
		return "thread"
	}
	switch conversation.Kind() {
	case im.ConversationC2C:
		return "dm"
	default:
		return "channel"
	}
}

func (g *Gateway) serveSend(
	response http.ResponseWriter,
	request *http.Request,
) {
	var payload struct {
		Target        string   `json:"target"`
		Content       string   `json:"content"`
		AttachmentIDs []string `json:"attachmentIds"`
	}
	reader := io.LimitReader(request.Body, maximumRequestBytes+1)
	if err := common.DecodeJson(reader, &payload); err != nil ||
		strings.TrimSpace(payload.Target) == "" ||
		strings.TrimSpace(payload.Content) == "" {
		g.writeError(
			response,
			http.StatusBadRequest,
			"invalid_request",
			"消息 target 或 content 无效",
		)
		return
	}
	if len(payload.AttachmentIDs) > 0 && !g.hasCapability("attachments") {
		g.writeError(
			response,
			http.StatusForbidden,
			"capability_denied",
			"当前 Runtime Session 未授权附件能力",
		)
		return
	}
	canonicalTarget, conversation, exists := g.lookupDirectoryTarget(
		request.Context(), payload.Target,
	)
	if !exists {
		if channelTarget, rootPrefix, threadTarget := splitThreadTarget(payload.Target); threadTarget {
			g.serveThreadSend(
				response, request, channelTarget, rootPrefix, payload.Content,
				payload.AttachmentIDs,
			)
			return
		}
		g.writeError(
			response,
			http.StatusForbidden,
			"target_not_authorized",
			"target 未由当前 Host 签发",
		)
		return
	}
	transport := g.config.Transport.Current()
	if transport == nil {
		g.writeError(
			response,
			http.StatusServiceUnavailable,
			"im_unavailable",
			"IM 会话当前不可用",
		)
		return
	}
	attachments, err := g.sendPendingAttachments(
		request.Context(), canonicalTarget, conversation,
		payload.AttachmentIDs, "",
	)
	if err != nil {
		g.writeAttachmentSendError(response, err)
		return
	}
	receipt, err := transport.SendText(
		request.Context(),
		im.SendTextRequest{
			Conversation: conversation,
			Text:         payload.Content,
		},
	)
	if err != nil {
		g.writeError(
			response,
			http.StatusBadGateway,
			"im_send_failed",
			"IM 发送失败，结果不得自动重放",
		)
		return
	}
	g.writeJSON(response, http.StatusOK, map[string]any{
		"ok":          true,
		"state":       "sent",
		"messageId":   receipt.MessageID,
		"timestampMs": receipt.TimestampMS,
		"attachments": attachments,
	})
}

func (g *Gateway) lookupDirectoryTarget(
	ctx context.Context,
	target string,
) (string, im.Conversation, bool) {
	g.mu.RLock()
	canonical, ok := g.targetAliases[strings.ToLower(strings.TrimSpace(target))]
	conversation := g.targets[canonical]
	g.mu.RUnlock()
	if ok {
		return canonical, conversation, true
	}
	if err := g.refreshDirectory(ctx, true); err != nil {
		return "", im.Conversation{}, false
	}
	g.mu.RLock()
	canonical, ok = g.targetAliases[strings.ToLower(strings.TrimSpace(target))]
	conversation = g.targets[canonical]
	g.mu.RUnlock()
	return canonical, conversation, ok
}

func (g *Gateway) sendPendingAttachments(
	ctx context.Context,
	target string,
	conversation im.Conversation,
	attachmentIDs []string,
	cloudCustomData string,
) ([]attachmentView, error) {
	if len(attachmentIDs) == 0 {
		return []attachmentView{}, nil
	}
	if len(attachmentIDs) > 10 {
		return nil, attachmentstore.ErrInvalidAttachment
	}
	transport, ok := g.config.Transport.Current().(im.AttachmentTransport)
	if !ok {
		return nil, im.ErrInvalidAttachment
	}
	seen := make(map[string]struct{}, len(attachmentIDs))
	views := make([]attachmentView, 0, len(attachmentIDs))
	canonicalTarget := strings.TrimSpace(target)
	for _, id := range attachmentIDs {
		id = strings.TrimSpace(id)
		if id == "" {
			return nil, attachmentstore.ErrInvalidAttachment
		}
		if _, duplicate := seen[id]; duplicate {
			return nil, attachmentstore.ErrInvalidAttachment
		}
		seen[id] = struct{}{}
		record, data, err := g.attachmentStore.Pending(id)
		if errors.Is(err, attachmentstore.ErrNotPending) {
			remote, remoteErr := g.attachmentStore.Sent(id)
			if remoteErr != nil || remote.Target != canonicalTarget {
				return nil, attachmentstore.ErrInvalidAttachment
			}
			views = append(views, attachmentView{
				ID: remote.ID, Filename: remote.Filename,
				MIMEType: remote.MIMEType, SizeBytes: remote.SizeBytes,
			})
			continue
		}
		if err != nil || record.Target != canonicalTarget {
			return nil, attachmentstore.ErrInvalidAttachment
		}
		receipt, err := transport.SendAttachment(ctx, im.SendAttachmentRequest{
			Conversation: conversation, Filename: record.Filename,
			MIMEType: record.MIMEType, Data: data,
			CloudCustomData: cloudCustomData,
		})
		if err != nil {
			return nil, err
		}
		completed, err := g.attachmentStore.Complete(
			record.ID, receipt.MessageID, receipt.Attachment,
		)
		if err != nil {
			return nil, err
		}
		if receipt.Sequence > 0 {
			reference, refErr := im.NewMessageRef(
				conversation, receipt.MessageID, receipt.Sequence, receipt.TimestampMS,
			)
			if refErr != nil {
				return nil, refErr
			}
			baseTarget := canonicalTarget
			if channelTarget, _, isThread := splitThreadTarget(canonicalTarget); isThread {
				baseTarget = channelTarget
			}
			if err := g.messageIndex.Add(baseTarget, reference); err != nil {
				return nil, err
			}
		}
		views = append(views, attachmentView{
			ID: completed.ID, Filename: completed.Filename,
			MIMEType: completed.MIMEType, SizeBytes: completed.SizeBytes,
		})
	}
	return views, nil
}

func (g *Gateway) writeAttachmentSendError(
	response http.ResponseWriter,
	err error,
) {
	if errors.Is(err, attachmentstore.ErrInvalidAttachment) ||
		errors.Is(err, attachmentstore.ErrNotFound) ||
		errors.Is(err, im.ErrInvalidAttachment) {
		g.writeError(response, http.StatusBadRequest, "invalid_attachment", "附件不存在、已失效或与 target 不匹配")
		return
	}
	if code := safeUpstreamDiagnosticCode(err); code != "" {
		response.Header().Set("X-Vela-Upstream-Code", code)
	}
	if detail := safeUpstreamDiagnosticDetail(err); detail != "" {
		response.Header().Set("X-Vela-Upstream-Detail", detail)
	}
	g.writeError(response, http.StatusBadGateway, "im_attachment_send_failed", "腾讯 IM 附件发送失败，结果不得自动重放")
}

func safeUpstreamDiagnosticCode(err error) string {
	var coded interface{ SafeCode() string }
	if !errors.As(err, &coded) {
		return ""
	}
	code := strings.TrimSpace(coded.SafeCode())
	if code == "" || len(code) > 48 {
		return ""
	}
	for _, character := range code {
		if character != '_' && (character < 'a' || character > 'z') &&
			(character < '0' || character > '9') {
			return ""
		}
	}
	return code
}

func safeUpstreamDiagnosticDetail(err error) string {
	var detailed interface{ SafeDetail() string }
	if !errors.As(err, &detailed) {
		return ""
	}
	detail := strings.TrimSpace(detailed.SafeDetail())
	if detail == "" || len(detail) > 160 {
		return ""
	}
	for _, character := range detail {
		if character < 0x20 || character > 0x7e {
			return ""
		}
	}
	return detail
}

type threadCloudMetadata struct {
	ServerID      string
	ThreadID      string
	ChannelID     string
	RootMessageID string
}

type threadMessageEnvelope struct {
	Schema             string                  `json:"schema"`
	ServerID           string                  `json:"serverId,omitempty"`
	ConversationID     string                  `json:"conversationId,omitempty"`
	ClientRequestID    string                  `json:"clientRequestId,omitempty"`
	ParentMessageID    string                  `json:"parentMessageId,omitempty"`
	RootMessageID      string                  `json:"rootMessageId,omitempty"`
	MentionedMemberIDs []string                `json:"mentionedMemberIds"`
	AttachmentIDs      []string                `json:"attachmentIds"`
	Thread             *threadMessageExtension `json:"thread,omitempty"`
}

type threadMessageExtension struct {
	Role           string               `json:"role"`
	ThreadID       string               `json:"threadId"`
	RootMessageRef threadMessageWireRef `json:"rootMessageRef"`
}

type threadMessageWireRef struct {
	Kind         string `json:"kind"`
	MessageID    string `json:"messageId"`
	GroupID      string `json:"groupId,omitempty"`
	TopicID      string `json:"topicId,omitempty"`
	SenderUserID string `json:"senderUserId,omitempty"`
	Sequence     int64  `json:"sequence"`
	Timestamp    int64  `json:"timestamp"`
}

type legacyThreadCloudMetadata struct {
	Type          string `json:"type"`
	ThreadID      string `json:"threadId"`
	ChannelID     string `json:"channelId"`
	RootMessageID string `json:"rootMessageId"`
}

func splitThreadTarget(target string) (string, string, bool) {
	target = strings.TrimSpace(target)
	if !strings.HasPrefix(target, "#") {
		return "", "", false
	}
	separator := strings.LastIndex(target, ":")
	if separator <= 1 || separator == len(target)-1 {
		return "", "", false
	}
	channel := strings.TrimSpace(target[:separator])
	messagePrefix := strings.TrimSpace(target[separator+1:])
	if len(messagePrefix) < 8 {
		return "", "", false
	}
	return channel, messagePrefix, true
}

func (g *Gateway) serveThreadSend(
	response http.ResponseWriter,
	request *http.Request,
	channelTarget string,
	rootPrefix string,
	content string,
	attachmentIDs []string,
) {
	if !g.hasCapability("threads") {
		g.writeError(response, http.StatusForbidden, "capability_denied", "当前 Runtime 未获得 Thread 能力")
		return
	}
	client, token, ok := g.runtimeTaskSession()
	if !ok {
		g.writeError(response, http.StatusServiceUnavailable, "platform_unavailable", "Runtime 平台会话不可用")
		return
	}
	g.mu.RLock()
	canonical, authorized := g.targetAliases[strings.ToLower(channelTarget)]
	conversation := g.targets[canonical]
	directory := g.directory
	g.mu.RUnlock()
	if !authorized || !strings.HasPrefix(canonical, "#") {
		g.writeError(response, http.StatusForbidden, "target_not_authorized", "Thread 所属 Channel 未授权")
		return
	}
	root, err := g.messageIndex.Resolve(rootPrefix, canonical)
	if err != nil || root.Ref.Conversation() != conversation {
		g.writeError(response, http.StatusNotFound, "message_not_indexed", "Thread 根消息不存在或不唯一")
		return
	}
	var channelID string
	for _, channel := range directory.Channels {
		if strings.EqualFold("#"+channel.Name, canonical) {
			channelID = channel.ID
			break
		}
	}
	if channelID == "" {
		g.writeError(response, http.StatusNotFound, "channel_not_found", "Thread 所属 Channel 已变化")
		return
	}
	thread, err := client.ResolveRuntimeThread(
		request.Context(), token, g.config.ServerID, channelID,
		platformThreadMessageRef(root.Ref, ""),
		stableIdempotencyKey("thread-resolve-v1", channelID, root.Ref.MessageID()),
	)
	if err != nil {
		g.writePlatformThreadError(response, err, "Runtime Thread 建立失败")
		return
	}
	clientRequestID, err := uuid.NewV7()
	if err != nil {
		g.writeError(response, http.StatusInternalServerError, "thread_metadata_failed", "Thread 请求标识生成失败")
		return
	}
	metadata, err := common.Marshal(threadMessageEnvelope{
		Schema: "raft.message/v1", ServerID: g.config.ServerID,
		ConversationID: channelID, ClientRequestID: clientRequestID.String(),
		ParentMessageID: root.Ref.MessageID(), RootMessageID: root.Ref.MessageID(),
		MentionedMemberIDs: []string{}, AttachmentIDs: []string{},
		Thread: &threadMessageExtension{
			Role: "reply", ThreadID: thread.ID,
			RootMessageRef: threadMessageWireRef{
				Kind: string(im.ConversationGroup), MessageID: root.Ref.MessageID(),
				GroupID: conversation.GroupID(), TopicID: conversation.TopicID(),
				Sequence: root.Ref.Sequence(), Timestamp: root.Ref.TimestampMS() / 1000,
			},
		},
	})
	if err != nil {
		g.writeError(response, http.StatusInternalServerError, "thread_metadata_failed", "Thread 元数据生成失败")
		return
	}
	transport := g.config.Transport.Current()
	if transport == nil {
		g.writeError(response, http.StatusServiceUnavailable, "im_unavailable", "IM 会话当前不可用")
		return
	}
	displayTarget := canonical + ":" + shortMessageID(root.Ref.MessageID())
	attachments, err := g.sendPendingAttachments(
		request.Context(), displayTarget, conversation,
		attachmentIDs, string(metadata),
	)
	if err != nil {
		g.writeAttachmentSendError(response, err)
		return
	}
	receipt, err := transport.SendText(request.Context(), im.SendTextRequest{
		Conversation: conversation, Text: content, CloudCustomData: string(metadata),
	})
	if err != nil {
		g.writeError(response, http.StatusBadGateway, "im_send_failed", "IM Thread 回复发送失败，结果不得自动重放")
		return
	}
	idempotencyKey := stableIdempotencyKey("thread-reply-v1", thread.ID, receipt.MessageID)
	pending := pendingThreadRegistration{
		ID:             idempotencyKey,
		ChannelID:      channelID,
		ThreadID:       thread.ID,
		MessageKind:    string(im.ConversationGroup),
		MessageID:      receipt.MessageID,
		GroupID:        conversation.GroupID(),
		TopicID:        conversation.TopicID(),
		SenderUserID:   directory.Self.IMUserID,
		Sequence:       receipt.Sequence,
		IdempotencyKey: idempotencyKey,
	}
	if receipt.TimestampMS > 0 {
		pending.Timestamp = receipt.TimestampMS / 1000
	}
	persistErr := g.enqueuePendingThreadRegistration(pending)
	reference, refErr := im.NewMessageRef(
		conversation, receipt.MessageID, receipt.Sequence, receipt.TimestampMS,
	)
	if refErr != nil || receipt.Sequence < 1 {
		result := map[string]any{
			"ok": true, "state": "sent", "messageId": receipt.MessageID,
			"timestampMs": receipt.TimestampMS, "threadId": thread.ID,
			"threadRegistration": "pending",
			"attachments":        attachments,
		}
		if persistErr != nil {
			result["threadRegistrationDurability"] = "unavailable"
		}
		g.writeJSON(response, http.StatusOK, result)
		return
	}
	indexErr := g.messageIndex.Add(canonical, reference)
	_, err = client.RegisterRuntimeThreadReply(
		request.Context(), token, channelID, thread.ID,
		platformThreadMessageRef(reference, directory.Self.IMUserID),
		idempotencyKey,
	)
	if err != nil {
		result := map[string]any{
			"ok": true, "state": "sent", "messageId": receipt.MessageID,
			"timestampMs": receipt.TimestampMS, "threadId": thread.ID,
			"threadRegistration": "pending",
			"attachments":        attachments,
		}
		if persistErr != nil {
			result["threadRegistrationDurability"] = "unavailable"
		}
		if indexErr != nil {
			result["messageIndex"] = "pending"
		}
		g.writeJSON(response, http.StatusOK, result)
		return
	}
	var cleanupErr error
	if persistErr == nil {
		cleanupErr = g.completePendingThreadRegistration(pending.ID)
	}
	result := map[string]any{
		"ok": true, "state": "sent", "messageId": receipt.MessageID,
		"timestampMs": receipt.TimestampMS, "threadId": thread.ID,
		"threadRegistration": "registered",
		"attachments":        attachments,
	}
	if indexErr != nil {
		result["messageIndex"] = "pending"
	}
	if cleanupErr != nil {
		result["threadRegistrationCleanup"] = "pending"
	}
	g.writeJSON(response, http.StatusOK, result)
}

func (g *Gateway) hasCapability(capability string) bool {
	g.mu.RLock()
	defer g.mu.RUnlock()
	_, allowed := g.capabilities[capability]
	return allowed
}

func platformThreadMessageRef(
	reference im.MessageRef,
	senderUserID string,
) platform.ThreadMessageRef {
	conversation := reference.Conversation()
	return platform.ThreadMessageRef{
		Kind: string(im.ConversationGroup), MessageID: reference.MessageID(),
		GroupID: conversation.GroupID(), TopicID: conversation.TopicID(),
		SenderUserID: senderUserID, Sequence: reference.Sequence(),
		Timestamp: reference.TimestampMS() / 1000,
	}
}

func stableIdempotencyKey(prefix string, values ...string) string {
	hash := sha256.New()
	_, _ = hash.Write([]byte(prefix))
	for _, value := range values {
		_, _ = hash.Write([]byte{0})
		_, _ = hash.Write([]byte(value))
	}
	return prefix + "-" + fmt.Sprintf("%x", hash.Sum(nil))
}

func (g *Gateway) writePlatformThreadError(
	response http.ResponseWriter,
	err error,
	message string,
) {
	if errors.Is(err, platform.ErrCredentialRejected) {
		g.writeError(response, http.StatusUnauthorized, "runtime_session_rejected", "Runtime 平台会话已失效")
		return
	}
	g.writeError(response, http.StatusBadGateway, "platform_request_failed", message)
}

func (g *Gateway) runtimeTaskSession() (*platform.Client, platform.AccessToken, bool) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	if g.platformClient == nil || strings.TrimSpace(g.accessToken.Reveal()) == "" {
		return nil, platform.AccessToken{}, false
	}
	return g.platformClient, g.accessToken, true
}

func (g *Gateway) serveTasks(response http.ResponseWriter, request *http.Request) {
	client, token, ok := g.runtimeTaskSession()
	if !ok {
		g.writeError(response, http.StatusServiceUnavailable, "platform_unavailable", "Runtime 平台会话不可用")
		return
	}
	values, err := client.ListRuntimeTasks(request.Context(), token)
	if err != nil {
		g.writePlatformTaskError(response, err)
		return
	}
	statusFilter := strings.TrimSpace(request.URL.Query().Get("status"))
	rows := make([]map[string]any, 0, len(values))
	for _, value := range values {
		if statusFilter != "" && statusFilter != "all" && statusFilter != string(value.Status) {
			continue
		}
		owner := value.OwnerMemberID
		rows = append(rows, map[string]any{
			"taskNumber":    value.Number,
			"status":        value.Status,
			"title":         value.Title,
			"claimedById":   &owner,
			"claimedByName": nil,
			"createdByName": nil,
			"messageId":     nil,
		})
	}
	g.writeJSON(response, http.StatusOK, map[string]any{"tasks": rows})
}

func (g *Gateway) serveTaskClaim(response http.ResponseWriter, request *http.Request) {
	var payload struct {
		TaskNumbers []int    `json:"task_numbers"`
		MessageIDs  []string `json:"message_ids"`
	}
	if err := common.DecodeJson(io.LimitReader(request.Body, maximumRequestBytes+1), &payload); err != nil ||
		len(payload.TaskNumbers) == 0 && len(payload.MessageIDs) == 0 {
		g.writeError(response, http.StatusBadRequest, "invalid_request", "Task claim 参数无效")
		return
	}
	client, token, ok := g.runtimeTaskSession()
	if !ok {
		g.writeError(response, http.StatusServiceUnavailable, "platform_unavailable", "Runtime 平台会话不可用")
		return
	}
	values, err := client.ListRuntimeTasks(request.Context(), token)
	if err != nil {
		g.writePlatformTaskError(response, err)
		return
	}
	byNumber := make(map[int64]platform.Task, len(values))
	for _, value := range values {
		byNumber[value.Number] = value
	}
	results := make([]map[string]any, 0, len(payload.TaskNumbers)+len(payload.MessageIDs))
	for _, number := range payload.TaskNumbers {
		value, exists := byNumber[int64(number)]
		result := map[string]any{
			"taskNumber": number, "messageId": "", "success": false,
		}
		if !exists {
			result["reason"] = "task not assigned to this agent"
			results = append(results, result)
			continue
		}
		_, claimErr := client.ClaimRuntimeTask(
			request.Context(), token, value.ID,
			fmt.Sprintf("task-claim-v1-%s-%d", value.ID, value.AssignmentRevision),
		)
		if claimErr != nil {
			result["reason"] = "claim rejected"
		} else {
			result["success"] = true
			result["reason"] = ""
		}
		results = append(results, result)
	}
	for _, messageID := range payload.MessageIDs {
		results = append(results, map[string]any{
			"taskNumber": nil, "messageId": messageID, "success": false,
			"reason": "message-id task lookup is not supported by platform v1",
		})
	}
	g.writeJSON(response, http.StatusOK, map[string]any{"results": results})
}

func (g *Gateway) serveTaskUpdate(response http.ResponseWriter, request *http.Request) {
	var payload struct {
		TaskNumber int    `json:"task_number"`
		Status     string `json:"status"`
	}
	if err := common.DecodeJson(io.LimitReader(request.Body, maximumRequestBytes+1), &payload); err != nil ||
		payload.TaskNumber < 1 {
		g.writeError(response, http.StatusBadRequest, "invalid_request", "Task update 参数无效")
		return
	}
	status := platform.TaskStatus(payload.Status)
	if status != platform.TaskInProgress && status != platform.TaskInReview && status != platform.TaskDone {
		g.writeError(response, http.StatusBadRequest, "invalid_request", "Agent 不能写入该 Task 状态")
		return
	}
	client, token, ok := g.runtimeTaskSession()
	if !ok {
		g.writeError(response, http.StatusServiceUnavailable, "platform_unavailable", "Runtime 平台会话不可用")
		return
	}
	values, err := client.ListRuntimeTasks(request.Context(), token)
	if err != nil {
		g.writePlatformTaskError(response, err)
		return
	}
	var selected *platform.Task
	for index := range values {
		if values[index].Number == int64(payload.TaskNumber) {
			selected = &values[index]
			break
		}
	}
	if selected == nil {
		g.writeError(response, http.StatusNotFound, "task_not_found", "Task 未指派给当前 Agent")
		return
	}
	_, err = client.UpdateRuntimeTaskStatus(
		request.Context(), token, selected.ID, selected.Revision, status,
		fmt.Sprintf("task-status-v1-%s-%d-%s", selected.ID, selected.Revision, status),
	)
	if err != nil {
		g.writePlatformTaskError(response, err)
		return
	}
	g.writeJSON(response, http.StatusOK, map[string]any{"ok": true})
}

func (g *Gateway) writePlatformTaskError(response http.ResponseWriter, err error) {
	if errors.Is(err, platform.ErrCredentialRejected) {
		g.writeError(response, http.StatusUnauthorized, "runtime_session_rejected", "Runtime 平台会话已失效")
		return
	}
	g.writeError(response, http.StatusBadGateway, "platform_request_failed", "Runtime Task 请求失败")
}

func (g *Gateway) writePlatformReminderError(response http.ResponseWriter, err error) {
	if errors.Is(err, platform.ErrCredentialRejected) {
		g.writeError(response, http.StatusUnauthorized, "runtime_session_rejected", "Runtime 平台会话已失效")
		return
	}
	g.writeError(response, http.StatusBadGateway, "platform_request_failed", "Runtime Reminder 请求失败")
}

type reminderCreatePayload struct {
	Title        string  `json:"title"`
	DelaySeconds float64 `json:"delaySeconds"`
	FireAt       string  `json:"fireAt"`
	Repeat       string  `json:"repeat"`
	Timezone     string  `json:"tz"`
	Channel      string  `json:"channel"`
	MessageID    string  `json:"msgId"`
}

func (g *Gateway) serveReminders(response http.ResponseWriter, request *http.Request) {
	client, token, ok := g.runtimeTaskSession()
	if !ok {
		g.writeError(response, http.StatusServiceUnavailable, "platform_unavailable", "Runtime 平台会话不可用")
		return
	}
	values, err := client.ListRuntimeReminders(
		request.Context(), token, g.config.ServerID, g.config.AgentID,
	)
	if err != nil {
		g.writePlatformReminderError(response, err)
		return
	}
	filters, valid := reminderStatusFilter(request.URL.Query())
	if !valid {
		g.writeError(response, http.StatusBadRequest, "invalid_request", "Reminder status 过滤无效")
		return
	}
	rows := make([]map[string]any, 0, len(values))
	for _, value := range values {
		status := legacyReminderStatus(value.Status)
		if len(filters) > 0 {
			if _, include := filters[status]; !include {
				continue
			}
		}
		rows = append(rows, g.legacyReminder(value))
	}
	g.writeJSON(response, http.StatusOK, map[string]any{"reminders": rows})
}

func (g *Gateway) serveReminderCreate(
	response http.ResponseWriter,
	request *http.Request,
) {
	var payload reminderCreatePayload
	if err := common.DecodeJson(
		io.LimitReader(request.Body, maximumRequestBytes+1), &payload,
	); err != nil || strings.TrimSpace(payload.Title) == "" ||
		strings.TrimSpace(payload.MessageID) == "" {
		g.writeError(response, http.StatusBadRequest, "invalid_request", "Reminder 创建参数无效")
		return
	}
	client, token, ok := g.runtimeTaskSession()
	if !ok {
		g.writeError(response, http.StatusServiceUnavailable, "platform_unavailable", "Runtime 平台会话不可用")
		return
	}
	kind, schedule, timezone, err := reminderSchedule(g.now().UTC(), payload)
	if err != nil {
		g.writeError(response, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	anchor, err := g.resolveReminderAnchor(
		request.Context(), client, token, payload.Channel, payload.MessageID,
	)
	if err != nil {
		g.writeError(response, http.StatusBadRequest, "message_not_indexed", "Reminder 消息锚点不存在、不唯一或不可访问")
		return
	}
	idempotencyKey, err := newReminderIdempotencyKey("reminder-create-v1")
	if err != nil {
		g.writeError(response, http.StatusInternalServerError, "id_generation_failed", "Reminder 请求标识生成失败")
		return
	}
	value, err := client.CreateRuntimeReminder(
		request.Context(), token, g.config.ServerID, g.config.AgentID,
		platform.ReminderDraft{
			ScheduleKind: kind, Schedule: schedule, Timezone: timezone,
			Text: strings.TrimSpace(payload.Title), Anchor: anchor,
		},
		idempotencyKey,
	)
	if err != nil {
		g.writePlatformReminderError(response, err)
		return
	}
	g.writeJSON(response, http.StatusCreated, map[string]any{
		"reminder": g.legacyReminder(value),
	})
}

func (g *Gateway) serveReminderMutation(
	response http.ResponseWriter,
	request *http.Request,
) {
	reminderID, action, ok := parseReminderPath(request.Method, request.URL.Path)
	if !ok || !validUUIDv7String(reminderID) {
		g.writeError(response, http.StatusBadRequest, "invalid_request", "Reminder ID 无效")
		return
	}
	client, token, sessionReady := g.runtimeTaskSession()
	if !sessionReady {
		g.writeError(response, http.StatusServiceUnavailable, "platform_unavailable", "Runtime 平台会话不可用")
		return
	}
	values, err := client.ListRuntimeReminders(
		request.Context(), token, g.config.ServerID, g.config.AgentID,
	)
	if err != nil {
		g.writePlatformReminderError(response, err)
		return
	}
	var current *platform.Reminder
	for index := range values {
		if values[index].ID == reminderID {
			current = &values[index]
			break
		}
	}
	if current == nil {
		g.writeError(response, http.StatusNotFound, "reminder_not_found", "Reminder 不存在或不属于当前 Agent")
		return
	}
	if action == "log" {
		g.serveReminderLog(response, request, client, token, *current)
		return
	}
	idempotencyKey, err := newReminderIdempotencyKey("reminder-" + action + "-v1")
	if err != nil {
		g.writeError(response, http.StatusInternalServerError, "id_generation_failed", "Reminder 请求标识生成失败")
		return
	}
	var value platform.Reminder
	switch action {
	case "cancel":
		err = client.CancelRuntimeReminder(
			request.Context(), token, current.ID, current.Revision, idempotencyKey,
		)
		value = *current
		if err == nil {
			value.Status = platform.ReminderCanceled
			value.NextFireAt = nil
			value.Revision++
			value.UpdatedAt = g.now().UTC()
		}
	case "snooze":
		var payload struct {
			DelaySeconds float64 `json:"delaySeconds"`
		}
		if decodeErr := common.DecodeJson(
			io.LimitReader(request.Body, maximumRequestBytes+1), &payload,
		); decodeErr != nil || payload.DelaySeconds < 1 ||
			payload.DelaySeconds > 365*24*60*60 || payload.DelaySeconds != float64(int64(payload.DelaySeconds)) {
			g.writeError(response, http.StatusBadRequest, "invalid_request", "Reminder snooze 时长无效")
			return
		}
		value, err = client.SnoozeRuntimeReminder(
			request.Context(), token, g.config.ServerID, g.config.AgentID,
			current.ID, current.Revision,
			time.Duration(int64(payload.DelaySeconds))*time.Second, idempotencyKey,
		)
	case "update":
		value, err = g.updateReminder(
			request, client, token, *current, idempotencyKey,
		)
	default:
		g.writeError(response, http.StatusNotFound, "route_not_exposed", "Vela 未开放该 Reminder 操作")
		return
	}
	if err != nil {
		if errors.Is(err, ErrInvalidMessage) {
			g.writeError(response, http.StatusBadRequest, "invalid_request", "Reminder 更新参数无效")
		} else {
			g.writePlatformReminderError(response, err)
		}
		return
	}
	g.writeJSON(response, http.StatusOK, map[string]any{
		"reminder": g.legacyReminder(value),
	})
}

func (g *Gateway) updateReminder(
	request *http.Request,
	client *platform.Client,
	token platform.AccessToken,
	current platform.Reminder,
	idempotencyKey string,
) (platform.Reminder, error) {
	var payload struct {
		Title        *string  `json:"title"`
		FireAt       *string  `json:"fireAt"`
		DelaySeconds *float64 `json:"delaySeconds"`
		Repeat       *string  `json:"repeat"`
		Timezone     *string  `json:"tz"`
	}
	if err := common.DecodeJson(
		io.LimitReader(request.Body, maximumRequestBytes+1), &payload,
	); err != nil {
		return platform.Reminder{}, ErrInvalidMessage
	}
	patch := platform.ReminderPatch{}
	mutations := 0
	if payload.Title != nil {
		text := strings.TrimSpace(*payload.Title)
		if text == "" {
			return platform.Reminder{}, ErrInvalidMessage
		}
		patch.Text = &text
		mutations++
	}
	if payload.FireAt != nil || payload.DelaySeconds != nil {
		if current.ScheduleKind != platform.ReminderOnce ||
			payload.FireAt != nil && payload.DelaySeconds != nil {
			return platform.Reminder{}, ErrInvalidMessage
		}
		fireAt, err := resolveReminderFireAt(
			g.now().UTC(), optionalStringValue(payload.FireAt), optionalFloat(payload.DelaySeconds),
		)
		if err != nil {
			return platform.Reminder{}, ErrInvalidMessage
		}
		schedule := fireAt.Format(time.RFC3339Nano)
		patch.Schedule = &schedule
		mutations++
	}
	if payload.Repeat != nil {
		if current.ScheduleKind != platform.ReminderCron {
			return platform.Reminder{}, ErrInvalidMessage
		}
		zone := current.Timezone
		if payload.Timezone != nil {
			zone = strings.TrimSpace(*payload.Timezone)
		}
		base := g.now().UTC()
		if current.NextFireAt != nil {
			base = *current.NextFireAt
		}
		schedule, err := reminderCron(strings.TrimSpace(*payload.Repeat), zone, base)
		if err != nil {
			return platform.Reminder{}, ErrInvalidMessage
		}
		patch.Schedule = &schedule
		patch.Timezone = &zone
		mutations++
	}
	if mutations != 1 {
		return platform.Reminder{}, ErrInvalidMessage
	}
	return client.UpdateRuntimeReminder(
		request.Context(), token, g.config.ServerID, g.config.AgentID,
		current.ID, current.Revision, patch, idempotencyKey,
	)
}

func (g *Gateway) serveReminderLog(
	response http.ResponseWriter,
	request *http.Request,
	client *platform.Client,
	token platform.AccessToken,
	current platform.Reminder,
) {
	values, err := client.ListRuntimeReminderLog(
		request.Context(), token, g.config.ServerID, g.config.AgentID,
		current.ID, "", 100,
	)
	if err != nil {
		g.writePlatformReminderError(response, err)
		return
	}
	events := make([]map[string]any, 0, len(values))
	for _, value := range values {
		events = append(events, map[string]any{
			"eventId": value.ID, "reminderId": value.ReminderID,
			"eventType": value.State, "actorType": "system", "actorId": nil,
			"occurredAt": value.ScheduledFireAt.UTC().Format(time.RFC3339Nano),
			"nextFireAt": nil, "metadata": nil,
		})
	}
	g.writeJSON(response, http.StatusOK, map[string]any{"events": events})
}

func (g *Gateway) resolveReminderAnchor(
	ctx context.Context,
	client *platform.Client,
	token platform.AccessToken,
	target string,
	messageID string,
) (*platform.ReminderAnchor, error) {
	target = strings.TrimSpace(target)
	messageID = strings.TrimSpace(messageID)
	if target == "" {
		entry, err := g.messageIndex.Resolve(messageID, "")
		if err != nil || !strings.HasPrefix(entry.Target, "#") {
			return nil, ErrInvalidMessage
		}
		channelID := g.routeIDForTarget(entry.Target)
		if !validUUIDv7String(channelID) {
			return nil, ErrInvalidMessage
		}
		return &platform.ReminderAnchor{
			Kind: platform.ReminderAnchorMessage, ChannelID: channelID,
			MessageRef: platformThreadMessageRef(entry.Ref, ""),
		}, nil
	}
	channelTarget, rootPrefix, isThread := splitThreadTarget(target)
	if isThread {
		g.mu.RLock()
		canonical, authorized := g.targetAliases[strings.ToLower(channelTarget)]
		conversation := g.targets[canonical]
		g.mu.RUnlock()
		if !authorized || !strings.HasPrefix(canonical, "#") {
			return nil, ErrInvalidMessage
		}
		root, err := g.messageIndex.Resolve(rootPrefix, canonical)
		if err != nil || root.Ref.Conversation() != conversation ||
			!strings.HasPrefix(root.Ref.MessageID(), messageID) {
			return nil, ErrInvalidMessage
		}
		channelID := g.routeIDForTarget(canonical)
		thread, err := client.ResolveRuntimeThread(
			ctx, token, g.config.ServerID, channelID,
			platformThreadMessageRef(root.Ref, ""),
			stableIdempotencyKey("thread-resolve-v1", channelID, root.Ref.MessageID()),
		)
		if err != nil {
			return nil, err
		}
		return &platform.ReminderAnchor{
			Kind: platform.ReminderAnchorThread, ChannelID: channelID,
			ThreadID: thread.ID, MessageRef: platformThreadMessageRef(root.Ref, ""),
		}, nil
	}
	g.mu.RLock()
	canonical, authorized := g.targetAliases[strings.ToLower(target)]
	conversation := g.targets[canonical]
	g.mu.RUnlock()
	if !authorized || !strings.HasPrefix(canonical, "#") {
		return nil, ErrInvalidMessage
	}
	entry, err := g.messageIndex.Resolve(messageID, canonical)
	if err != nil || entry.Ref.Conversation() != conversation {
		return nil, ErrInvalidMessage
	}
	channelID := g.routeIDForTarget(canonical)
	if !validUUIDv7String(channelID) {
		return nil, ErrInvalidMessage
	}
	return &platform.ReminderAnchor{
		Kind: platform.ReminderAnchorMessage, ChannelID: channelID,
		MessageRef: platformThreadMessageRef(entry.Ref, ""),
	}, nil
}

func reminderSchedule(
	now time.Time,
	payload reminderCreatePayload,
) (platform.ReminderScheduleKind, string, string, error) {
	timezone := strings.TrimSpace(payload.Timezone)
	if timezone == "" || timezone == "Local" {
		timezone = "UTC"
	}
	if _, err := time.LoadLocation(timezone); err != nil {
		return "", "", "", errors.New("Reminder 时区无效")
	}
	fireAt, err := resolveReminderFireAt(now, strings.TrimSpace(payload.FireAt), payload.DelaySeconds)
	if err != nil {
		return "", "", "", err
	}
	if strings.TrimSpace(payload.Repeat) == "" {
		return platform.ReminderOnce, fireAt.Format(time.RFC3339Nano), timezone, nil
	}
	cron, err := reminderCron(strings.TrimSpace(payload.Repeat), timezone, fireAt)
	if err != nil {
		return "", "", "", err
	}
	return platform.ReminderCron, cron, timezone, nil
}

func resolveReminderFireAt(
	now time.Time,
	fireAt string,
	delaySeconds float64,
) (time.Time, error) {
	if (strings.TrimSpace(fireAt) == "") == (delaySeconds == 0) ||
		delaySeconds < 0 || delaySeconds > 365*24*60*60 {
		return time.Time{}, errors.New("Reminder 时间参数无效")
	}
	if fireAt != "" {
		value, err := time.Parse(time.RFC3339, fireAt)
		if err != nil || !value.After(now) {
			return time.Time{}, errors.New("Reminder fireAt 必须是未来 RFC3339 时间")
		}
		return value.UTC(), nil
	}
	return now.Add(time.Duration(delaySeconds * float64(time.Second))).UTC(), nil
}

func reminderCron(repeat string, timezone string, base time.Time) (string, error) {
	if _, err := time.LoadLocation(timezone); err != nil {
		return "", errors.New("Reminder 时区无效")
	}
	if len(strings.Fields(repeat)) == 5 {
		return repeat, nil
	}
	location, _ := time.LoadLocation(timezone)
	local := base.In(location)
	switch repeat {
	case "every:1d":
		return fmt.Sprintf("%d %d * * *", local.Minute(), local.Hour()), nil
	case "every:1w":
		return fmt.Sprintf("%d %d * * %d", local.Minute(), local.Hour(), local.Weekday()), nil
	default:
		return "", errors.New("Vela v1 repeat 仅支持五字段 cron、every:1d 或 every:1w")
	}
}

func reminderStatusFilter(query url.Values) (map[string]struct{}, bool) {
	if query.Get("all") == "true" {
		return nil, true
	}
	raw := strings.TrimSpace(query.Get("status"))
	if raw == "" {
		return nil, true
	}
	result := make(map[string]struct{})
	for _, value := range strings.Split(raw, ",") {
		value = strings.TrimSpace(value)
		if value != "scheduled" && value != "fired" && value != "canceled" {
			return nil, false
		}
		result[value] = struct{}{}
	}
	return result, true
}

func legacyReminderStatus(value platform.ReminderStatus) string {
	switch value {
	case platform.ReminderCompleted:
		return "fired"
	case platform.ReminderCanceled:
		return "canceled"
	default:
		return "scheduled"
	}
}

func (g *Gateway) legacyReminder(value platform.Reminder) map[string]any {
	fireAt := value.Schedule
	if value.NextFireAt != nil {
		fireAt = value.NextFireAt.UTC().Format(time.RFC3339Nano)
	}
	var msgRef any
	var anchorKind any
	var threadID any
	if value.Anchor != nil {
		anchorKind = string(value.Anchor.Kind)
		if value.Anchor.Kind == platform.ReminderAnchorThread &&
			strings.TrimSpace(value.Anchor.ThreadID) != "" {
			threadID = value.Anchor.ThreadID
		}
		if target, ok := g.targetForRouteID(value.Anchor.ChannelID); ok {
			msgRef = target + ":" + shortMessageID(value.Anchor.MessageRef.MessageID)
		}
	}
	var recurrence any
	if value.ScheduleKind == platform.ReminderCron {
		recurrence = map[string]string{"kind": "cron", "description": value.Schedule}
	}
	return map[string]any{
		"reminderId": value.ID, "ownerAgentId": value.AgentID,
		"title": value.Text, "fireAt": fireAt, "firedAt": nil,
		"createdAt": value.CreatedAt.UTC().Format(time.RFC3339Nano),
		"status":    legacyReminderStatus(value.Status), "msgRef": msgRef,
		"anchorKind": anchorKind, "threadId": threadID,
		"msgPermalink": nil, "recurrence": recurrence,
	}
}

func parseReminderPath(method string, path string) (string, string, bool) {
	prefix := agentapi.BasePath + "/reminders/"
	value := strings.TrimPrefix(path, prefix)
	if !strings.HasPrefix(path, prefix) {
		return "", "", false
	}
	parts := strings.Split(value, "/")
	if len(parts) == 1 && parts[0] != "" {
		switch method {
		case http.MethodPatch:
			return parts[0], "update", true
		case http.MethodDelete:
			return parts[0], "cancel", true
		}
	}
	if len(parts) == 2 && parts[0] != "" {
		if method == http.MethodPost && parts[1] == "snooze" {
			return parts[0], "snooze", true
		}
		if method == http.MethodGet && parts[1] == "log" {
			return parts[0], "log", true
		}
	}
	return "", "", false
}

func newReminderIdempotencyKey(prefix string) (string, error) {
	value, err := uuid.NewV7()
	if err != nil {
		return "", err
	}
	return prefix + "-" + value.String(), nil
}

func validUUIDv7String(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.Version() == 7 && parsed.String() == value
}

func optionalStringValue(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func optionalFloat(value *float64) float64 {
	if value == nil {
		return 0
	}
	return *value
}

func (g *Gateway) serveServer(response http.ResponseWriter) {
	g.mu.RLock()
	directory := g.directory
	directoryReady := g.directoryReady
	g.mu.RUnlock()
	if !directoryReady {
		g.writeJSON(response, http.StatusOK, map[string]any{
			"runtimeContext": map[string]string{
				"agentId":  g.config.AgentID,
				"serverId": g.config.ServerID,
			},
			"channels": []any{},
			"agents":   []any{},
			"humans":   []any{},
		})
		return
	}
	channels := make([]map[string]any, 0, len(directory.Channels))
	for _, channel := range directory.Channels {
		channelType := "channel"
		if channel.Visibility == "private" {
			channelType = "private"
		}
		channels = append(channels, map[string]any{
			"id":      channel.ID,
			"name":    channel.Name,
			"type":    channelType,
			"joined":  channel.Joined,
			"imState": channel.IMState,
		})
	}
	agents := make([]map[string]any, 0, len(directory.Members))
	humans := make([]map[string]any, 0, len(directory.Members))
	for _, member := range directory.Members {
		row := map[string]any{
			"name":        member.Handle,
			"displayName": member.DisplayName,
			"status":      "active",
			"memberId":    member.MemberID,
		}
		if member.Kind == "agent" {
			row["agentId"] = member.AgentID
			agents = append(agents, row)
		} else {
			row["humanId"] = member.HumanID
			humans = append(humans, row)
		}
	}
	g.writeJSON(response, http.StatusOK, map[string]any{
		"runtimeContext": map[string]string{
			"agentId":  g.config.AgentID,
			"serverId": g.config.ServerID,
		},
		"server": map[string]string{
			"id": directory.Server.ID, "slug": directory.Server.Slug,
			"name": directory.Server.Name,
		},
		"serverRole": nil,
		"channels":   channels,
		"agents":     agents,
		"humans":     humans,
	})
}

func (g *Gateway) serveChannelMembers(
	response http.ResponseWriter,
	request *http.Request,
) {
	target := strings.TrimSpace(request.URL.Query().Get("channel"))
	if !strings.HasPrefix(target, "#") {
		g.writeError(response, http.StatusBadRequest, "invalid_request", "channel members 需要 #Channel target")
		return
	}
	client, token, ok := g.runtimeTaskSession()
	if !ok {
		g.writeError(response, http.StatusServiceUnavailable, "platform_unavailable", "Runtime 平台会话不可用")
		return
	}
	g.mu.RLock()
	canonical, authorized := g.targetAliases[strings.ToLower(target)]
	directory := g.directory
	g.mu.RUnlock()
	if !authorized || !strings.HasPrefix(canonical, "#") {
		g.writeError(response, http.StatusForbidden, "target_not_authorized", "Channel 未由当前目录授权")
		return
	}
	var selected *platform.DirectoryChannel
	for index := range directory.Channels {
		if strings.EqualFold("#"+directory.Channels[index].Name, canonical) {
			selected = &directory.Channels[index]
			break
		}
	}
	if selected == nil {
		g.writeError(response, http.StatusNotFound, "channel_not_found", "Channel 目录已变化，请刷新后重试")
		return
	}
	value, err := client.GetRuntimeChannelMembers(
		request.Context(), token, g.config.ServerID, g.config.AgentID, selected.ID,
	)
	if err != nil {
		if errors.Is(err, platform.ErrCredentialRejected) {
			g.writeError(response, http.StatusUnauthorized, "runtime_session_rejected", "Runtime 平台会话已失效")
		} else {
			g.writeError(response, http.StatusBadGateway, "platform_request_failed", "Runtime Channel 成员读取失败")
		}
		return
	}
	channelKind := "channel"
	if value.Channel.Visibility == "private" {
		channelKind = "private"
	}
	agents := make([]map[string]any, 0, len(value.Members))
	humans := make([]map[string]any, 0, len(value.Members))
	for _, member := range value.Members {
		row := map[string]any{
			"name": member.Handle, "displayName": member.DisplayName,
			"status": "active", "memberId": member.MemberID,
		}
		if member.Kind == "agent" {
			row["agentId"] = member.AgentID
			agents = append(agents, row)
		} else {
			row["humanId"] = member.HumanID
			humans = append(humans, row)
		}
	}
	g.writeJSON(response, http.StatusOK, map[string]any{
		"channel": map[string]string{"ref": canonical, "type": channelKind},
		"agents":  agents,
		"humans":  humans,
	})
}

func (g *Gateway) writeError(
	response http.ResponseWriter,
	status int,
	code string,
	message string,
) {
	g.writeJSON(response, status, map[string]string{
		"code":    code,
		"message": message,
	})
}

func (g *Gateway) writeJSON(
	response http.ResponseWriter,
	status int,
	value any,
) {
	encoded, err := common.Marshal(value)
	if err != nil {
		http.Error(
			response,
			http.StatusText(http.StatusInternalServerError),
			http.StatusInternalServerError,
		)
		return
	}
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_, _ = response.Write(encoded)
}

func (g *Gateway) Close(ctx context.Context) error {
	if g == nil {
		return nil
	}
	g.closeOnce.Do(func() {
		if ctx == nil {
			ctx = context.Background()
		}
		if g.directoryCancel != nil {
			g.directoryCancel()
			select {
			case <-g.directoryDone:
			case <-ctx.Done():
				g.closeErr = errors.Join(g.closeErr, ctx.Err())
			}
		}
		g.mu.Lock()
		token := g.token
		g.token = ""
		g.mu.Unlock()
		g.hub.unregister(token, g)
		launchDirectory := filepath.Join(
			g.config.StateRoot,
			"launches",
			g.config.RuntimeEpoch,
		)
		if removeErr := os.RemoveAll(launchDirectory); removeErr != nil {
			g.closeErr = errors.Join(g.closeErr, removeErr)
		}
	})
	return g.closeErr
}

func (g *Gateway) String() string {
	if g == nil {
		return "VelaAgentGateway<nil>"
	}
	return fmt.Sprintf(
		"VelaAgentGateway<agent=%s,epoch=%s>",
		g.config.AgentID,
		g.config.RuntimeEpoch,
	)
}
