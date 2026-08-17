package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"velachat/agent/internal/filelock"
	"velachat/agent/internal/runtimecatalog"
	"velachat/agent/internal/runtimes"
	rootstate "velachat/agent/internal/state"
	"velachat/agent/internal/vela/activitygate"
	"velachat/agent/internal/vela/agentgateway"
	velacli "velachat/agent/internal/vela/cli"
	"velachat/agent/internal/vela/daemon"
	"velachat/agent/internal/vela/platform"
	"velachat/agent/internal/vela/selfupdate"
	"velachat/agent/internal/vela/tat"
)

var (
	ErrComputerStateInvalid      = errors.New("Vela Computer 本地状态无效")
	ErrComputerActivationTimeout = errors.New("computer_activation_timeout")
)

type managedComputerConfig struct {
	SchemaVersion     int    `json:"schemaVersion"`
	PlatformURL       string `json:"platformUrl"`
	AllowInsecureHTTP bool   `json:"allowInsecureHttp,omitempty"`
	ServerID          string `json:"serverId"`
	ComputerID        string `json:"computerId"`
	Name              string `json:"name"`
	Region            string `json:"region"`
}

type defaultComputerController struct {
	config Config
}

func (c *defaultComputerController) Setup(
	ctx context.Context,
	root string,
	options velacli.SetupOptions,
) error {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(root, 0o700); err != nil {
		return err
	}
	lock, err := filelock.AcquireExclusive(
		filepath.Join(root, "daemon.lock"),
	)
	if errors.Is(err, filelock.ErrLocked) {
		return daemon.ErrDaemonAlreadyRunning
	}
	if err != nil {
		return err
	}
	defer lock.Release()

	token, err := loadHumanAccessToken(options.AccessTokenFile)
	if err != nil {
		return err
	}
	defer token.Clear()
	client, err := platform.NewClient(platform.Config{
		BaseURL:               options.PlatformURL,
		Now:                   c.config.Now,
		MaxSessionTTL:         24 * time.Hour,
		AllowInsecureLoopback: c.config.AllowInsecureLoopback,
		AllowInsecureHTTP:     c.config.AllowInsecureHTTP,
	})
	if err != nil {
		return err
	}
	store := rootstate.New(root)
	journalName := "setup.journal.json"
	if options.Repair {
		journalName = "repair.journal.json"
	}
	journal, err := loadOrCreateSetupJournal(store, journalName)
	if err != nil {
		return err
	}
	config, configExists, err := loadSetupComputerConfig(root)
	if err != nil {
		return err
	}
	if configExists {
		if config.PlatformURL != options.PlatformURL ||
			config.ServerID != options.ServerID ||
			config.Name != options.Name {
			return ErrComputerStateInvalid
		}
	} else {
		if options.Repair {
			return ErrComputerStateInvalid
		}
		computer, err := client.CreateManagedComputer(
			ctx,
			token,
			platform.CreateManagedComputerRequest{
				ServerID:       options.ServerID,
				Name:           options.Name,
				IdempotencyKey: journal.CreateIdempotencyKey,
			},
		)
		if err != nil {
			return err
		}
		config = managedComputerConfig{
			SchemaVersion:     1,
			PlatformURL:       options.PlatformURL,
			AllowInsecureHTTP: c.config.AllowInsecureHTTP,
			ServerID:          options.ServerID,
			ComputerID:        computer.ID,
			Name:              options.Name,
			Region:            computer.Region,
		}
		if err := store.Write("config.json", config); err != nil {
			return err
		}
		journal.ComputerCreated = true
		if err := store.Write(journalName, journal); err != nil {
			return err
		}
	}
	if !options.Repair && !journal.TATRegistered {
		registration, err := client.CreateComputerRegistration(
			ctx,
			token,
			config.ServerID,
			config.ComputerID,
		)
		if err != nil {
			return err
		}
		if registration.Region != config.Region {
			return ErrComputerStateInvalid
		}
		tags := make([]tat.Tag, 0, len(registration.Tags))
		for _, tag := range registration.Tags {
			tags = append(tags, tat.Tag{
				Key:   tag.Key,
				Value: tag.Value,
			})
		}
		if err := c.config.TAT.Register(ctx, tat.Registration{
			StateRoot:         filepath.Join(root, "tat"),
			Region:            registration.Region,
			RegisterCodeID:    registration.RegisterCodeID,
			RegisterCodeValue: registration.RegisterCodeValue,
			Tags:              tags,
		}); err != nil {
			return err
		}
		journal.TATRegistered = true
		if err := store.Write(journalName, journal); err != nil {
			return err
		}
	}
	if options.Repair {
		if info, err := os.Lstat(filepath.Join(root, "tat", "config.dat")); err != nil ||
			!info.Mode().IsRegular() {
			return ErrComputerStateInvalid
		}
	}
	if journal.Complete && !options.Repair {
		_, err := loadComputerCredential(
			filepath.Join(root, "computer.credential"),
		)
		return err
	}

	handle, err := c.config.TAT.Start(ctx, filepath.Join(root, "tat"))
	if err != nil {
		return err
	}
	handleOpen := true
	defer func() {
		if handleOpen {
			_ = closeTATHandle(handle)
		}
	}()
	if !journal.ComputerActive {
		if err := waitForComputerActive(
			ctx,
			client,
			token,
			config.ServerID,
			config.ComputerID,
		); err != nil {
			return err
		}
		journal.ComputerActive = true
		if err := store.Write(journalName, journal); err != nil {
			return err
		}
	}
	if !journal.CredentialSaved || options.Repair {
		mode := "bootstrap"
		if options.Repair {
			mode = "recover"
		}
		issued, err := client.CreateComputerRuntimeCredential(
			ctx,
			token,
			config.ServerID,
			config.ComputerID,
			mode,
			journal.CredentialIdempotencyKey,
		)
		if err != nil {
			return err
		}
		credentialBytes := []byte(issued.Credential.Reveal())
		err = store.WriteFile(
			"computer.credential",
			credentialBytes,
			0o600,
		)
		clear(credentialBytes)
		if err != nil {
			return err
		}
		if err := store.Write("computer.credential.meta.json", map[string]any{
			"schemaVersion": 1,
			"credentialId":  issued.CredentialID,
			"version":       issued.Version,
			"expiresAt":     issued.ExpiresAt,
		}); err != nil {
			return err
		}
		journal.CredentialSaved = true
	}
	if err := closeTATHandle(handle); err != nil {
		return err
	}
	handleOpen = false
	journal.Complete = true
	return store.Write(journalName, journal)
}

