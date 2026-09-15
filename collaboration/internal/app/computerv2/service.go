// Package computerv2 attaches existing LightVela instances to one Server.
package computerv2

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"

	"git.woa.com/wisp/mono2/collaboration/internal/apperror"
	"git.woa.com/wisp/mono2/collaboration/internal/pagination"
	clockport "git.woa.com/wisp/mono2/collaboration/internal/ports/clock"
	computerv2port "git.woa.com/wisp/mono2/collaboration/internal/ports/computerv2"
	idport "git.woa.com/wisp/mono2/collaboration/internal/ports/id"

	"github.com/google/uuid"
)

type AttachCommand struct {
	AccountID       string
	ExternalSubject string
	ServerID        string
	InstanceID      string
	Name            string
	IdempotencyKey  string
}

type ListOptions struct {
	Limit  int
	Cursor string
}

type Service struct {
	repository computerv2port.Repository
	instances  computerv2port.InstanceDirectory
	ids        idport.Generator
	clock      clockport.Clock
}

func (service *Service) List(
	ctx context.Context,
	accountID string,
	serverID string,
	options ListOptions,
) (computerv2port.Page, error) {
	accountID = strings.TrimSpace(accountID)
	serverID = strings.TrimSpace(serverID)
	if !validUUIDv7(accountID) || !validUUIDv7(serverID) || options.Limit < 0 || options.Limit > 100 {
		return computerv2port.Page{}, apperror.New("invalid_request", "ComputerV2 列表参数无效", nil)
	}
	repositoryOptions := computerv2port.ListOptions{Limit: options.Limit}
	filter := fmt.Sprintf("account=%s&server=%s&kind=lightvela_instance", accountID, serverID)
	if options.Cursor != "" {
		values, err := pagination.Decode(options.Cursor, "listComputersV2", filter, 1)
		if err != nil || !validUUIDv7(values[0]) {
			return computerv2port.Page{}, apperror.New("invalid_cursor", "ComputerV2 分页游标无效", err)
		}
		repositoryOptions.AfterID = values[0]
	}
	page, err := service.repository.List(ctx, accountID, serverID, repositoryOptions)
	if err != nil {
		switch {
		case errors.Is(err, computerv2port.ErrServerNotFound):
			return computerv2port.Page{}, apperror.New("server_not_found", "Server 不存在", err)
		default:
			return computerv2port.Page{}, apperror.New("internal_error", "暂时无法读取 Computer", err)
		}
	}
	if page.NextCursor != "" {
		page.NextCursor, err = pagination.Encode("listComputersV2", filter, page.NextCursor)
		if err != nil {
			return computerv2port.Page{}, apperror.New("internal_error", "暂时无法生成 Computer 分页游标", err)
		}
	}
	return page, nil
}

func NewService(
	repository computerv2port.Repository,
	instances computerv2port.InstanceDirectory,
	ids idport.Generator,
	clock clockport.Clock,
) (*Service, error) {
	if repository == nil || instances == nil || ids == nil || clock == nil {
		return nil, errors.New("ComputerV2 服务配置无效")
	}
	return &Service{repository: repository, instances: instances, ids: ids, clock: clock}, nil
}

func (service *Service) Attach(
	ctx context.Context,
	command AttachCommand,
) (computerv2port.Computer, error) {
	command.AccountID = strings.TrimSpace(command.AccountID)
	command.ExternalSubject = strings.TrimSpace(command.ExternalSubject)
	command.ServerID = strings.TrimSpace(command.ServerID)
	command.InstanceID = strings.TrimSpace(command.InstanceID)
	command.Name = strings.TrimSpace(command.Name)
	command.IdempotencyKey = strings.TrimSpace(command.IdempotencyKey)
	if !validUUIDv7(command.AccountID) || !validUUIDv7(command.ServerID) ||
		!strings.HasPrefix(command.ExternalSubject, "usr_") ||
		command.InstanceID == "" || len(command.InstanceID) > 128 ||
		command.IdempotencyKey == "" {
		return computerv2port.Computer{}, apperror.New("invalid_request", "ComputerV2 创建参数无效", nil)
	}
	owned, err := service.instances.ListOwned(ctx, command.ExternalSubject)
	if err != nil {
		return computerv2port.Computer{}, apperror.New("computer_instance_unavailable", "暂时无法读取 LightVela 实例", err)
	}
	var selected *computerv2port.Instance
	for index := range owned {
		if strings.TrimSpace(owned[index].ID) == command.InstanceID {
			selected = &owned[index]
			break
		}
	}
	if selected == nil {
		return computerv2port.Computer{}, apperror.New("computer_instance_not_owned", "LightVela 实例不属于当前账号", nil)
	}
	status := strings.ToLower(strings.TrimSpace(selected.Status))
	if status == "deleted" || status == "deleting" || status == "unknown" || status == "" {
		return computerv2port.Computer{}, apperror.New("computer_instance_unavailable", "LightVela 实例当前不可作为 Computer", nil)
	}
	computerID, err := service.ids.New()
	if err != nil {
		return computerv2port.Computer{}, apperror.New("internal_error", "暂时无法创建 Computer", err)
	}
	name := command.Name
	if name == "" {
		name = strings.TrimSpace(selected.Name)
	}
	if name == "" {
		name = "LightVela Computer"
	}
	if len(name) > 100 {
		return computerv2port.Computer{}, apperror.New("invalid_request", "Computer 名称过长", nil)
	}
	attached, err := service.repository.Attach(ctx, computerv2port.AttachCommand{
		AccountID:      command.AccountID,
		ServerID:       command.ServerID,
		IdempotencyKey: command.IdempotencyKey,
		RequestHash: sha256.Sum256([]byte(strings.Join([]string{
			command.AccountID, command.ServerID, command.InstanceID, name,
		}, "\x00"))),
		CreatedAt: service.clock.Now().UTC(),
		Computer: computerv2port.Draft{
			ID:             computerID,
			Kind:           "lightvela_instance",
			InstanceID:     command.InstanceID,
			Name:           name,
			LifecycleState: "active",
		},
	})
	if err != nil {
		switch {
		case errors.Is(err, computerv2port.ErrInstanceAlreadyAttached):
			return computerv2port.Computer{}, apperror.New("computer_instance_already_attached", "LightVela 实例已归属其他 Server", err)
		case errors.Is(err, computerv2port.ErrAdminRequired):
			return computerv2port.Computer{}, apperror.New("permission_denied", "需要 Server 管理权限", err)
		case errors.Is(err, computerv2port.ErrServerNotFound):
			return computerv2port.Computer{}, apperror.New("server_not_found", "Server 不存在", err)
		case errors.Is(err, computerv2port.ErrIdempotencyConflict):
			return computerv2port.Computer{}, apperror.New("idempotency_conflict", "幂等键与原请求不一致", err)
		default:
			return computerv2port.Computer{}, apperror.New("internal_error", "暂时无法创建 Computer", err)
		}
	}
	attached.ObservedState = status
	return attached, nil
}

func validUUIDv7(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.Version() == 7
}
