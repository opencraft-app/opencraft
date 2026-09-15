package server

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/terminal"

	"hypernode/internal/policy"
	"hypernode/internal/store"
)

type Options struct {
	Listen    string
	HostKey   string
	Store     *store.Store
	Policy    *policy.Engine
	AllowNone bool
}

type Server struct {
	options Options
	config  *ssh.ServerConfig
	pending sync.Map
	active  sync.Map
}

const codexAdmissionTimeout = 3 * time.Second

const observationMOTD = "☁️  Hypernode Codex gateway\r\n" +
	"This SSH endpoint is reserved for Codex Remote.\r\n" +
	"A Codex app-server channel must start within 3 seconds.\r\n$ "

type codexAdmission struct {
	once  sync.Once
	timer *time.Timer
}

func newCodexAdmission(timeout time.Duration, onTimeout func()) *codexAdmission {
	admission := &codexAdmission{}
	admission.timer = time.AfterFunc(timeout, func() {
		admission.once.Do(onTimeout)
	})
	return admission
}

func (a *codexAdmission) admit(onAdmit func()) bool {
	admitted := false
	a.once.Do(func() {
		a.timer.Stop()
		admitted = true
		onAdmit()
	})
	return admitted
}

func (a *codexAdmission) stop() {
	a.once.Do(func() { a.timer.Stop() })
}

func New(options Options) (*Server, error) {
	if options.Store == nil || options.Policy == nil {
		return nil, fmt.Errorf("store and policy are required")
	}
	srv := &Server{options: options}
	config := &ssh.ServerConfig{ServerVersion: "SSH-2.0-Hypernode_0.1"}
	config.PasswordCallback = srv.passwordCallback
	config.PublicKeyCallback = srv.publicKeyCallback
	config.NoClientAuth = options.AllowNone
	if options.AllowNone {
		config.NoClientAuthCallback = srv.noneAuthCallback
	}
	signer, err := loadOrCreateHostKey(options.Store, options.HostKey)
	if err != nil {
		return nil, err
	}
	config.AddHostKey(signer)
	srv.config = config
	return srv, nil
}

func (s *Server) noneAuthCallback(meta ssh.ConnMetadata) (*ssh.Permissions, error) {
	value, ok := s.pending.Load(meta.RemoteAddr().String())
	if !ok {
		return nil, fmt.Errorf("connection metadata is unavailable")
	}
	id := value.(string)
	allowed, err := s.options.Policy.AuthenticateNone(map[string]any{
		"connectionId":  id,
		"username":      meta.User(),
		"remoteAddr":    meta.RemoteAddr().String(),
		"clientVersion": string(meta.ClientVersion()),
		"method":        "none",
	})
	_ = s.options.Store.Record(id, "", "auth.none", map[string]any{
		"username": meta.User(), "accepted": allowed && err == nil,
	})
	_ = s.options.Store.Authenticate(id, meta.User(), allowed && err == nil)
	_ = s.options.Store.SetClientVersion(id, string(meta.ClientVersion()))
	if err != nil || !allowed {
		return nil, fmt.Errorf("none authentication rejected")
	}
	return &ssh.Permissions{Extensions: map[string]string{"hypernode.connection-id": id}}, nil
}

func (s *Server) Serve(ctx context.Context) error {
	listener, err := net.Listen("tcp", s.options.Listen)
	if err != nil {
		return err
	}
	defer listener.Close()
	backgroundTick := time.NewTicker(time.Second)
	defer backgroundTick.Stop()
	tickWake, cancelTickWake := s.options.Policy.SubscribeTickWake()
	defer cancelTickWake()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-tickWake:
				_ = s.options.Policy.Tick()
			case <-backgroundTick.C:
				_ = s.options.Policy.Tick()
			}
		}
	}()
	go func() {
		<-ctx.Done()
		_ = listener.Close()
		s.active.Range(func(key, _ any) bool {
			_ = key.(net.Conn).Close()
			return true
		})
	}()
	var workers sync.WaitGroup
	defer workers.Wait()
	for {
		conn, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			continue
		}
		workers.Add(1)
		s.active.Store(conn, struct{}{})
		go func() {
			defer workers.Done()
			defer s.active.Delete(conn)
			s.handleConnection(conn)
		}()
	}
}

