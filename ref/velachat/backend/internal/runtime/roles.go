// Package runtime 编排 API、Worker、Scheduler 与数据库 Handle 的共同生命周期。
package runtime

import (
	"sort"

	"chatserver/internal/apperror"
)

// DatabaseMode 决定允许的进程角色拓扑。
type DatabaseMode string

const (
	DatabaseModeSQLite DatabaseMode = "sqlite"
	DatabaseModeTDSQL  DatabaseMode = "tdsql"
)

// Role 是后台进程内的运行角色。
type Role string

const (
	RoleAPI       Role = "api"
	RoleWorker    Role = "worker"
	RoleScheduler Role = "scheduler"
)

// RoleSet 是构造后不可变的角色集合。
type RoleSet struct {
	values map[Role]struct{}
}

// NewRoleSet 创建去重且只包含已知角色的集合。
func NewRoleSet(roles ...Role) (RoleSet, error) {
	values := make(map[Role]struct{}, len(roles))
	for _, role := range roles {
		if !validRole(role) {
			return RoleSet{}, invalidRoleTopology()
		}
		if _, exists := values[role]; exists {
			return RoleSet{}, invalidRoleTopology()
		}
		values[role] = struct{}{}
	}
	if len(values) == 0 {
		return RoleSet{}, invalidRoleTopology()
	}
	return RoleSet{values: values}, nil
}

// Has 报告集合是否包含角色。
func (roles RoleSet) Has(role Role) bool {
	_, ok := roles.values[role]
	return ok
}

// Len 返回角色数。
func (roles RoleSet) Len() int {
	return len(roles.values)
}

// Slice 返回稳定排序的角色副本。
func (roles RoleSet) Slice() []Role {
	result := make([]Role, 0, len(roles.values))
	for role := range roles.values {
		result = append(result, role)
	}
	sort.Slice(result, func(left int, right int) bool {
		return result[left] < result[right]
	})
	return result
}

// Validate 校验数据库模式允许的角色拓扑。
func (roles RoleSet) Validate(mode DatabaseMode) error {
	switch mode {
	case DatabaseModeSQLite:
		if roles.Len() != 3 ||
			!roles.Has(RoleAPI) ||
			!roles.Has(RoleWorker) ||
			!roles.Has(RoleScheduler) {
			return invalidRoleTopology()
		}
		return nil
	case DatabaseModeTDSQL:
		if roles.Len() == 0 {
			return invalidRoleTopology()
		}
		for role := range roles.values {
			if !validRole(role) {
				return invalidRoleTopology()
			}
		}
		return nil
	default:
		return invalidRoleTopology()
	}
}

func validRole(role Role) bool {
	return role == RoleAPI || role == RoleWorker || role == RoleScheduler
}

func invalidRoleTopology() error {
	return apperror.New(
		"database_mode_role_invalid",
		"数据库模式与进程角色组合不兼容",
		nil,
	)
}
