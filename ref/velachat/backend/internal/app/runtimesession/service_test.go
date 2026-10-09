package runtimesession

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"chatserver/internal/apperror"
	clockport "chatserver/internal/ports/clock"
	runtimesessionport "chatserver/internal/ports/runtimesession"
	tencentimport "chatserver/internal/ports/tencentim"
	tokenport "chatserver/internal/ports/token"
)

const (
	sessionServerID = "01989c24-7540-7f12-a27b-c83243215dd3"
	sessionAgentID  = "01989c24-7540-7f12-a27b-c83243215dd4"
)

var sessionNow = time.Date(2026, 7, 30, 20, 0, 0, 0, time.UTC)

type fakeRuntimeSessionRepository struct {
	agent       runtimesessionport.Agent
	findErr     error
	findArgs    []any
	markCurrent bool
	markErr     error
	markArgs    []any
}

func (r *fakeRuntimeSessionRepository) FindCurrentAgent(
	_ context.Context,
	serverID string,
	agentID string,
	version uint64,
) (runtimesessionport.Agent, error) {
	r.findArgs = []any{serverID, agentID, version}
	return r.agent, r.findErr
}

func (r *fakeRuntimeSessionRepository) MarkCredentialUsed(
	_ context.Context,
	serverID string,
	agentID string,
	version uint64,
	at time.Time,
) (bool, error) {
	r.markArgs = []any{serverID, agentID, version, at}
	return r.markCurrent, r.markErr
}

type recordingRuntimeSigner struct {
	claims tokenport.Claims
	token  string
	err    error
}

func (s *recordingRuntimeSigner) Sign(
	_ context.Context,
	claims tokenport.Claims,
) (string, error) {
	s.claims = claims
	return s.token, s.err
}

func (*recordingRuntimeSigner) Verify(
	context.Context,
	string,
) (tokenport.Claims, error) {
	return tokenport.Claims{}, errors.New("not used")
}

type recordingRuntimeUserSigIssuer struct {
	userID string
	ttl    time.Duration
	result tencentimport.UserSig
	err    error
}

func (i *recordingRuntimeUserSigIssuer) Issue(
	_ context.Context,
	userID string,
	ttl time.Duration,
) (tencentimport.UserSig, error) {
	i.userID = userID
	i.ttl = ttl
	return i.result, i.err
}

type runtimeSessionClock struct{ now time.Time }

func (c runtimeSessionClock) Now() time.Time { return c.now }

var _ clockport.Clock = runtimeSessionClock{}

func TestCreateForLaunchIssuesRuntimeTokenAndUserSigFromCurrentAgentFacts(
	t *testing.T,
) {
	repository := &fakeRuntimeSessionRepository{
		agent:       readyRuntimeAgent(),
		markCurrent: true,
	}
	tokens := &recordingRuntimeSigner{
		token: "short-runtime-token",
	}
	userSigs := &recordingRuntimeUserSigIssuer{
		result: tencentimport.UserSig{
			Value:     "short-agent-usersig",
			ExpiresAt: sessionNow.Add(50 * time.Minute),
		},
	}
	service := newRuntimeSessionService(t, repository, tokens, userSigs)

	session, err := createRuntimeSessionForTest(service)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if session.AccessToken != "short-runtime-token" ||
		!session.ExpiresAt.Equal(sessionNow.Add(15*time.Minute)) ||
		!reflect.DeepEqual(session.Agent, identityFromReadyAgent()) ||
		session.IM.SDKAppID != 1600000000 ||
		session.IM.UserID != "a_OPAQUE" ||
		session.IM.UserSig != "short-agent-usersig" ||
		!session.IM.ExpiresAt.Equal(sessionNow.Add(50*time.Minute)) {
		t.Fatalf("session = %#v", session)
	}
	if tokens.claims.Kind() != tokenport.ClaimsRuntimeAccess ||
		!tokens.claims.HasLaunchFence() ||
		tokens.claims.ServerID() != sessionServerID ||
		tokens.claims.AgentID() != sessionAgentID ||
		tokens.claims.Version() != 7 ||
		!tokens.claims.IssuedAt().Equal(sessionNow) ||
		!tokens.claims.ExpiresAt().Equal(sessionNow.Add(15*time.Minute)) {
		t.Fatalf("signed claims = %#v", tokens.claims)
	}
	if userSigs.userID != "a_OPAQUE" ||
		userSigs.ttl != time.Hour {
		t.Fatalf("Issue(%q, %v)", userSigs.userID, userSigs.ttl)
	}
	if len(repository.markArgs) != 4 ||
		repository.markArgs[0] != sessionServerID ||
		repository.markArgs[1] != sessionAgentID ||
		repository.markArgs[2] != uint64(7) ||
		!repository.markArgs[3].(time.Time).Equal(sessionNow) {
		t.Fatalf("MarkCredentialUsed args = %#v", repository.markArgs)
	}
}