type connectionMeta struct {
	id     string
	remote string
}

func (s *Server) passwordCallback(meta ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
	value, ok := s.pending.Load(meta.RemoteAddr().String())
	if !ok {
		return nil, fmt.Errorf("connection metadata is unavailable")
	}
	id := value.(string)
	ctx := map[string]any{
		"connectionId":  id,
		"username":      meta.User(),
		"remoteAddr":    meta.RemoteAddr().String(),
		"clientVersion": string(meta.ClientVersion()),
		"password":      string(password),
	}
	allowed, err := s.options.Policy.Authenticate(ctx)
	_ = s.options.Store.Record(id, "", "auth.password", map[string]any{
		"username": meta.User(), "accepted": allowed && err == nil,
		"passwordSha256": sha256Hex(password),
	})
	_ = s.options.Store.Authenticate(id, meta.User(), allowed && err == nil)
	_ = s.options.Store.SetClientVersion(id, string(meta.ClientVersion()))
	if err != nil || !allowed {
		return nil, fmt.Errorf("authentication rejected")
	}
	return &ssh.Permissions{Extensions: map[string]string{"hypernode.connection-id": id}}, nil
}

func (s *Server) publicKeyCallback(meta ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
	value, ok := s.pending.Load(meta.RemoteAddr().String())
	if !ok {
		return nil, fmt.Errorf("connection metadata is unavailable")
	}
	id := value.(string)
	publicKey := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
	fingerprint := ssh.FingerprintSHA256(key)
	allowed, err := s.options.Policy.AuthenticatePublicKey(map[string]any{
		"connectionId":  id,
		"username":      meta.User(),
		"remoteAddr":    meta.RemoteAddr().String(),
		"clientVersion": string(meta.ClientVersion()),
		"publicKey":     publicKey,
		"fingerprint":   fingerprint,
		"method":        "publickey",
	})
	_ = s.options.Store.Record(id, "", "auth.publickey", map[string]any{
		"username": meta.User(), "fingerprint": fingerprint, "accepted": allowed && err == nil,
	})
	_ = s.options.Store.Authenticate(id, meta.User(), allowed && err == nil)
	_ = s.options.Store.SetClientVersion(id, string(meta.ClientVersion()))
	if err != nil || !allowed {
		return nil, fmt.Errorf("public key authentication rejected")
	}
	return &ssh.Permissions{Extensions: map[string]string{"hypernode.connection-id": id}}, nil
}

func (s *Server) handleConnection(raw net.Conn) {
	defer raw.Close()
	provisional := connectionID(raw.RemoteAddr().String(), nil)
	_ = s.options.Store.OpenConnection(provisional, raw.RemoteAddr().String(), "")
	s.pending.Store(raw.RemoteAddr().String(), provisional)
	defer s.pending.Delete(raw.RemoteAddr().String())
	serverConn, channels, requests, err := ssh.NewServerConn(raw, s.config)
	if err != nil {
		failure := classifyTransportFailure(err)
		_ = s.options.Store.Record(provisional, "", "transport.failed", failure)
		_ = s.options.Store.CloseConnection(provisional)
		return
	}
	_ = s.options.Store.Record(provisional, "", "transport.ready", map[string]any{
		"username": serverConn.User(), "clientVersion": string(serverConn.ClientVersion()),
		"sessionId": serverConn.SessionID(),
	})
	admission := newCodexAdmission(codexAdmissionTimeout, func() {
		_ = s.options.Store.Record(provisional, "", "codex.admission.timeout", map[string]any{
			"timeoutMs": codexAdmissionTimeout.Milliseconds(),
		})
		_ = serverConn.Close()
	})
	defer func() {
		admission.stop()
		_ = s.options.Store.CloseConnection(provisional)
		serverConn.Close()
	}()
	go s.handleGlobalRequests(provisional, requests)
	for channel := range channels {
		go s.handleChannel(provisional, channel, admission)
	}
}

