package context

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"go.uber.org/zap"
	"gorm.io/gorm"

	"ctl/pkg/resource"
)

const sqlCommentDefaultValue = "UNKNOWN"

// Context wraps request-scoped metadata used across logic, DAO and adapters.
type Context interface {
	context.Context

	WithRegion(region string) Context
	WithUserID(userID string) Context
	WithContext(ctx context.Context) Context

	GetUserID() string
	GetRegion() string
	GetLanguage() string
	GetRequestId() string

	Logger() *zap.Logger
	SetLogger(logger *zap.Logger)
	GormDB() *gorm.DB
	SetGormDB(db *gorm.DB)
	SetLanguage(language string)
	SetRequestId(requestID string)

	SetAction(action string)
	Action() string

	SetSqlCommentUserID(userID string)
	GetSqlCommentUserID() string

	WithSessionAuth(authorization, sessionCookie string) Context
	GetSessionAuthorization() string
	GetSessionCookie() string
}

type defaultContext struct {
	context.Context

	account  userInfo
	region   string
	language string

	requestId string

	logger     *zap.Logger
	baseLogger *zap.Logger
	gormDB     *gorm.DB

	action           string
	sqlCommentUserID string

	sessionAuthorization string
	sessionCookie        string
}

type userInfo struct {
	userID string
}

// NewContext creates a new project context from a standard library context.
func NewContext(base context.Context) Context {
	if base == nil {
		base = context.Background()
	}

	requestID := uuid.New().String()
	logger := resource.ZapLogger
	if logger == nil {
		logger = zap.NewNop()
	}
	logger = logger.With(zap.String("trace_id", requestID))

	return &defaultContext{
		Context:    base,
		requestId:  requestID,
		logger:     logger,
		baseLogger: logger,
	}
}

func (c *defaultContext) WithRegion(region string) Context {
	cc := c.copy()
	cc.region = region
	return cc
}

func (c *defaultContext) WithUserID(userID string) Context {
	cc := c.copy()
	cc.account = userInfo{
		userID: userID,
	}
	return cc
}

func (c *defaultContext) WithContext(ctx context.Context) Context {
	cc := c.copy()
	if ctx == nil {
		ctx = context.Background()
	}
	cc.Context = ctx
	return cc
}

func (c *defaultContext) GetUserID() string {
	return c.account.userID
}

func (c *defaultContext) GetRegion() string {
	return c.region
}

func (c *defaultContext) GetLanguage() string {
	return c.language
}

func (c *defaultContext) GetRequestId() string {
	return c.requestId
}

func (c *defaultContext) Logger() *zap.Logger {
	return c.logger
}

func (c *defaultContext) SetLogger(logger *zap.Logger) {
	c.logger = logger
	c.baseLogger = logger
}

func (c *defaultContext) GormDB() *gorm.DB {
	return c.gormDB
}

func (c *defaultContext) SetGormDB(db *gorm.DB) {
	c.gormDB = db
}

func (c *defaultContext) SetLanguage(language string) {
	c.language = language
}

func (c *defaultContext) SetRequestId(requestID string) {
	if requestID == "" {
		return
	}
	c.requestId = requestID
	logger := resource.ZapLogger
	if logger == nil {
		logger = zap.NewNop()
	}
	c.logger = logger.With(zap.String("trace_id", requestID))
	c.baseLogger = c.logger
	if c.action != "" {
		c.logger = c.logger.With(zap.String("action", c.action))
	}
}

func (c *defaultContext) WithSessionAuth(authorization, sessionCookie string) Context {
	cc := c.copy()
	cc.sessionAuthorization = strings.TrimSpace(authorization)
	cc.sessionCookie = strings.TrimSpace(sessionCookie)
	return cc
}

func (c *defaultContext) GetSessionAuthorization() string {
	return c.sessionAuthorization
}

func (c *defaultContext) GetSessionCookie() string {
	return c.sessionCookie
}

func (c *defaultContext) copy() *defaultContext {
	return &defaultContext{
		Context:              c.Context,
		account:              c.account,
		region:               c.region,
		language:             c.language,
		requestId:            c.requestId,
		logger:               c.logger,
		baseLogger:           c.baseLogger,
		gormDB:               c.gormDB,
		action:               c.action,
		sqlCommentUserID:     c.sqlCommentUserID,
		sessionAuthorization: c.sessionAuthorization,
		sessionCookie:        c.sessionCookie,
	}
}

func (c *defaultContext) SetAction(action string) {
	c.action = action
	if c.baseLogger == nil {
		return
	}
	c.logger = c.baseLogger
	if action != "" {
		c.logger = c.logger.With(zap.String("action", action))
	}
}

func (c *defaultContext) Action() string {
	return c.action
}

func (c *defaultContext) SetSqlCommentUserID(userID string) {
	c.sqlCommentUserID = userID
}

func (c *defaultContext) GetSqlCommentUserID() string {
	if c.sqlCommentUserID == "" {
		return sqlCommentDefaultValue
	}
	return c.sqlCommentUserID
}
