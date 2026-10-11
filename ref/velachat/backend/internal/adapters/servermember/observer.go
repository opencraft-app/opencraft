package servermember

import (
	"context"
	"errors"
	"time"

	appservermember "chatserver/internal/app/servermember"
	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/accountservermembership"
	"chatserver/internal/ent/server"
	"chatserver/internal/ent/tencentoperation"
	servermemberport "chatserver/internal/ports/servermember"
)

// CreationObserver 在有界窗口内轮询已提交的本地事实。
//
// 它不持有数据库事务，避免 SQLite 单 Writer 模式下阻塞异步 Worker。
type CreationObserver struct {
	handle       *database.Handle
	pollInterval time.Duration
}

// NewCreationObserver 创建 Server Community 创建结果观察器。
func NewCreationObserver(
	handle *database.Handle,
	pollInterval time.Duration,
) (*CreationObserver, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("创建结果观察器缺少数据库 Handle")
	}
	if pollInterval <= 0 {
		return nil, errors.New("创建结果观察器轮询间隔必须大于零")
	}
	return &CreationObserver{
		handle:       handle,
		pollInterval: pollInterval,
	}, nil
}

// Await 返回 operation 的终态，或在等待窗口耗尽时返回最新快照。
func (observer *CreationObserver) Await(
	ctx context.Context,
	accountID string,
	serverID string,
	operationID string,
	maxWait time.Duration,
) (appservermember.CreationObservation, error) {
	if maxWait <= 0 {
		return observer.observe(ctx, accountID, serverID, operationID)
	}

	deadline := time.NewTimer(maxWait)
	defer deadline.Stop()

	for {
		observation, err := observer.observe(
			ctx,
			accountID,
			serverID,
			operationID,
		)
		if err != nil || isTerminalOperation(observation.Operation.State) {
			return observation, err
		}

		poll := time.NewTimer(observer.pollInterval)
		select {
		case <-ctx.Done():
			stopAndDrainTimer(poll)
			return appservermember.CreationObservation{}, ctx.Err()
		case <-deadline.C:
			stopAndDrainTimer(poll)
			return observation, nil
		case <-poll.C:
		}
	}
}

func (observer *CreationObserver) observe(
	ctx context.Context,
	accountID string,
	serverID string,
	operationID string,
) (appservermember.CreationObservation, error) {
	authorized, err := observer.handle.Client().
		AccountServerMembership.
		Query().
		Where(
			accountservermembership.AccountIDEQ(accountID),
			accountservermembership.ServerIDEQ(serverID),
			accountservermembership.StatusEQ("active"),
		).
		Exist(ctx)
	if err != nil {
		return appservermember.CreationObservation{}, err
	}
	if !authorized {
		return appservermember.CreationObservation{},
			servermemberport.ErrServerNotFound
	}

	operationEntity, err := observer.handle.Client().TencentOperation.Query().
		Where(
			tencentoperation.IDEQ(operationID),
			tencentoperation.ServerIDEQ(serverID),
			tencentoperation.KindEQ("im.community.ensure"),
		).
		Only(ctx)
	if err != nil {
		return appservermember.CreationObservation{}, err
	}

	// 先读取 operation，再读取 Server，避免 Worker 恰好在两条查询之间
	// 提交时拼出“旧 Server + 终态 operation”的不一致快照。
	//
	// Worker 在同一事务内更新两者：若这里看到的是旧 operation，Await
	// 会继续轮询；若看到终态 operation，则随后读取的 Server 至少包含
	// 同一次已提交事务的投影。
	serverEntity, err := observer.handle.Client().Server.Query().
		Where(server.IDEQ(serverID)).
		Only(ctx)
	if ent.IsNotFound(err) {
		return appservermember.CreationObservation{},
			servermemberport.ErrServerNotFound
	}
	if err != nil {
		return appservermember.CreationObservation{}, err
	}

	lastErrorCode := ""
	if operationEntity.LastErrorCode != nil {
		lastErrorCode = *operationEntity.LastErrorCode
	}
	return appservermember.CreationObservation{
		Server: mapServer(serverEntity),
		Operation: appservermember.Operation{
			ID:            operationEntity.ID,
			Service:       operationEntity.Service,
			Kind:          operationEntity.Kind,
			State:         operationEntity.State,
			CreatedAt:     operationEntity.CreatedAt,
			CompletedAt:   operationEntity.CompletedAt,
			LastErrorCode: lastErrorCode,
		},
	}, nil
}

func isTerminalOperation(state string) bool {
	switch state {
	case "succeeded", "failed", "uncertain", "superseded":
		return true
	default:
		return false
	}
}

func stopAndDrainTimer(timer *time.Timer) {
	if timer.Stop() {
		return
	}
	select {
	case <-timer.C:
	default:
	}
}

var _ appservermember.CreationObserver = (*CreationObserver)(nil)
