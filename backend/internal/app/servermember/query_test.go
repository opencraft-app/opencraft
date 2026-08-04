package servermember

import (
	"context"
	"testing"
	"time"

	"chatserver/internal/apperror"
	servermemberport "chatserver/internal/ports/servermember"
)

type fakeQueryRepository struct {
	fakeCreateRepository
	page          servermemberport.ServerPage
	server        servermemberport.Server
	members       []servermemberport.Member
	member        servermemberport.Member
	memberPage    servermemberport.MemberPage
	memberOptions servermemberport.ListOptions
}

func (repository *fakeQueryRepository) ListServers(
	context.Context,
	string,
	servermemberport.ListOptions,
) (servermemberport.ServerPage, error) {
	return repository.page, nil
}

func TestMemberCursorIsBoundToAccountAndServer(t *testing.T) {
	now := time.Date(2026, 8, 2, 8, 0, 0, 123, time.UTC)
	nextID := testServiceIDs[1]
	repository := &fakeQueryRepository{memberPage: servermemberport.MemberPage{
		NextCreatedAt: &now, NextID: nextID,
	}}
	service, err := NewQueryService(repository)
	if err != nil {
		t.Fatal(err)
	}
	first, err := service.ListMembers(context.Background(), testServiceAccountID, testServiceIDs[0], servermemberport.ListOptions{Limit: 2})
	if err != nil || first.NextCursor == "" {
		t.Fatalf("first page = (%#v, %v)", first, err)
	}
	repository.memberPage = servermemberport.MemberPage{}
	if _, err := service.ListMembers(context.Background(), testServiceAccountID, testServiceIDs[0], servermemberport.ListOptions{Limit: 2, Cursor: first.NextCursor}); err != nil {
		t.Fatalf("second page error = %v", err)
	}
	if repository.memberOptions.AfterCreatedAt == nil || repository.memberOptions.AfterID != nextID {
		t.Fatalf("decoded options = %#v", repository.memberOptions)
	}
	_, err = service.ListMembers(context.Background(), testServiceAccountID, testServiceIDs[2], servermemberport.ListOptions{Limit: 2, Cursor: first.NextCursor})
	if got := apperror.CodeOf(err); got != "invalid_cursor" {
		t.Fatalf("changed-server cursor code = %q, error=%v", got, err)
	}
}
func (repository *fakeQueryRepository) GetServer(
	context.Context,
	string,
	string,
) (servermemberport.Server, error) {
	return repository.server, nil
}
func (repository *fakeQueryRepository) ListMembers(
	_ context.Context,
	_, _ string,
	options servermemberport.ListOptions,
) (servermemberport.MemberPage, error) {
	repository.memberOptions = options
	if repository.memberPage.NextID != "" {
		return repository.memberPage, nil
	}
	return servermemberport.MemberPage{Items: repository.members}, nil
}

func (repository *fakeQueryRepository) ListChannelMembers(
	context.Context,
	string,
	string,
	string,
	servermemberport.ListOptions,
) ([]servermemberport.Member, error) {
	return repository.members, nil
}
func (repository *fakeQueryRepository) GetMember(
	context.Context,
	string,
	string,
	string,
) (servermemberport.Member, error) {
	return repository.member, nil
}

func TestQueryServiceReturnsAuthorizedRepositoryFacts(t *testing.T) {
	repository := &fakeQueryRepository{
		page: servermemberport.ServerPage{
			Items: []servermemberport.Server{{ID: testServiceIDs[0]}},
		},
		server: servermemberport.Server{ID: testServiceIDs[0]},
		member: servermemberport.Member{
			ID:       testServiceIDs[1],
			ServerID: testServiceIDs[0],
		},
	}
	service, err := NewQueryService(repository)
	if err != nil {
		t.Fatal(err)
	}
	page, err := service.ListServers(
		context.Background(),
		testServiceAccountID,
		servermemberport.ListOptions{Limit: 20},
	)
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("ListServers() = (%#v, %v)", page, err)
	}
	value, err := service.GetServer(
		context.Background(),
		testServiceAccountID,
		testServiceIDs[0],
	)
	if err != nil || value.ID != testServiceIDs[0] {
		t.Fatalf("GetServer() = (%#v, %v)", value, err)
	}
	member, err := service.GetMember(
		context.Background(),
		testServiceAccountID,
		testServiceIDs[0],
		testServiceIDs[1],
	)
	if err != nil || member.ID != testServiceIDs[1] {
		t.Fatalf("GetMember() = (%#v, %v)", member, err)
	}
}
