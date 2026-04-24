package service

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/crypto"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
	"github.com/google/uuid"
)

type UserService struct {
	userRepo      repository.UserRepo
	apiKeySvc     *ApiKeyService
	encryptionKey []byte
}

const (
	EnsureUserResultCreated       = "created"
	EnsureUserResultAlreadyExists = "already_exists"
)

func NewUserService(userRepo repository.UserRepo, apiKeySvc *ApiKeyService, encryptionKey []byte) *UserService {
	return &UserService{
		userRepo:      userRepo,
		apiKeySvc:     apiKeySvc,
		encryptionKey: encryptionKey,
	}
}

// SetPhoneFields 设置用户的手机号相关字段（加密、哈希、脱敏）
func (s *UserService) SetPhoneFields(user *model.User, plainPhone string) error {
	encrypted, err := crypto.Encrypt(plainPhone, s.encryptionKey)
	if err != nil {
		return fmt.Errorf("encrypt phone: %w", err)
	}
	user.PhoneEncrypted = encrypted
	user.PhoneHash = crypto.HashPhone(plainPhone)
	user.PhoneMasked = crypto.MaskPhone(plainPhone)
	return nil
}

func (s *UserService) Create(user *model.User) error {
	return s.userRepo.Create(user)
}

// EnsureUser guarantees business user existence and owns any bootstrap
// normalization required to create a valid AI Gateway user. It is idempotent
// by business user_id and reports whether the user was newly created or already
// existed for the same user_id.
func (s *UserService) EnsureUser(userID, nickname string) (*model.User, string, error) {
	return s.EnsureUserWithPhone(userID, nickname, "")
}

// EnsureUserWithPhone shares the same idempotent ensure-user contract while
// allowing trusted internal callers to provide an explicit phone. When phone is
// empty, AI Gateway falls back to synthetic bootstrap fields internally.
func (s *UserService) EnsureUserWithPhone(userID, nickname, phone string) (*model.User, string, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return nil, "", errors.New("user_id is required")
	}

	existing, err := s.userRepo.GetByUserID(userID)
	if err == nil {
		return existing, EnsureUserResultAlreadyExists, nil
	}
	if !errors.Is(err, model.ErrUserNotFound) {
		return nil, "", fmt.Errorf("lookup user by user_id: %w", err)
	}

	normalizedNickname := strings.TrimSpace(nickname)
	if normalizedNickname == "" {
		normalizedNickname = userID
	}

	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		user := &model.User{
			UserID:   userID,
			Nickname: normalizedNickname,
			Status:   model.UserStatusActive,
		}
		bootstrapPhone := strings.TrimSpace(phone)
		if bootstrapPhone == "" {
			bootstrapPhone = syntheticPhoneForExternalUser(userID, attempt)
		}
		if err := s.SetPhoneFields(user, bootstrapPhone); err != nil {
			return nil, "", fmt.Errorf("set synthetic phone fields: %w", err)
		}
		if err := s.userRepo.Create(user); err == nil {
			return user, EnsureUserResultCreated, nil
		} else {
			lastErr = err
		}

		// Re-read after a failed create so duplicate races collapse into an
		// idempotent already_exists success for the same business user_id.
		if reread, rereadErr := s.userRepo.GetByUserID(userID); rereadErr == nil {
			return reread, EnsureUserResultAlreadyExists, nil
		} else if !errors.Is(rereadErr, model.ErrUserNotFound) {
			return nil, "", fmt.Errorf("re-read user by user_id after create failure: %w", rereadErr)
		}
	}

	return nil, "", fmt.Errorf("create ensured user: %w", lastErr)
}

func (s *UserService) GetByID(id uuid.UUID) (*model.User, error) {
	return s.userRepo.GetByID(id)
}

func (s *UserService) GetByPhone(phone string) (*model.User, error) {
	phoneHash := crypto.HashPhone(phone)
	return s.userRepo.GetByPhoneHash(phoneHash)
}

func (s *UserService) GetByUserID(userID string) (*model.User, error) {
	return s.userRepo.GetByUserID(userID)
}

func (s *UserService) Update(user *model.User) error {
	if err := s.userRepo.Update(user); err != nil {
		return err
	}
	// 清理该用户的 API Key 缓存
	if s.apiKeySvc != nil {
		_ = s.apiKeySvc.InvalidateCacheByUserID(user.ID)
	}
	return nil
}

func (s *UserService) SoftDelete(id uuid.UUID) error {
	if err := s.userRepo.SoftDelete(id); err != nil {
		return err
	}
	// 清理该用户的 API Key 缓存
	if s.apiKeySvc != nil {
		_ = s.apiKeySvc.InvalidateCacheByUserID(id)
	}
	return nil
}

func (s *UserService) List(offset, limit int, search string) ([]model.User, int64, error) {
	var phoneHash string
	if crypto.IsFullPhone(search) {
		phoneHash = crypto.HashPhone(search)
		search = ""
	}
	return s.userRepo.List(offset, limit, search, phoneHash)
}

func (s *UserService) CountAll() (int64, error) {
	return s.userRepo.CountAll()
}

func (s *UserService) CountByStatus(status string) (int64, error) {
	return s.userRepo.CountByStatus(status)
}

// ListWithActiveSubscription 返回用户列表及其活跃订阅和套餐信息（使用 LEFT JOIN 避免 N+1）
func (s *UserService) ListWithActiveSubscription(offset, limit int, search string, status string) ([]repository.UserWithSubRow, int64, error) {
	return s.userRepo.ListWithActiveSubscription(offset, limit, search, status)
}

func syntheticPhoneForExternalUser(externalUserID string, attempt int) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s#%d", strings.TrimSpace(externalUserID), attempt)))
	const modulus = uint64(10_000_000_000)
	digits := binary.BigEndian.Uint64(sum[:8]) % modulus
	return fmt.Sprintf("1%010d", digits)
}
