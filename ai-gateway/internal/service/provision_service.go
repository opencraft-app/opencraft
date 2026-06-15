package service

import (
	"fmt"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
	"github.com/google/uuid"
)

type ProvisionService struct {
	userSvc  *UserService
	subSvc   *SubscriptionService
	keySvc   *ApiKeyService
	planRepo repository.PlanRepo
}

func NewProvisionService(
	userSvc *UserService,
	subSvc *SubscriptionService,
	keySvc *ApiKeyService,
	planRepo repository.PlanRepo,
) *ProvisionService {
	return &ProvisionService{
		userSvc:  userSvc,
		subSvc:   subSvc,
		keySvc:   keySvc,
		planRepo: planRepo,
	}
}

// Provision 一键开通：通过 user_id 查找或创建用户，订阅套餐，并按需生成 API Key。
// userID 对应 User.UserID（业务系统用户标识）。找到则复用；找不到则创建新用户。
// periodStart 为 nil 时订阅起始时间为当前时间；非 nil 时使用指定时间（支持历史日期补录）。
func (s *ProvisionService) Provision(userID, phone, nickname, planID string, periodStart *time.Time, assignAPIKey bool) (*model.User, *model.Subscription, *string, error) {
	// 优先通过业务 user_id 查找用户
	user, err := s.userSvc.GetByUserID(userID)
	if err == nil {
		// 找到已有用户，直接复用
		return s.subscribeAndMaybeGenKey(user, planID, periodStart, assignAPIKey)
	}
	if err != model.ErrUserNotFound {
		return nil, nil, nil, fmt.Errorf("lookup user by user_id: %w", err)
	}

	// 找不到则创建新用户（User.ID 由 BeforeCreate 自动生成）
	user = &model.User{
		UserID:   userID,
		Nickname: nickname,
		Status:   model.UserStatusActive,
	}
	if phone != "" {
		if err := s.userSvc.SetPhoneFields(user, phone); err != nil {
			return nil, nil, nil, fmt.Errorf("set phone fields: %w", err)
		}
	}
	if err := s.userSvc.Create(user); err != nil {
		return nil, nil, nil, fmt.Errorf("create user: %w", err)
	}

	return s.subscribeAndMaybeGenKey(user, planID, periodStart, assignAPIKey)
}

// subscribeAndMaybeGenKey 订阅套餐，并按需生成 API Key。
func (s *ProvisionService) subscribeAndMaybeGenKey(user *model.User, planID string, periodStart *time.Time, assignAPIKey bool) (*model.User, *model.Subscription, *string, error) {
	planUUID, err := uuid.Parse(planID)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("invalid plan_id: %w", err)
	}
	plan, err := s.planRepo.GetByID(planUUID)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("get plan: %w", err)
	}

	sub, err := s.subSvc.Subscribe(user.ID, plan.ID, periodStart, 0, "")
	if err != nil {
		return nil, nil, nil, fmt.Errorf("subscribe: %w", err)
	}

	if !assignAPIKey {
		return user, sub, nil, nil
	}

	plainKey, _, err := s.keySvc.Generate(user.ID, "default")
	if err != nil {
		return nil, nil, nil, fmt.Errorf("generate api key: %w", err)
	}

	return user, sub, &plainKey, nil
}