func TestCreateForLaunchBindsCompleteFenceToRuntimeToken(t *testing.T) {
	repository := &fakeRuntimeSessionRepository{agent: readyRuntimeAgent(), markCurrent: true}
	tokens := &recordingRuntimeSigner{token: "launch-runtime-token"}
	userSigs := &recordingRuntimeUserSigIssuer{result: tencentimport.UserSig{
		Value: "launch-usersig", ExpiresAt: sessionNow.Add(time.Hour),
	}}
	service := newRuntimeSessionService(t, repository, tokens, userSigs)
	launchID := "01989c24-7540-7f12-a27b-c83243215dd6"
	epoch := "01989c24-7540-7f12-a27b-c83243215dd7"
	_, err := service.CreateForLaunch(
		context.Background(),
		sessionServerID,
		"01989c24-7540-7f12-a27b-c83243215dda",
		sessionAgentID,
		LaunchFence{
			LaunchID: launchID, AssignmentEpoch: epoch,
			ConfigGeneration: 6, CredentialVersion: 7, Attempt: 4,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !tokens.claims.HasLaunchFence() ||
		tokens.claims.ComputerID() != "01989c24-7540-7f12-a27b-c83243215dda" ||
		tokens.claims.LaunchID() != launchID || tokens.claims.AssignmentEpoch() != epoch ||
		tokens.claims.ConfigGeneration() != 6 || tokens.claims.Version() != 7 ||
		tokens.claims.Attempt() != 4 {
		t.Fatalf("signed Launch claims = %#v", tokens.claims)
	}
}

func TestCreateRejectsUnreadyAgentBeforeIssuingSecrets(t *testing.T) {
	tests := []struct {
		name     string
		mutate   func(*runtimesessionport.Agent)
		wantCode string
	}{
		{
			name: "IM provisioning",
			mutate: func(agent *runtimesessionport.Agent) {
				agent.IMState = "provisioning"
			},
			wantCode: "agent_not_ready",
		},
		{
			name: "IM user missing",
			mutate: func(agent *runtimesessionport.Agent) {
				agent.IMUserID = ""
			},
			wantCode: "agent_not_ready",
		},
		{
			name: "computer unbound",
			mutate: func(agent *runtimesessionport.Agent) {
				agent.ComputerReady = false
			},
			wantCode: "computer_not_ready",
		},
		{
			name: "desired stopped",
			mutate: func(agent *runtimesessionport.Agent) {
				agent.DesiredState = "stopped"
			},
			wantCode: "runtime_unavailable",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			agent := readyRuntimeAgent()
			test.mutate(&agent)
			repository := &fakeRuntimeSessionRepository{
				agent:       agent,
				markCurrent: true,
			}
			tokens := &recordingRuntimeSigner{}
			userSigs := &recordingRuntimeUserSigIssuer{}
			service := newRuntimeSessionService(
				t,
				repository,
				tokens,
				userSigs,
			)

			_, err := createRuntimeSessionForTest(service)
			if got := apperror.CodeOf(err); got != test.wantCode {
				t.Fatalf("Create() code = %q, want %q", got, test.wantCode)
			}
			if tokens.claims.Kind() != "" || userSigs.userID != "" {
				t.Fatal("unready Agent reached secret issuer")
			}
		})
	}
}

func TestCreateAllowsDesiredRunningAgentBeforeFirstRuntimeObservation(t *testing.T) {
	agent := readyRuntimeAgent()
	agent.ObservedState = "stopped"
	repository := &fakeRuntimeSessionRepository{agent: agent, markCurrent: true}
	service := newRuntimeSessionService(
		t,
		repository,
		&recordingRuntimeSigner{token: "short-runtime-token"},
		&recordingRuntimeUserSigIssuer{result: tencentimport.UserSig{
			Value: "short-agent-usersig", ExpiresAt: sessionNow.Add(time.Hour),
		}},
	)
	if _, err := createRuntimeSessionForTest(service); err != nil {
		t.Fatalf("Create(observed stopped, desired running) error = %v", err)
	}
}

func TestCreateRejectsRotationDuringIssuanceAndHidesIssuerErrors(t *testing.T) {
	tests := []struct {
		name        string
		tokenErr    error
		userSigErr  error
		markCurrent bool
		markErr     error
		wantCode    string
	}{
		{
			name:        "token signer failed",
			tokenErr:    errors.New("private signing detail"),
			markCurrent: true,
			wantCode:    "runtime_unavailable",
		},
		{
			name:        "UserSig issuer failed",
			userSigErr:  errors.New("private tencent key detail"),
			markCurrent: true,
			wantCode:    "runtime_unavailable",
		},
		{
			name:        "credential rotated",
			markCurrent: false,
			wantCode:    "runtime_credential_revoked",
		},
		{
			name:        "final currentness unavailable",
			markCurrent: true,
			markErr:     errors.New("database unavailable"),
			wantCode:    "internal_error",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			repository := &fakeRuntimeSessionRepository{
				agent:       readyRuntimeAgent(),
				markCurrent: test.markCurrent,
				markErr:     test.markErr,
			}
			tokens := &recordingRuntimeSigner{
				token: "short-runtime-token",
				err:   test.tokenErr,
			}
			userSigs := &recordingRuntimeUserSigIssuer{
				result: tencentimport.UserSig{
					Value:     "short-agent-usersig",
					ExpiresAt: sessionNow.Add(time.Hour),
				},
				err: test.userSigErr,
			}
			service := newRuntimeSessionService(t, repository, tokens, userSigs)

			session, err := createRuntimeSessionForTest(service)
			if got := apperror.CodeOf(err); got != test.wantCode {
				t.Fatalf("Create() code = %q, want %q; err=%v", got, test.wantCode, err)
			}
			if session.AccessToken != "" || session.IM.UserSig != "" {
				t.Fatalf("failed Create() returned secrets: %#v", session)
			}
			for _, private := range []string{
				"private signing detail",
				"private tencent key detail",
			} {
				if err != nil && err.Error() == private {
					t.Fatalf("Create() leaked provider error: %v", err)
				}
			}
		})
	}
}

