package bootstrap

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	credentialsadapter "chatserver/internal/adapters/credentials"
	"chatserver/internal/api/openapi"
	computerport "chatserver/internal/ports/computer"
	tencentimport "chatserver/internal/ports/tencentim"
	tencenttatport "chatserver/internal/ports/tencenttat"
)

type platformTATRegistrar struct{}

type platformArtifactSigner struct{}

func (platformArtifactSigner) PresignGet(context.Context, string, time.Duration) (string, error) {
	return "https://artifact.example.test/signed", nil
}

func platformEnrollmentRelease() computerport.ReleaseBinding {
	return computerport.ReleaseBinding{
		Version: "0.1.0", Target: "darwin-arm64", OSType: "macos", Architecture: "arm64",
		SigningKeyID: "test-key",
		Manifest:     computerport.ArtifactBinding{ObjectKey: "computer/releases/0.1.0/manifest.json", SHA256: sha256.Sum256([]byte("manifest")), Size: 1},
		Signature:    computerport.ArtifactBinding{ObjectKey: "computer/releases/0.1.0/manifest.sig", SHA256: sha256.Sum256([]byte("signature")), Size: 1},
		Installer:    computerport.ArtifactBinding{ObjectKey: "computer/releases/0.1.0/darwin-arm64/install.sh", SHA256: sha256.Sum256([]byte("installer")), Size: 1},
		Program:      computerport.ArtifactBinding{ObjectKey: "computer/releases/0.1.0/darwin-arm64/vela-computer", SHA256: sha256.Sum256([]byte("program")), Size: 1},
	}
}

func (platformTATRegistrar) CreateRegistration(
	context.Context,
	tencenttatport.RegistrationRequest,
) (tencenttatport.Registration, error) {
	return tencenttatport.Registration{}, nil
}

func (platformTATRegistrar) Issue(
	context.Context,
	tencenttatport.TerminalTarget,
) (tencenttatport.TerminalSession, error) {
	return tencenttatport.TerminalSession{
		SessionID:      "terminal-session-1",
		WebSocketURL:   "wss://terminal.example.test/connect",
		ExpiresAt:      time.Now().UTC().Add(5 * time.Minute),
		OwnerUIN:       "100000000001",
		AppID:          1250000000,
		InstanceID:     "ins-test0001",
		Cols:           120,
		Rows:           40,
		MaxIdleSeconds: 600,
	}, nil
}

func (platformTATRegistrar) FindManagedByComputerTag(
	context.Context,
	string,
	string,
) (tencenttatport.ManagedInstance, bool, error) {
	return tencenttatport.ManagedInstance{}, false, nil
}