type setupJournal struct {
	SchemaVersion            int    `json:"schemaVersion"`
	CreateIdempotencyKey     string `json:"createIdempotencyKey"`
	CredentialIdempotencyKey string `json:"credentialIdempotencyKey"`
	ComputerCreated          bool   `json:"computerCreated"`
	TATRegistered            bool   `json:"tatRegistered"`
	ComputerActive           bool   `json:"computerActive"`
	CredentialSaved          bool   `json:"credentialSaved"`
	Complete                 bool   `json:"complete"`
}

func loadOrCreateSetupJournal(
	store *rootstate.Store,
	name string,
) (setupJournal, error) {
	var journal setupJournal
	err := store.Read(name, &journal)
	if err == nil {
		if journal.SchemaVersion != 1 ||
			!validV7(journal.CreateIdempotencyKey) ||
			!validV7(journal.CredentialIdempotencyKey) {
			return setupJournal{}, ErrComputerStateInvalid
		}
		return journal, nil
	}
	if !os.IsNotExist(err) {
		return setupJournal{}, err
	}
	createKey, err := newID()
	if err != nil {
		return setupJournal{}, err
	}
	credentialKey, err := newID()
	if err != nil {
		return setupJournal{}, err
	}
	journal = setupJournal{
		SchemaVersion:            1,
		CreateIdempotencyKey:     createKey,
		CredentialIdempotencyKey: credentialKey,
	}
	if err := store.Write(name, journal); err != nil {
		return setupJournal{}, err
	}
	return journal, nil
}

func loadSetupComputerConfig(
	root string,
) (managedComputerConfig, bool, error) {
	config, err := loadManagedComputerConfig(root)
	if err == nil {
		return config, true, nil
	}
	if os.IsNotExist(err) {
		return managedComputerConfig{}, false, nil
	}
	return managedComputerConfig{}, false, err
}