func classifyTransportFailure(err error) map[string]any {
	failure := map[string]any{"error": err.Error(), "phase": "ssh-handshake"}
	message := strings.ToLower(err.Error())
	if errors.Is(err, io.EOF) || strings.HasSuffix(message, ": eof") || message == "eof" {
		failure["phase"] = "pre-identification"
		failure["diagnostic"] = "client closed before sending its SSH identification; inspect client ProxyCommand/KnownHostsCommand/Match exec/CLI wrappers and retry with /usr/bin/ssh -F /dev/null"
	}
	if strings.Contains(message, "no common algorithm") {
		failure["phase"] = "algorithm-negotiation"
		failure["diagnostic"] = "client and server did not negotiate a shared SSH algorithm"
	}
	return failure
}

func (s *Server) handleGlobalRequests(connectionID string, requests <-chan *ssh.Request) {
	for request := range requests {
		_ = s.options.Store.Record(connectionID, "", "global.request", map[string]any{
			"type": request.Type, "wantReply": request.WantReply, "payloadBase64": base64.StdEncoding.EncodeToString(request.Payload),
		})
		allowed := request.Type == "keepalive@openssh.com" || request.Type == "keepalive@hypernode"
		if request.WantReply {
			_ = request.Reply(allowed, nil)
		}
	}
}

func (s *Server) handleChannel(connectionID string, pending ssh.NewChannel, admission *codexAdmission) {
	sessionID := randomID(12)
	_ = s.options.Store.Record(connectionID, sessionID, "channel.open", map[string]any{
		"type": pending.ChannelType(), "extraDataBase64": base64.StdEncoding.EncodeToString(pending.ExtraData()),
	})
	if pending.ChannelType() != "session" {
		_ = pending.Reject(ssh.Prohibited, "hypernode records but does not proxy this channel type")
		return
	}
	channel, requests, err := pending.Accept()
	if err != nil {
		return
	}
	defer channel.Close()
	for request := range requests {
		s.handleSessionRequest(connectionID, sessionID, channel, request, admission)
	}
}

func (s *Server) handleSessionRequest(connectionID, sessionID string, channel ssh.Channel, request *ssh.Request, admission *codexAdmission) {
	payload := base64.StdEncoding.EncodeToString(request.Payload)
	metadata := map[string]any{"type": request.Type, "wantReply": request.WantReply, "payloadBase64": payload}
	allowed := false
	switch request.Type {
	case "env":
		name, rest, ok := readSSHString(request.Payload)
		value, _, ok2 := readSSHString(rest)
		if ok && ok2 {
			metadata["name"] = name
			metadata["value"] = value
			allowed = true
		}
	case "pty-req":
		termName, rest, ok := readSSHString(request.Payload)
		if ok && len(rest) >= 16 {
			metadata["term"] = termName
			metadata["columns"] = binary.BigEndian.Uint32(rest[0:4])
			metadata["rows"] = binary.BigEndian.Uint32(rest[4:8])
			allowed = true
		}
	case "window-change":
		if len(request.Payload) >= 16 {
			metadata["columns"] = binary.BigEndian.Uint32(request.Payload[0:4])
			metadata["rows"] = binary.BigEndian.Uint32(request.Payload[4:8])
			allowed = true
		}
	case "exec":
		command, _, ok := readSSHString(request.Payload)
		metadata["command"] = command
		allowed = ok
		_ = s.options.Store.Record(connectionID, sessionID, "session.request", metadata)
		if request.WantReply {
			_ = request.Reply(allowed, nil)
		}
		if allowed {
			s.execute(connectionID, sessionID, channel, command, admission)
		}
		return
	case "shell":
		allowed = true
		_ = s.options.Store.Record(connectionID, sessionID, "session.request", metadata)
		if request.WantReply {
			_ = request.Reply(true, nil)
		}
		s.shell(connectionID, sessionID, channel)
		return
	case "signal", "break":
		allowed = true
	}
	_ = s.options.Store.Record(connectionID, sessionID, "session.request", metadata)
	if request.WantReply {
		_ = request.Reply(allowed, nil)
	}
}