func TestPlatformAPIExposesAuthenticatedServerCreateAndQueries(t *testing.T) {
	handle := openHumanAPIDatabase(t)
	issuer := &recordingUserSigIssuer{result: tencentimport.UserSig{
		Value:     "short-lived-user-sig",
		ExpiresAt: time.Now().Add(time.Hour),
	}}
	handler, err := NewPlatformAPIHandler(PlatformAPIConfig{
		Human: HumanAPIConfig{
			Auth: AuthAPIConfig{
				Database:       handle,
				AccessTokenKey: bytes.Repeat([]byte{0x52}, 32),
				Password:       credentialsadapter.TestArgon2idConfig(),
				AccessTTL:      15 * time.Minute,
				RefreshTTL:     30 * 24 * time.Hour,
				RequestTimeout: 5 * time.Second,
				MaxBodyBytes:   16 * 1024,
			},
			SDKAppID:      1600000000,
			UserSigTTL:    time.Hour,
			UserSigIssuer: issuer,
		},
		IMResourceKey:            bytes.Repeat([]byte{0x53}, 32),
		ServerCreationWait:       time.Millisecond,
		TATRegistrar:             platformTATRegistrar{},
		TATManagedInstanceFinder: platformTATRegistrar{},
		TerminalIssuer:           platformTATRegistrar{},
		ComputerEnrollment: &ComputerEnrollmentAPIConfig{
			Release: platformEnrollmentRelease(), PlatformBaseURL: "https://platform.example.test",
			TokenTTL: 15 * time.Minute, CredentialTTL: 24 * time.Hour,
			ArtifactURLTTL: 5 * time.Minute, ArtifactSigner: platformArtifactSigner{},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	registered := performJSON(
		t,
		handler,
		http.MethodPost,
		"/v1/auth/register",
		map[string]any{
			"email":       "owner@example.com",
			"password":    "password-123",
			"displayName": "所有者",
		},
		"",
	)
	if registered.Code != http.StatusCreated {
		t.Fatalf("register = %d %s", registered.Code, registered.Body)
	}
	auth := decodeAuthResult(t, registered)
	targets := performJSON(
		t, handler, http.MethodGet, "/v1/computer-installation-targets", nil, *auth.AccessToken,
	)
	if targets.Code != http.StatusOK {
		t.Fatalf("installation targets = %d %s", targets.Code, targets.Body)
	}
	if _, err := handle.Client().Account.UpdateOneID(auth.Account.Id.String()).
		SetImUserID("u_OWNER").
		SetImState("ready").
		AddRevision(1).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}

	create := platformJSON(
		t,
		handler,
		http.MethodPost,
		"/v1/servers",
		map[string]any{"slug": "agent-lab", "name": "Agent 实验室"},
		*auth.AccessToken,
		"server-create-0001",
	)
	if create.Code != http.StatusAccepted {
		t.Fatalf("create = %d %s", create.Code, create.Body)
	}
	var accepted openapi.AcceptedResource
	if err := json.Unmarshal(create.Body.Bytes(), &accepted); err != nil {
		t.Fatal(err)
	}
	if len(accepted.Operations) != 1 {
		t.Fatalf("accepted = %#v", accepted)
	}
	list := performJSON(
		t,
		handler,
		http.MethodGet,
		"/v1/servers",
		nil,
		*auth.AccessToken,
	)
	if list.Code != http.StatusOK {
		t.Fatalf("list = %d %s", list.Code, list.Body)
	}
	var page openapi.ListServers200JSONResponse
	if err := json.Unmarshal(list.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 ||
		page.Items[0].Id != accepted.ResourceId {
		t.Fatalf("page = %#v", page)
	}
	updateServer := platformRevisionJSON(
		t,
		handler,
		http.MethodPatch,
		"/v1/servers/"+accepted.ResourceId.String(),
		map[string]any{
			"name":        "Vela 研究实验室",
			"description": "协作与运行时研究",
		},
		*auth.AccessToken,
		"server-update-0001",
		uint64(page.Items[0].Revision),
	)
	if updateServer.Code != http.StatusOK {
		t.Fatalf(
			"update server = %d %s",
			updateServer.Code,
			updateServer.Body,
		)
	}
	var updatedServer openapi.Server
	if err := json.Unmarshal(updateServer.Body.Bytes(), &updatedServer); err != nil {
		t.Fatal(err)
	}
	if updatedServer.Name != "Vela 研究实验室" ||
		updatedServer.Description == nil ||
		*updatedServer.Description != "协作与运行时研究" ||
		uint64(updatedServer.Revision) != uint64(page.Items[0].Revision)+1 {
		t.Fatalf("updated server = %#v", updatedServer)
	}
	createInvite := performJSON(
		t,
		handler,
		http.MethodPost,
		"/v1/servers/"+accepted.ResourceId.String()+"/invites",
		map[string]any{
			"role":      "member",
			"maxUses":   3,
			"expiresAt": time.Now().UTC().Add(time.Hour),
		},
		*auth.AccessToken,
	)
	if createInvite.Code != http.StatusCreated {
		t.Fatalf(
			"create invite = %d %s",
			createInvite.Code,
			createInvite.Body,
		)
	}
	if createInvite.Header().Get("Cache-Control") != "no-store" ||
		createInvite.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("create invite headers = %#v", createInvite.Header())
	}
	var inviteSecret openapi.InviteSecret
	if err := json.Unmarshal(
		createInvite.Body.Bytes(),
		&inviteSecret,
	); err != nil {
		t.Fatal(err)
	}
	if inviteSecret.Token == nil ||
		*inviteSecret.Token == "" ||
		inviteSecret.Invite.ServerId != accepted.ResourceId {
		t.Fatalf("invite secret = %#v", inviteSecret)
	}
	listInvites := performJSON(
		t,
		handler,
		http.MethodGet,
		"/v1/servers/"+accepted.ResourceId.String()+"/invites",
		nil,
		*auth.AccessToken,
	)
	if listInvites.Code != http.StatusOK {
		t.Fatalf(
			"list invites = %d %s",
			listInvites.Code,
			listInvites.Body,
		)
	}
	var invites openapi.ListInvites200JSONResponse
	if err := json.Unmarshal(listInvites.Body.Bytes(), &invites); err != nil {
		t.Fatal(err)
	}
	if len(invites) != 1 || invites[0].Id != inviteSecret.Invite.Id {
		t.Fatalf("invites = %#v", invites)
	}
	revokeInvite := performJSON(
		t,
		handler,
		http.MethodDelete,
		"/v1/servers/"+accepted.ResourceId.String()+"/invites/"+
			inviteSecret.Invite.Id.String(),
		nil,
		*auth.AccessToken,
	)
	if revokeInvite.Code != http.StatusNoContent {
		t.Fatalf(
			"revoke invite = %d %s",
			revokeInvite.Code,
			revokeInvite.Body,
		)
	}
	if _, err := handle.Client().Server.UpdateOneID(
		accepted.ResourceId.String(),
	).
		SetImState("ready").
		AddRevision(1).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	createChannel := platformJSON(
		t,
		handler,
		http.MethodPost,
		"/v1/servers/"+accepted.ResourceId.String()+"/channels",
		map[string]any{
			"name":        "研发",
			"description": "研发协作",
			"visibility":  "private",
		},
		*auth.AccessToken,
		"channel-create-0001",
	)
	if createChannel.Code != http.StatusAccepted {
		t.Fatalf(
			"create channel = %d %s",
			createChannel.Code,
			createChannel.Body,
		)
	}
	var acceptedChannel openapi.AcceptedResource
	if err := json.Unmarshal(
		createChannel.Body.Bytes(),
		&acceptedChannel,
	); err != nil {
		t.Fatal(err)
	}
	listChannels := performJSON(
		t,
		handler,
		http.MethodGet,
		"/v1/servers/"+accepted.ResourceId.String()+"/channels",
		nil,
		*auth.AccessToken,
	)
	if listChannels.Code != http.StatusOK {
		t.Fatalf(
			"list channels = %d %s",
			listChannels.Code,
			listChannels.Body,
		)
	}
	var channels openapi.ListChannels200JSONResponse
	if err := json.Unmarshal(listChannels.Body.Bytes(), &channels); err != nil {
		t.Fatal(err)
	}
	var createdChannel *openapi.Channel
	for index := range channels {
		if channels[index].Id == acceptedChannel.ResourceId {
			createdChannel = &channels[index]
			break
		}
	}
	if createdChannel == nil || createdChannel.ImTopicId == nil {
		t.Fatalf("channels = %#v", channels)
	}
	updateChannelBody, err := json.Marshal(map[string]any{
		"name":        "产品研发",
		"description": "产品研发协作",
	})
	if err != nil {
		t.Fatal(err)
	}
	updateChannelRequest := httptest.NewRequest(
		http.MethodPatch,
		"/v1/servers/"+accepted.ResourceId.String()+"/channels/"+
			createdChannel.Id.String(),
		bytes.NewReader(updateChannelBody),
	)
	updateChannelRequest.Header.Set("Content-Type", "application/json")
	updateChannelRequest.Header.Set(
		"Authorization",
		"Bearer "+*auth.AccessToken,
	)
	updateChannelRequest.Header.Set(
		"X-Resource-Revision",
		strconv.FormatInt(createdChannel.Revision, 10),
	)
	updateChannelRequest.Header.Set(
		"Idempotency-Key",
		"channel-update-0001",
	)
	updateChannel := httptest.NewRecorder()
	handler.ServeHTTP(updateChannel, updateChannelRequest)
	if updateChannel.Code != http.StatusOK {
		t.Fatalf(
			"update channel = %d %s",
			updateChannel.Code,
			updateChannel.Body,
		)
	}
	var updatedChannel openapi.Channel
	if err := json.Unmarshal(
		updateChannel.Body.Bytes(),
		&updatedChannel,
	); err != nil {
		t.Fatal(err)
	}
	if updatedChannel.Name != "产品研发" ||
		updatedChannel.Revision != createdChannel.Revision+1 {
		t.Fatalf("updated channel = %#v", updatedChannel)
	}
	createComputer := platformJSON(
		t,
		handler,
		http.MethodPost,
		"/v1/servers/"+accepted.ResourceId.String()+"/computers",
		map[string]any{"name": "北京执行机"},
		*auth.AccessToken,
		"computer-create-0001",
	)
	if createComputer.Code != http.StatusCreated {
		t.Fatalf(
			"create computer = %d %s",
			createComputer.Code,
			createComputer.Body,
		)
	}
	var computer openapi.Computer
	if err := json.Unmarshal(createComputer.Body.Bytes(), &computer); err != nil {
		t.Fatal(err)
	}
	createManagedComputer := platformJSON(
		t,
		handler,
		http.MethodPost,
		"/v1/servers/"+accepted.ResourceId.String()+"/computers",
		map[string]any{"name": "后台托管机"},
		*auth.AccessToken,
		"computer-create-managed-0001",
	)
	if createManagedComputer.Code != http.StatusCreated {
		t.Fatalf(
			"create managed computer = %d %s",
			createManagedComputer.Code,
			createManagedComputer.Body,
		)
	}
	var managedComputer openapi.Computer
	if err := json.Unmarshal(
		createManagedComputer.Body.Bytes(),
		&managedComputer,
	); err != nil {
		t.Fatal(err)
	}
	if managedComputer.OsType != "macos" || managedComputer.LifecycleState != "provisioning" {
		t.Fatalf("managed computer = %#v", managedComputer)
	}
	releaseManagedComputer := platformJSON(
		t,
		handler,
		http.MethodDelete,
		"/v1/servers/"+accepted.ResourceId.String()+"/computers/"+
			managedComputer.Id.String(),
		nil,
		*auth.AccessToken,
		"computer-release-managed-0001",
	)
	if releaseManagedComputer.Code != http.StatusNoContent {
		t.Fatalf(
			"release managed computer = %d %s",
			releaseManagedComputer.Code,
			releaseManagedComputer.Body,
		)
	}
	managedWithClientRegion := platformJSON(
		t,
		handler,
		http.MethodPost,
		"/v1/servers/"+accepted.ResourceId.String()+"/computers",
		map[string]any{
			"name":            "错误选区托管机",
			"tatRegion":       "ap-guangzhou",
			"tatInstanceKind": "managed",
			"osType":          "linux",
		},
		*auth.AccessToken,
		"computer-create-managed-0002",
	)
	if managedWithClientRegion.Code != http.StatusBadRequest {
		t.Fatalf(
			"managed client region = %d %s",
			managedWithClientRegion.Code,
			managedWithClientRegion.Body,
		)
	}
	if _, err := handle.Client().Computer.UpdateOneID(computer.Id.String()).
		SetLifecycleState("active").
		SetTatInstanceID("ins-test0001").
		SetTatAgentState("online").
		SetHostLastSeenAt(time.Now().UTC().Add(-time.Second)).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	listComputers := performJSON(
		t,
		handler,
		http.MethodGet,
		"/v1/servers/"+accepted.ResourceId.String()+"/computers",
		nil,
		*auth.AccessToken,
	)
	if listComputers.Code != http.StatusOK {
		t.Fatalf(
			"list computers = %d %s",
			listComputers.Code,
			listComputers.Body,
		)
	}
	terminal := performJSON(
		t,
		handler,
		http.MethodPost,
		"/v1/servers/"+accepted.ResourceId.String()+
			"/computers/"+computer.Id.String()+"/terminal-sessions",
		nil,
		*auth.AccessToken,
	)
	if terminal.Code != http.StatusCreated ||
		terminal.Header().Get("Cache-Control") != "no-store" ||
		terminal.Header().Get("Pragma") != "no-cache" {
		t.Fatalf(
			"terminal session = %d %s headers=%#v",
			terminal.Code,
			terminal.Body,
			terminal.Header(),
		)
	}
	createAgent := platformJSON(
		t,
		handler,
		http.MethodPost,
		"/v1/servers/"+accepted.ResourceId.String()+"/agents",
		map[string]any{
			"displayName": "小舟",
			"handle":      "xiaozhou",
			"computerId":  computer.Id.String(),
			"runtime": map[string]any{
				"kind": "codex",
			},
		},
		*auth.AccessToken,
		"agent-create-0001",
	)
	if createAgent.Code != http.StatusAccepted {
		t.Fatalf(
			"create agent = %d %s",
			createAgent.Code,
			createAgent.Body,
		)
	}
	var acceptedAgent openapi.AcceptedResource
	if err := json.Unmarshal(
		createAgent.Body.Bytes(),
		&acceptedAgent,
	); err != nil {
		t.Fatal(err)
	}
	getOperation := performJSON(
		t,
		handler,
		http.MethodGet,
		"/v1/servers/"+accepted.ResourceId.String()+
			"/operations/"+acceptedAgent.Operations[0].Id.String(),
		nil,
		*auth.AccessToken,
	)
	if getOperation.Code != http.StatusOK {
		t.Fatalf(
			"get operation = %d %s",
			getOperation.Code,
			getOperation.Body,
		)
	}
	if _, err := handle.Client().Agent.UpdateOneID(
		acceptedAgent.ResourceId.String(),
	).
		SetImState("ready").
		AddRevision(1).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Member.UpdateOneID(
		acceptedAgent.ResourceId.String(),
	).
		SetImState("ready").
		AddRevision(1).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	rotate := platformJSON(
		t,
		handler,
		http.MethodPost,
		"/v1/servers/"+accepted.ResourceId.String()+
			"/agents/"+acceptedAgent.ResourceId.String()+
			"/credentials/rotate",
		nil,
		*auth.AccessToken,
		"agent-credential-0001",
	)
	if rotate.Code != http.StatusAccepted {
		t.Fatalf("rotate credential = %d %s", rotate.Code, rotate.Body)
	}
	listAgents := performJSON(
		t,
		handler,
		http.MethodGet,
		"/v1/servers/"+accepted.ResourceId.String()+"/agents",
		nil,
		*auth.AccessToken,
	)
	if listAgents.Code != http.StatusOK {
		t.Fatalf("list agents = %d %s", listAgents.Code, listAgents.Body)
	}
	var agents openapi.ListAgents200JSONResponse
	if err := json.Unmarshal(listAgents.Body.Bytes(), &agents); err != nil {
		t.Fatal(err)
	}
	if len(agents) != 1 ||
		agents[0].Id != acceptedAgent.ResourceId ||
		agents[0].ImUserId == "" {
		t.Fatalf("agents = %#v", agents)
	}
	createTask := platformJSON(
		t,
		handler,
		http.MethodPost,
		"/v1/servers/"+accepted.ResourceId.String()+"/tasks",
		map[string]any{"title": "完成首版 TUI"},
		*auth.AccessToken,
		"task-create-0001",
	)
	if createTask.Code != http.StatusCreated {
		t.Fatalf("create task = %d %s", createTask.Code, createTask.Body)
	}
	var task openapi.Task
	if err := json.Unmarshal(createTask.Body.Bytes(), &task); err != nil {
		t.Fatal(err)
	}
	inbox := performJSON(
		t,
		handler,
		http.MethodGet,
		"/v1/servers/"+accepted.ResourceId.String()+"/inbox",
		nil,
		*auth.AccessToken,
	)
	if inbox.Code != http.StatusOK {
		t.Fatalf("list inbox = %d %s", inbox.Code, inbox.Body)
	}
	var inboxItems openapi.ListInbox200JSONResponse
	if err := json.Unmarshal(inbox.Body.Bytes(), &inboxItems); err != nil {
		t.Fatal(err)
	}
	if len(inboxItems) != 0 {
		t.Fatalf("inbox = %#v", inboxItems)
	}
	createReminder := platformJSON(
		t,
		handler,
		http.MethodPost,
		"/v1/servers/"+accepted.ResourceId.String()+"/reminders",
		map[string]any{
			"agentId":      acceptedAgent.ResourceId.String(),
			"scheduleKind": "once",
			"schedule":     time.Now().UTC().Add(time.Hour).Format(time.RFC3339),
			"timezone":     "Asia/Shanghai",
			"text":         "汇报首版进度",
		},
		*auth.AccessToken,
		"reminder-create-0001",
	)
	if createReminder.Code != http.StatusCreated {
		t.Fatalf(
			"create reminder = %d %s",
			createReminder.Code,
			createReminder.Body,
		)
	}
	activity := performJSON(
		t,
		handler,
		http.MethodGet,
		"/v1/servers/"+accepted.ResourceId.String()+"/activity",
		nil,
		*auth.AccessToken,
	)
	if activity.Code != http.StatusOK {
		t.Fatalf("list activity = %d %s", activity.Code, activity.Body)
	}
	var activityItems openapi.ListActivity200JSONResponse
	if err := json.Unmarshal(activity.Body.Bytes(), &activityItems); err != nil {
		t.Fatal(err)
	}
	if len(activityItems) != 2 {
		t.Fatalf("activity = %#v", activityItems)
	}
	var rootChannel *openapi.Channel
	for index := range channels {
		if channels[index].SystemKey != nil &&
			*channels[index].SystemKey == openapi.All {
			rootChannel = &channels[index]
			break
		}
	}
	if rootChannel == nil {
		t.Fatalf("root channel missing: %#v", channels)
	}
	listChannelMembers := performJSON(
		t,
		handler,
		http.MethodGet,
		"/v1/servers/"+accepted.ResourceId.String()+
			"/channels/"+rootChannel.Id.String()+"/members",
		nil,
		*auth.AccessToken,
	)
	if listChannelMembers.Code != http.StatusOK {
		t.Fatalf(
			"list channel members = %d %s",
			listChannelMembers.Code,
			listChannelMembers.Body,
		)
	}
	var channelMembers openapi.ListChannelMembers200JSONResponse
	if err := json.Unmarshal(
		listChannelMembers.Body.Bytes(),
		&channelMembers,
	); err != nil {
		t.Fatal(err)
	}
	if len(channelMembers) != 2 {
		t.Fatalf("channel members = %#v", channelMembers)
	}
	var agentMember *openapi.Member
	for index := range channelMembers {
		if channelMembers[index].Id == acceptedAgent.ResourceId {
			agentMember = &channelMembers[index]
			break
		}
	}
	if agentMember == nil ||
		agentMember.ImUserId == nil ||
		*agentMember.ImUserId != agents[0].ImUserId {
		t.Fatalf("agent channel member = %#v", agentMember)
	}
	joinerRegistration := performJSON(
		t,
		handler,
		http.MethodPost,
		"/v1/auth/register",
		map[string]any{
			"email":       "joiner@example.com",
			"password":    "password-456",
			"displayName": "加入者",
		},
		"",
	)
	if joinerRegistration.Code != http.StatusCreated {
		t.Fatalf(
			"joiner register = %d %s",
			joinerRegistration.Code,
			joinerRegistration.Body,
		)
	}
	joinerAuth := decodeAuthResult(t, joinerRegistration)
	if _, err := handle.Client().Account.UpdateOneID(
		joinerAuth.Account.Id.String(),
	).
		SetImUserID("u_JOINER").
		SetImState("ready").
		AddRevision(1).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	secondInvite := performJSON(
		t,
		handler,
		http.MethodPost,
		"/v1/servers/"+accepted.ResourceId.String()+"/invites",
		map[string]any{
			"role":      "member",
			"maxUses":   1,
			"expiresAt": time.Now().UTC().Add(time.Hour),
		},
		*auth.AccessToken,
	)
	if secondInvite.Code != http.StatusCreated {
		t.Fatalf(
			"second invite = %d %s",
			secondInvite.Code,
			secondInvite.Body,
		)
	}
	var secondSecret openapi.InviteSecret
	if err := json.Unmarshal(
		secondInvite.Body.Bytes(),
		&secondSecret,
	); err != nil {
		t.Fatal(err)
	}
	acceptInvite := platformJSON(
		t,
		handler,
		http.MethodPost,
		"/v1/invites/accept",
		map[string]any{"token": *secondSecret.Token},
		*joinerAuth.AccessToken,
		"invite-accept-0001",
	)
	if acceptInvite.Code != http.StatusAccepted {
		t.Fatalf(
			"accept invite = %d %s",
			acceptInvite.Code,
			acceptInvite.Body,
		)
	}
	var acceptedMember openapi.AcceptedResource
	if err := json.Unmarshal(
		acceptInvite.Body.Bytes(),
		&acceptedMember,
	); err != nil {
		t.Fatal(err)
	}
	if len(acceptedMember.Operations) != 1 ||
		acceptedMember.Operations[0].Kind != "im.membership.ensure" {
		t.Fatalf("accepted member = %#v", acceptedMember)
	}
	joinLinkReplay := platformJSON(
		t,
		handler,
		http.MethodPost,
		"/v1/join-links/accept",
		map[string]any{"token": *secondSecret.Token},
		*joinerAuth.AccessToken,
		"join-link-replay-0001",
	)
	if joinLinkReplay.Code != http.StatusOK {
		t.Fatalf(
			"join link replay = %d %s",
			joinLinkReplay.Code,
			joinLinkReplay.Body,
		)
	}
	var joined openapi.JoinResult
	if err := json.Unmarshal(joinLinkReplay.Body.Bytes(), &joined); err != nil {
		t.Fatal(err)
	}
	if joined.ServerId != accepted.ResourceId ||
		joined.MemberId != acceptedMember.ResourceId ||
		joined.LandingChannelId.Version() != 7 {
		t.Fatalf("join result = %#v", joined)
	}
	joinerServers := performJSON(
		t,
		handler,
		http.MethodGet,
		"/v1/servers",
		nil,
		*joinerAuth.AccessToken,
	)
	if joinerServers.Code != http.StatusOK {
		t.Fatalf(
			"joiner servers = %d %s",
			joinerServers.Code,
			joinerServers.Body,
		)
	}
}

func platformJSON(
	t *testing.T,
	handler http.Handler,
	method string,
	path string,
	body any,
	bearer string,
	idempotencyKey string,
) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(data))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+bearer)
	request.Header.Set("Idempotency-Key", idempotencyKey)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func platformRevisionJSON(
	t *testing.T,
	handler http.Handler,
	method string,
	path string,
	body any,
	bearer string,
	idempotencyKey string,
	revision uint64,
) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(data))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+bearer)
	request.Header.Set("Idempotency-Key", idempotencyKey)
	request.Header.Set("X-Resource-Revision", strconv.FormatUint(revision, 10))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