func loadHumanAccessToken(
	path string,
) (platform.HumanAccessToken, error) {
	if !filepath.IsAbs(path) {
		return platform.HumanAccessToken{}, ErrComputerStateInvalid
	}
	before, err := os.Lstat(path)
	if err != nil ||
		!before.Mode().IsRegular() ||
		before.Mode()&os.ModeSymlink != 0 ||
		before.Mode().Perm() != 0o600 ||
		before.Size() < 1 ||
		before.Size() > 16*1024 {
		return platform.HumanAccessToken{}, ErrComputerStateInvalid
	}
	file, err := os.Open(path)
	if err != nil {
		return platform.HumanAccessToken{}, ErrComputerStateInvalid
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) {
		return platform.HumanAccessToken{}, ErrComputerStateInvalid
	}
	data, err := io.ReadAll(io.LimitReader(file, 16*1024+1))
	if err != nil || len(data) < 1 || len(data) > 16*1024 {
		clear(data)
		return platform.HumanAccessToken{}, ErrComputerStateInvalid
	}
	token, err := platform.NewHumanAccessToken(data)
	clear(data)
	if err != nil {
		return platform.HumanAccessToken{}, ErrComputerStateInvalid
	}
	return token, nil
}

func waitForComputerActive(
	ctx context.Context,
	client *platform.Client,
	token platform.HumanAccessToken,
	serverID string,
	computerID string,
) error {
	deadline := time.NewTimer(120 * time.Second)
	defer deadline.Stop()
	for {
		computer, err := client.GetManagedComputer(
			ctx,
			token,
			serverID,
			computerID,
		)
		if err != nil {
			return err
		}
		if computer.LifecycleState == "active" &&
			computer.TATAgentState == "online" {
			return nil
		}
		timer := time.NewTimer(2 * time.Second)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			return ctx.Err()
		case <-deadline.C:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			return ErrComputerActivationTimeout
		case <-timer.C:
		}
	}
}

func closeTATHandle(handle tat.Handle) error {
	closeContext, cancel := context.WithTimeout(
		context.Background(),
		10*time.Second,
	)
	defer cancel()
	return handle.Close(closeContext)
}