func (s *Server) execute(connectionID, sessionID string, channel ssh.Channel, command string, admission *codexAdmission) {
	decision, err := s.options.Policy.Exec(map[string]any{
		"connectionId": connectionID, "sessionId": sessionID, "command": command,
	})
	if err != nil {
		decision = policy.Decision{Stderr: "hypernode policy error\n", ExitCode: 125}
	}
	writeDecision(s.options.Store, connectionID, sessionID, channel, decision)
	if decision.Stream != "" {
		if decision.Stream == "codex-app-server-proxy" {
			admission.admit(func() {
				_ = s.options.Store.Record(connectionID, sessionID, "codex.admission.ready", map[string]any{
					"stream": decision.Stream,
				})
			})
		}
		s.stream(connectionID, sessionID, decision.Stream, channel)
		return
	}
	s.finish(channel, decision.ExitCode)
}

func (s *Server) stream(connectionID, sessionID, name string, channel ssh.Channel) {
	_ = s.options.Store.Record(connectionID, sessionID, "stream.open", map[string]any{"name": name})
	type streamRead struct {
		data []byte
		err  error
	}
	reads := make(chan streamRead, 1)
	stopReads := make(chan struct{})
	defer close(stopReads)
	go func() {
		defer close(reads)
		buffer := make([]byte, 64*1024)
		for {
			count, err := channel.Read(buffer)
			chunk := append([]byte(nil), buffer[:count]...)
			select {
			case reads <- streamRead{data: chunk, err: err}:
			case <-stopReads:
				return
			}
			if err != nil {
				return
			}
		}
	}()
	wake, cancelWake := s.options.Policy.SubscribeWake()
	defer cancelWake()
	exitCode := 0
	running := true
	initial, initialErr := s.options.Policy.StreamPoll(map[string]any{
		"connectionId": connectionID,
		"sessionId":    sessionID,
		"stream":       name,
	})
	if initialErr != nil {
		writeObserved(s.options.Store, connectionID, sessionID, channel, "", "hypernode stream policy error\n")
		exitCode = 125
		running = false
	} else {
		writeDecision(s.options.Store, connectionID, sessionID, channel, initial)
		if initial.ExitCode != 0 {
			exitCode = initial.ExitCode
		}
	}
	for running {
		select {
		case read, open := <-reads:
			if !open {
				running = false
				continue
			}
			if len(read.data) > 0 {
				_ = s.options.Store.Record(connectionID, sessionID, "stream.input", map[string]any{
					"name": name, "base64": base64.StdEncoding.EncodeToString(read.data), "bytes": len(read.data),
				})
				decision, policyErr := s.options.Policy.StreamData(map[string]any{
					"connectionId": connectionID,
					"sessionId":    sessionID,
					"stream":       name,
					"dataBytes":    read.data,
				})
				if policyErr != nil {
					writeObserved(s.options.Store, connectionID, sessionID, channel, "", "hypernode stream policy error\n")
					exitCode = 125
					running = false
					continue
				}
				writeDecision(s.options.Store, connectionID, sessionID, channel, decision)
				exitCode = decision.ExitCode
			}
			if read.err != nil {
				running = false
			}
		case <-wake:
			decision, policyErr := s.options.Policy.StreamPoll(map[string]any{
				"connectionId": connectionID,
				"sessionId":    sessionID,
				"stream":       name,
			})
			if policyErr != nil {
				writeObserved(s.options.Store, connectionID, sessionID, channel, "", "hypernode stream poll policy error\n")
				exitCode = 125
				running = false
				continue
			}
			writeDecision(s.options.Store, connectionID, sessionID, channel, decision)
			if decision.ExitCode != 0 {
				exitCode = decision.ExitCode
			}
		}
	}
	decision, err := s.options.Policy.StreamClose(map[string]any{
		"connectionId": connectionID, "sessionId": sessionID, "stream": name,
	})
	if err == nil {
		writeDecision(s.options.Store, connectionID, sessionID, channel, decision)
		exitCode = decision.ExitCode
	}
	_ = s.options.Store.Record(connectionID, sessionID, "stream.close", map[string]any{"name": name, "exitCode": exitCode})
	s.finish(channel, exitCode)
}