func TestGetReturnsCurrentRuntimeIdentity(t *testing.T) {
	repository := &fakeRuntimeSessionRepository{
		agent: readyRuntimeAgent(),
	}
	service := newRuntimeSessionService(
		t,
		repository,
		&recordingRuntimeSigner{},
		&recordingRuntimeUserSigIssuer{},
	)

	identity, err := service.Get(
		context.Background(),
		sessionServerID,
		sessionAgentID,
		7,
	)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if !reflect.DeepEqual(identity, identityFromReadyAgent()) {
		t.Fatalf("Get() = %#v", identity)
	}
}

func newRuntimeSessionService(
	t *testing.T,
	repository *fakeRuntimeSessionRepository,
	tokens *recordingRuntimeSigner,
	userSigs *recordingRuntimeUserSigIssuer,
) *Service {
	t.Helper()
	service, err := NewService(
		repository,
		tokens,
		userSigs,
		runtimeSessionClock{now: sessionNow},
		Config{
			SDKAppID:       1600000000,
			AccessTTL:      15 * time.Minute,
			UserSigTTL:     time.Hour,
			AllowedRuntime: []string{"codex", "claude", "kimi", "pi"},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func createRuntimeSessionForTest(service *Service) (Session, error) {
	return service.CreateForLaunch(
		context.Background(),
		sessionServerID,
		"01989c24-7540-7f12-a27b-c83243215dda",
		sessionAgentID,
		LaunchFence{
			LaunchID:          "01989c24-7540-7f12-a27b-c83243215dd6",
			AssignmentEpoch:   "01989c24-7540-7f12-a27b-c83243215dd7",
			ConfigGeneration:  6,
			CredentialVersion: 7,
			Attempt:           4,
		},
	)
}

func readyRuntimeAgent() runtimesessionport.Agent {
	return runtimesessionport.Agent{
		ID:                sessionAgentID,
		ServerID:          sessionServerID,
		IMUserID:          "a_OPAQUE",
		IMState:           "ready",
		ComputerID:        "01989c24-7540-7f12-a27b-c83243215dda",
		ComputerReady:     true,
		RuntimeKind:       "codex",
		RuntimeModel:      "default",
		ReplyPolicy:       "mention_and_dm",
		DesiredState:      "running",
		ObservedState:     "starting",
		CredentialVersion: 7,
	}
}

func identityFromReadyAgent() Identity {
	return Identity{
		ID:       sessionAgentID,
		ServerID: sessionServerID,
		UserID:   "a_OPAQUE",
		Capabilities: []string{
			"read", "send", "server", "channels", "threads", "tasks",
			"reactions", "attachments", "reminders",
		},
		ReplyPolicy:  "mention_and_dm",
		RuntimeKind:  "codex",
		RuntimeModel: "default",
	}
}