func (c *defaultComputerController) Run(
	ctx context.Context,
	root string,
) error {
	config, err := loadManagedComputerConfig(root)
	if err != nil {
		return err
	}
	credential, err := loadComputerCredential(
		filepath.Join(root, "computer.credential"),
	)
	if err != nil {
		return err
	}
	if credential.ComputerID() != config.ComputerID ||
		credential.ServerID() != config.ServerID {
		return ErrComputerStateInvalid
	}
	client, err := platform.NewClient(platform.Config{
		BaseURL:               config.PlatformURL,
		Now:                   c.config.Now,
		MaxSessionTTL:         24 * time.Hour,
		AllowInsecureLoopback: c.config.AllowInsecureLoopback,
		AllowInsecureHTTP:     config.AllowInsecureHTTP || c.config.AllowInsecureHTTP,
	})
	if err != nil {
		return err
	}
	updateBootstrap, updateEnabled, err := selfupdate.ResolveBootstrap(c.config.SelfUpdate)
	if err != nil {
		return err
	}
	activityGate := activitygate.New()
	if updateEnabled {
		if err := tat.ConfigureActivityGate(c.config.TAT, activityGate); err != nil {
			return err
		}
	}
	sessions := &computerSessionManager{
		client:     client,
		credential: credential,
		now:        c.config.Now,
	}
	catalog, err := runtimecatalog.New(runtimes.Builtins(
		runtimes.Options{
			Version:         c.config.Version,
			CodexExecutable: c.config.CodexExecutable,
		},
	))
	if err != nil {
		return err
	}
	runtimeFuture := newRuntimeSnapshotFuture()
	probeContext, cancelRuntimeProbe := context.WithCancel(ctx)
	runtimeProbeDone := make(chan struct{})
	snapshotRuntimeCatalog := catalog.Snapshot
	if c.config.runtimeSnapshot != nil {
		snapshotRuntimeCatalog = c.config.runtimeSnapshot
	}
	go func() {
		defer close(runtimeProbeDone)
		snapshot := snapshotRuntimeCatalog(probeContext)
		runtimeFuture.Publish(snapshot)
		if snapshot != nil {
			writeRuntimeCatalogStatus(
				c.config.Stderr,
				snapshot.RuntimeIDs(),
				strings.TrimSpace(c.config.CodexExecutable) != "",
			)
		}
	}()
	defer func() {
		cancelRuntimeProbe()
		<-runtimeProbeDone
	}()
	governor, err := daemon.NewLaunchGovernor(daemon.LaunchGovernorConfig{})
	if err != nil {
		return err
	}
	defer governor.Close()
	gatewayHub, err := agentgateway.NewHub()
	if err != nil {
		return err
	}
	defer func() {
		closeContext, cancel := context.WithTimeout(
			context.Background(),
			5*time.Second,
		)
		defer cancel()
		_ = gatewayHub.Close(closeContext)
	}()
	factory := &managedAgentFactory{
		root:          root,
		stderr:        c.config.Stderr,
		runtimeFuture: runtimeFuture,
		governor:      governor,
		sessions:      sessions,
		client:        client,
		transports:    c.config.Transports,
		gatewayHub:    gatewayHub,
		activityGate:  activityGate,
	}
	registry, err := daemon.NewRegistry(daemon.RegistryConfig{
		Factory:       factory,
		MaxConcurrent: daemon.DefaultMaximumAgents,
	})
	if err != nil {
		return err
	}
	heartbeatSink := &computerHeartbeatSink{
		sessions: sessions,
		client:   client,
	}
	runner, err := daemon.NewRunner(daemon.RunnerConfig{
		StateRoot:  root,
		Version:    c.config.Version,
		BuildID:    c.config.BuildID,
		ComputerID: config.ComputerID,
		Source: &computerAssignmentSource{
			computerID: config.ComputerID,
			sessions:   sessions,
			client:     client,
		},
		Registry: registry,
		Component: tatDaemonComponent{
			runtime:   c.config.TAT,
			stateRoot: filepath.Join(root, "tat"),
		},
		HeartbeatSink:     heartbeatSink,
		HeartbeatInterval: c.config.HeartbeatInterval,
		Now:               c.config.Now,
	})
	if err != nil {
		return err
	}
	if !updateEnabled {
		return runner.Run(ctx)
	}
	return c.runSelfUpdatingComputer(
		ctx, root, updateBootstrap, activityGate, runner, heartbeatSink,
	)
}

func (c *defaultComputerController) runSelfUpdatingComputer(
	ctx context.Context,
	root string,
	bootstrap selfupdate.ResolvedBootstrap,
	gate *activitygate.Gate,
	runner *daemon.Runner,
	heartbeatSink *computerHeartbeatSink,
) error {
	target := selfupdate.CurrentTarget()
	installationRoot := filepath.Dir(root)
	program := filepath.Join(installationRoot, "bin", "vela-computer")
	trust, err := selfupdate.OpenTrustState(selfupdate.TrustStateConfig{
		Root: root, Channel: bootstrap.Channel, Target: target,
		CurrentVersion: c.config.Version, Now: c.config.Now().UTC(),
	})
	if err != nil {
		return err
	}
	channel, err := selfupdate.NewChannelClient(selfupdate.ChannelClientConfig{
		BaseURL: bootstrap.ChannelURL, Channel: bootstrap.Channel, Target: target,
		KeyID: bootstrap.ChannelKeyID, PublicKey: bootstrap.ChannelPublicKey,
		Now: c.config.Now, AllowInsecureHTTP: bootstrap.AllowInsecureHTTP,
	})
	if err != nil {
		return err
	}
	preparer, err := selfupdate.NewDownloadPreparer(selfupdate.DownloadPreparerConfig{
		Root: root, HTTPClient: &http.Client{Timeout: 10 * time.Minute}, Now: c.config.Now,
		ReleasePublicKeys: bootstrap.ReleasePublicKeys,
	})
	if err != nil {
		return err
	}
	stager, err := selfupdate.NewStager(selfupdate.StagerConfig{
		StateRoot: root, InstallationRoot: installationRoot,
		CurrentVersion: c.config.Version, Target: target, CurrentProgram: program,
		Now:   c.config.Now,
		NewID: func() (string, error) { return newID() },
	})
	if err != nil {
		return err
	}
	launcher, err := selfupdate.NewPlatformHelperLauncher()
	if err != nil {
		return err
	}
	runContext, cancelRun := context.WithCancel(ctx)
	defer cancelRun()
	coordinator, err := selfupdate.NewCoordinator(selfupdate.CoordinatorConfig{
		Stager: stager, Gate: gate, Launcher: launcher, ParentPID: os.Getpid(),
		Now: c.config.Now, Shutdown: cancelRun,
	})
	if err != nil {
		return err
	}
	poller, err := selfupdate.NewPoller(selfupdate.PollerConfig{
		Source: channel, Preparer: preparer, Sink: stager, Trust: trust,
		Now: c.config.Now, Interval: 15 * time.Minute,
	})
	if err != nil {
		return err
	}
	reporter, err := selfupdate.NewHealthReporter(selfupdate.HealthReporterConfig{
		StateRoot: root, Version: c.config.Version, Program: program, Now: c.config.Now,
		Trust: trust,
	})
	if err != nil {
		return err
	}
	heartbeatSink.health = reporter
	errorsChannel := make(chan error, 3)
	go func() { errorsChannel <- runner.Run(runContext) }()
	go func() { errorsChannel <- poller.Run(runContext) }()
	go func() { errorsChannel <- coordinator.Run(runContext) }()
	first := <-errorsChannel
	cancelRun()
	remaining := errors.Join(<-errorsChannel, <-errorsChannel)
	return errors.Join(first, remaining)
}

