//go:generate mockgen -source logic.go -destination logic_mock.go -package logic

// Package factory ...
package factory

import (
	"ctl/pkg/instance"
	"ctl/pkg/logic/app"
	"ctl/pkg/logic/cache"
	"ctl/pkg/logic/lock"
	"ctl/pkg/logic/objectid"
	"ctl/pkg/logic/userresourcequota"
)

// LogicFactory ...
type LogicFactory interface {
	LockLogic() lock.Logic
	ObjectIdLogic() objectid.Logic
	CacheLogic() cache.Logic
	AppLogic() app.Logic
	UserResourceQuotaLogic() userresourcequota.Logic
	InstanceLogic() instance.Logic
}

// DefaultLogicFactory ...
var DefaultLogicFactory LogicFactory = new(logic)

type logic struct {
}

// LockLogic ...
func (l *logic) LockLogic() lock.Logic {
	return lock.NewLogic()
}

// ObjectIdLogic ...
func (l *logic) ObjectIdLogic() objectid.Logic {
	return objectid.NewLogic()
}

// CacheLogic ...
func (l *logic) CacheLogic() cache.Logic {
	return cache.NewLogic()
}

// AppLogic ...
func (l *logic) AppLogic() app.Logic {
	return app.NewLogic()
}

// UserResourceQuotaLogic ...
func (l *logic) UserResourceQuotaLogic() userresourcequota.Logic {
	return userresourcequota.NewLogic()
}

// InstanceLogic ...
func (l *logic) InstanceLogic() instance.Logic {
	return instance.NewLogic()
}
