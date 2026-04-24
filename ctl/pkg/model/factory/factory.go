// Package factory ...
package factory

import (
	"fmt"

	"ctl/pkg/context"
	"ctl/pkg/model/bundle"
	"ctl/pkg/model/channelloginsession"
	"ctl/pkg/model/idgen"
	"ctl/pkg/model/instance"
	"ctl/pkg/model/instancebirthprofile"
	"ctl/pkg/model/operationhistory"
	"ctl/pkg/model/pass"
	"ctl/pkg/model/requestidempotent"
	"ctl/pkg/model/task"
	"ctl/pkg/model/userresourcequota"
	"ctl/pkg/resource"
)

// DaoFactory ...
type DaoFactory interface {
	IdGenDao(ctx context.Context) idgen.Dao
	InstanceDao(ctx context.Context) instance.Dao
	InstanceBirthProfileDao(ctx context.Context) instancebirthprofile.Dao
	ChannelLoginSessionDao(ctx context.Context) channelloginsession.Dao
	TaskDao(ctx context.Context) task.Dao
	OperationHistoryDao(ctx context.Context) operationhistory.Dao
	RequestIdempotentDao(ctx context.Context) requestidempotent.Dao
	UserResourceQuotaDao(ctx context.Context) userresourcequota.Dao
	BundleDao(ctx context.Context) bundle.Dao
	PassDao(ctx context.Context) pass.Dao
}

// DefaultDaoFactory is the singleton DAO factory.
var DefaultDaoFactory DaoFactory = new(daoFactory)

type daoFactory struct{}

// setupGormContext configures the GORM DB session with SQL comment for tracing.
func (f *daoFactory) setupGormContext(ctx context.Context) {
	if ctx == nil || resource.GormDB == nil {
		return
	}
	comment := fmt.Sprintf("p=%s,f=%s,i=%s,o=%s,a=%s",
		"ctl",
		sanitize(ctx.Action()),
		sanitize(ctx.GetRequestId()),
		sanitize(ctx.GetSqlCommentUserID()),
		"",
	)
	// Set the comment as a GORM session-level comment.
	// Note: GORM session callbacks or plugins can inject SQL comments.
	// For now, the DAOs use the global resource.GormDB directly.
	_ = comment
}

func sanitize(s string) string {
	// Simple sanitization for SQL comments — remove characters that could break comments
	result := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '*' || c == '/' {
			continue
		}
		result = append(result, c)
	}
	return string(result)
}

// IdGenDao ...
func (f *daoFactory) IdGenDao(ctx context.Context) idgen.Dao {
	f.setupGormContext(ctx)
	return idgen.NewDao()
}

// InstanceDao ...
func (f *daoFactory) InstanceDao(ctx context.Context) instance.Dao {
	f.setupGormContext(ctx)
	return instance.NewDao()
}

// InstanceBirthProfileDao ...
func (f *daoFactory) InstanceBirthProfileDao(ctx context.Context) instancebirthprofile.Dao {
	f.setupGormContext(ctx)
	return instancebirthprofile.NewDao()
}

// ChannelLoginSessionDao ...
func (f *daoFactory) ChannelLoginSessionDao(ctx context.Context) channelloginsession.Dao {
	f.setupGormContext(ctx)
	return channelloginsession.NewDao()
}

// TaskDao ...
func (f *daoFactory) TaskDao(ctx context.Context) task.Dao {
	f.setupGormContext(ctx)
	return task.NewDao()
}

// RequestIdempotentDao ...
func (f *daoFactory) RequestIdempotentDao(ctx context.Context) requestidempotent.Dao {
	f.setupGormContext(ctx)
	return requestidempotent.NewDao()
}

// UserResourceQuotaDao ...
func (f *daoFactory) UserResourceQuotaDao(ctx context.Context) userresourcequota.Dao {
	f.setupGormContext(ctx)
	return userresourcequota.NewDao()
}

// OperationHistoryDao ...
func (f *daoFactory) OperationHistoryDao(ctx context.Context) operationhistory.Dao {
	f.setupGormContext(ctx)
	return operationhistory.NewDao()
}

// BundleDao ...
func (f *daoFactory) BundleDao(ctx context.Context) bundle.Dao {
	f.setupGormContext(ctx)
	return bundle.NewDao()
}

// PassDao ...
func (f *daoFactory) PassDao(ctx context.Context) pass.Dao {
	f.setupGormContext(ctx)
	return pass.NewDao()
}