func writeRuntimeCatalogStatus(
	writer io.Writer,
	available []string,
	codexConfigured bool,
) {
	if writer == nil {
		return
	}
	available = append([]string(nil), available...)
	sort.Strings(available)
	_, _ = fmt.Fprintf(
		writer,
		"Vela Runtime Catalog: available=%s codex_configured=%t\n",
		strings.Join(available, ","),
		codexConfigured,
	)
}

type tatDaemonComponent struct {
	runtime   tat.Runtime
	stateRoot string
}

type computerHeartbeatSink struct {
	sessions *computerSessionManager
	client   *platform.Client
	health   interface{ Report() (bool, error) }
}

func (s *computerHeartbeatSink) Send(
	ctx context.Context,
	value daemon.Heartbeat,
) error {
	session, err := s.sessions.Current(ctx)
	if err != nil {
		return err
	}
	heartbeat := platform.ComputerHeartbeat{
		HeartbeatID:        value.HeartbeatID,
		DaemonVersion:      value.DaemonVersion,
		DaemonBuildID:      value.DaemonBuildID,
		AssignmentEpoch:    value.AssignmentEpoch,
		AssignmentRevision: value.AssignmentRevision,
		TATState:           value.TATState,
		Reconcile: platform.ComputerHeartbeatReconcile{
			State:     value.ReconcileState,
			ErrorCode: value.ErrorCode,
		},
		Agents: make(
			[]platform.ComputerHeartbeatAgent,
			0,
			len(value.Agents),
		),
	}
	for _, agent := range value.Agents {
		heartbeat.Agents = append(
			heartbeat.Agents,
			platform.ComputerHeartbeatAgent{
				AgentID:           agent.AgentID,
				AssignmentEpoch:   agent.AssignmentEpoch,
				ConfigGeneration:  agent.ConfigGeneration,
				CredentialVersion: agent.CredentialVersion,
				Attempt:           agent.Attempt,
				LaunchID:          agent.LaunchID,
			},
		)
	}
	err = s.client.SendComputerHeartbeat(
		ctx,
		session.AccessToken,
		heartbeat,
	)
	if !errors.Is(err, platform.ErrCredentialRejected) {
		return s.afterHeartbeat(err)
	}
	s.sessions.Invalidate(session.AccessToken)
	session, err = s.sessions.Current(ctx)
	if err != nil {
		return err
	}
	return s.afterHeartbeat(s.client.SendComputerHeartbeat(
		ctx,
		session.AccessToken,
		heartbeat,
	))
}

func (s *computerHeartbeatSink) afterHeartbeat(err error) error {
	if err != nil || s.health == nil {
		return err
	}
	_, reportErr := s.health.Report()
	return reportErr
}