func (s *Server) finish(channel ssh.Channel, exitCode int) {
	status := make([]byte, 4)
	binary.BigEndian.PutUint32(status, uint32(exitCode))
	_, _ = channel.SendRequest("exit-status", false, status)
	_ = channel.CloseWrite()
	_ = channel.Close()
}

func (s *Server) shell(connectionID, sessionID string, channel ssh.Channel) {
	writeObserved(s.options.Store, connectionID, sessionID, channel, observationMOTD, "")
	term := terminal.NewTerminal(channel, "")
	for {
		line, err := term.ReadLine()
		if err != nil {
			return
		}
		_ = s.options.Store.Record(connectionID, sessionID, "shell.input", map[string]any{"line": line})
		if strings.TrimSpace(line) == "exit" {
			writeObserved(s.options.Store, connectionID, sessionID, channel, "logout\r\n", "")
			return
		}
		decision, err := s.options.Policy.Exec(map[string]any{
			"connectionId": connectionID, "sessionId": sessionID, "command": line, "interactive": true,
		})
		if err != nil {
			decision = policy.Decision{Stderr: "hypernode policy error\r\n", ExitCode: 125}
		}
		writeDecision(s.options.Store, connectionID, sessionID, channel, decision)
		_, _ = io.WriteString(channel, "$ ")
	}
}

func writeObserved(st *store.Store, connectionID, sessionID string, channel ssh.Channel, stdout, stderr string) {
	if stdout != "" {
		_, _ = io.WriteString(channel, stdout)
		_ = st.Record(connectionID, sessionID, "stream.stdout", map[string]any{"text": stdout})
	}
	if stderr != "" {
		_, _ = io.WriteString(channel.Stderr(), stderr)
		_ = st.Record(connectionID, sessionID, "stream.stderr", map[string]any{"text": stderr})
	}
}

func writeDecision(st *store.Store, connectionID, sessionID string, channel ssh.Channel, decision policy.Decision) {
	if len(decision.StdoutBytes) > 0 {
		_, _ = channel.Write(decision.StdoutBytes)
		if decision.Sensitive {
			_ = st.Record(connectionID, sessionID, "stream.stdout.binary", map[string]any{
				"redacted": true, "bytes": len(decision.StdoutBytes),
			})
		} else {
			_ = st.Record(connectionID, sessionID, "stream.stdout.binary", map[string]any{
				"base64": base64.StdEncoding.EncodeToString(decision.StdoutBytes), "bytes": len(decision.StdoutBytes),
			})
		}
	}
	writeObserved(st, connectionID, sessionID, channel, decision.Stdout, decision.Stderr)
}

func loadOrCreateHostKey(st *store.Store, legacySeedPath string) (ssh.Signer, error) {
	if encoded, found, err := st.NodeIdentity("ssh-ed25519"); err != nil {
		return nil, err
	} else if found {
		return ssh.ParsePrivateKey(encoded)
	}

	encoded, err := os.ReadFile(legacySeedPath)
	if err == nil {
		if _, err := ssh.ParsePrivateKey(encoded); err != nil {
			return nil, fmt.Errorf("parse legacy SSH host key seed: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	} else {
		encoded, err = generateHostKey()
		if err != nil {
			return nil, err
		}
	}
	stored, err := st.GetOrInsertNodeIdentity("ssh-ed25519", encoded)
	if err != nil {
		return nil, err
	}
	return ssh.ParsePrivateKey(stored)
}

func generateHostKey() ([]byte, error) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	marshaled, err := ssh.MarshalPrivateKey(privateKey, "hypernode generated host key")
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(marshaled), nil
}

func readSSHString(payload []byte) (string, []byte, bool) {
	if len(payload) < 4 {
		return "", nil, false
	}
	size := int(binary.BigEndian.Uint32(payload[:4]))
	if size < 0 || len(payload) < 4+size {
		return "", nil, false
	}
	return string(payload[4 : 4+size]), payload[4+size:], true
}

func connectionID(remote string, client []byte) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%s|%d", remote, client, time.Now().UnixNano())))
	return hex.EncodeToString(sum[:12])
}

func randomID(size int) string {
	value := make([]byte, size)
	_, _ = rand.Read(value)
	return hex.EncodeToString(value)
}

func sha256Hex(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}
