package service

import (
	"context"
	"time"
)

type memoryEmailBindToken struct {
	UserID        string
	Email         string
	TokenHash     string
	ExpiresAt     time.Time
	CooldownUntil time.Time
}

func (s *MemoryStore) RequestEmailBind(_ context.Context, token string, email string, tokenHash string, now time.Time, tokenTTL time.Duration, cooldown time.Duration) (time.Duration, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.sessions[token]
	if !ok || session.ExpiresAt.Before(now) {
		return 0, newError("unauthorized", "未登录或登录已失效。", 401)
	}
	user, ok := s.usersByID[session.UserID]
	if !ok {
		return 0, newError("unauthorized", "未登录或登录已失效。", 401)
	}
	if user.EmailVerified && user.Email != "" {
		return 0, newError("email_already_bound", "当前账号已绑定邮箱。", 409)
	}
	if existingID, exists := s.usersByEmail[email]; exists && existingID != user.ID {
		return 0, newError("email_in_use", "该邮箱已被其他账号使用。", 409)
	}

	for _, challenge := range s.emailBindTokens {
		if challenge.UserID == user.ID && challenge.CooldownUntil.After(now) {
			return 0, &Error{
				Code:       "email_bind_cooldown",
				Message:    "验证邮件发送过于频繁，请稍后再试。",
				Status:     429,
				RetryAfter: challenge.CooldownUntil.Sub(now),
			}
		}
	}

	s.emailBindTokens[user.ID] = memoryEmailBindToken{
		UserID:        user.ID,
		Email:         email,
		TokenHash:     tokenHash,
		ExpiresAt:     now.Add(tokenTTL),
		CooldownUntil: now.Add(cooldown),
	}
	s.emailBindByToken[tokenHash] = user.ID
	return cooldown, nil
}

func (s *MemoryStore) ConfirmEmailBind(_ context.Context, tokenHash string, now time.Time) (User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	userID, ok := s.emailBindByToken[tokenHash]
	if !ok {
		return User{}, newError("invalid_email_bind_token", "绑定链接无效或已过期。", 400)
	}
	challenge, ok := s.emailBindTokens[userID]
	if !ok || challenge.TokenHash != tokenHash {
		return User{}, newError("invalid_email_bind_token", "绑定链接无效或已过期。", 400)
	}
	if challenge.ExpiresAt.Before(now) {
		delete(s.emailBindTokens, userID)
		delete(s.emailBindByToken, tokenHash)
		return User{}, newError("email_bind_expired", "绑定链接已过期，请重新发送验证邮件。", 400)
	}
	if existingID, exists := s.usersByEmail[challenge.Email]; exists && existingID != userID {
		return User{}, newError("email_in_use", "该邮箱已被其他账号使用。", 409)
	}

	user, ok := s.usersByID[userID]
	if !ok {
		return User{}, newError("user_not_found", "用户不存在。", 404)
	}
	if user.Email != "" {
		delete(s.usersByEmail, user.Email)
	}
	user.Email = challenge.Email
	user.EmailVerified = true
	user.UpdatedAt = now
	s.usersByID[user.ID] = user
	s.usersByEmail[user.Email] = user.ID
	delete(s.emailBindTokens, userID)
	delete(s.emailBindByToken, tokenHash)
	return user, nil
}