func (c tatDaemonComponent) Start(
	ctx context.Context,
) (daemon.ComponentHandle, error) {
	return c.runtime.Start(ctx, c.stateRoot)
}

func loadManagedComputerConfig(
	root string,
) (managedComputerConfig, error) {
	var config managedComputerConfig
	if err := rootstate.New(root).Read("config.json", &config); err != nil {
		return managedComputerConfig{}, err
	}
	if config.SchemaVersion != 1 ||
		!validV7(config.ServerID) ||
		!validV7(config.ComputerID) ||
		strings.TrimSpace(config.PlatformURL) == "" ||
		strings.TrimSpace(config.Name) == "" ||
		strings.TrimSpace(config.Region) == "" {
		return managedComputerConfig{}, ErrComputerStateInvalid
	}
	return config, nil
}

func loadComputerCredential(
	path string,
) (platform.ComputerCredential, error) {
	before, err := os.Lstat(path)
	if err != nil ||
		!before.Mode().IsRegular() ||
		before.Mode()&os.ModeSymlink != 0 ||
		before.Mode().Perm() != 0o600 ||
		before.Size() < 1 ||
		before.Size() > 4096 {
		return platform.ComputerCredential{}, ErrComputerStateInvalid
	}
	file, err := os.Open(path)
	if err != nil {
		return platform.ComputerCredential{}, ErrComputerStateInvalid
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) {
		return platform.ComputerCredential{}, ErrComputerStateInvalid
	}
	data, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil || len(data) < 1 || len(data) > 4096 {
		clear(data)
		return platform.ComputerCredential{}, ErrComputerStateInvalid
	}
	value, err := platform.NewComputerCredential(string(data))
	clear(data)
	if err != nil {
		return platform.ComputerCredential{}, ErrComputerStateInvalid
	}
	return value, nil
}

type computerSessionManager struct {
	mu         sync.Mutex
	client     *platform.Client
	credential platform.ComputerCredential
	now        func() time.Time
	session    platform.ComputerSession
}

func (m *computerSessionManager) Current(
	ctx context.Context,
) (platform.ComputerSession, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.session.AccessToken.Reveal() != "" &&
		m.session.ExpiresAt.After(m.now().UTC().Add(5*time.Minute)) {
		return m.session, nil
	}
	session, err := m.client.CreateComputerSession(ctx, m.credential)
	if err != nil {
		return platform.ComputerSession{}, err
	}
	m.session = session
	return session, nil
}

func (m *computerSessionManager) Invalidate(
	token platform.ComputerAccessToken,
) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.session.AccessToken.Reveal() == token.Reveal() {
		m.session = platform.ComputerSession{}
	}
}

type computerAssignmentSource struct {
	computerID string
	sessions   *computerSessionManager
	client     *platform.Client
}

func (s *computerAssignmentSource) Poll(
	ctx context.Context,
	request daemon.PollRequest,
) (daemon.PollResult, error) {
	session, err := s.sessions.Current(ctx)
	if err != nil {
		return daemon.PollResult{}, err
	}
	result, err := s.client.GetComputerAssignments(
		ctx,
		session.AccessToken,
		platform.ComputerAssignmentQuery{
			ExpectedComputerID: s.computerID,
			SinceEpoch:         request.SinceEpoch,
			SinceRevision:      request.SinceRevision,
			WaitSeconds:        request.WaitSeconds,
			ForceFull:          request.ForceFull,
		},
	)
	if errors.Is(err, platform.ErrCredentialRejected) {
		s.sessions.Invalidate(session.AccessToken)
		session, sessionErr := s.sessions.Current(ctx)
		if sessionErr != nil {
			return daemon.PollResult{}, sessionErr
		}
		result, err = s.client.GetComputerAssignments(
			ctx,
			session.AccessToken,
			platform.ComputerAssignmentQuery{
				ExpectedComputerID: s.computerID,
				SinceEpoch:         request.SinceEpoch,
				SinceRevision:      request.SinceRevision,
				WaitSeconds:        request.WaitSeconds,
				ForceFull:          request.ForceFull,
			},
		)
	}
	if err != nil {
		return daemon.PollResult{}, err
	}
	return daemon.PollResult{
		Snapshot: result.Snapshot,
		NoChange: result.NoChange,
	}, nil
}

func validV7(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.Version() == 7
}
