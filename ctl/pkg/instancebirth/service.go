package instancebirth

import (
	"errors"
	"time"

	pctx "ctl/pkg/context"
	modelinstance "ctl/pkg/model/instance"
	instancebirthprofile "ctl/pkg/model/instancebirthprofile"
)

type Service struct {
	instanceDao     modelinstance.Dao
	birthProfileDao instancebirthprofile.Dao
}

func NewService(instanceDao modelinstance.Dao, birthProfileDao instancebirthprofile.Dao) *Service {
	return &Service{
		instanceDao:     instanceDao,
		birthProfileDao: birthProfileDao,
	}
}

func (s *Service) RebuildForInstance(ctx pctx.Context, instanceID string) error {
	if s == nil {
		return errors.New("service is nil")
	}
	entity, err := s.instanceDao.GetByInstanceID(ctx, instanceID)
	if err != nil {
		return err
	}
	return s.RebuildForChinaDate(ctx, ChinaDateString(entity.CreatedAt))
}

func (s *Service) RebuildForChinaDate(ctx pctx.Context, bornDate string) error {
	if s == nil {
		return errors.New("service is nil")
	}
	return s.birthProfileDao.RebuildForChinaDate(ctx, bornDate)
}

func ChinaDateString(t time.Time) string {
	return t.In(chinaLocation()).Format("2006-01-02")
}

func chinaLocation() *time.Location {
	return time.FixedZone("Asia/Shanghai", 8*60*60)
}
