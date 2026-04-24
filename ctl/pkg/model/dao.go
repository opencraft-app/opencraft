// Package model ...
package model

import (
	"fmt"

	"gorm.io/gorm"

	"ctl/pkg/resource"
)

// Dao defines the common data access interface using GORM.
type Dao interface {
	DB() *gorm.DB
	Insert(entities ...interface{}) error
	InsertIgnore(entities ...interface{}) error
	DeleteByIds(ids ...int64) error
	UpdateByIds(updates map[string]interface{}, ids ...int64) error
	SelectById(id int64, dest interface{}) error
	SimpleQueryAnd(dest interface{}, scopes ...func(*gorm.DB) *gorm.DB) error
	SimpleTotalAnd(scopes ...func(*gorm.DB) *gorm.DB) (int64, error)
	Begin() *gorm.DB
	Transaction(fc func(tx *gorm.DB) error) error

	SelectByKeyColumn(keyValue interface{}, dest interface{}) error
	UpdateByKeyColumn(updates map[string]interface{}, keyValues ...interface{}) error
	DeleteByKeyColumn(keyValues ...interface{}) error

	SelectByUserKeyColumn(userID string, keyValue interface{}, dest interface{}) error
	UpdateByUserKeyColumn(updates map[string]interface{}, userID string, keyValues ...interface{}) error
	DeleteByUserKeyColumn(userID string, keyValues ...interface{}) error
	UpdateByConditions(updates map[string]interface{}, scopes ...func(*gorm.DB) *gorm.DB) error
}

// BaseDao provides a GORM-based implementation of the Dao interface.
type BaseDao struct {
	TableName string
	keyColumn string
}

// NewBaseDao creates a new BaseDao.
func NewBaseDao(tableName string) *BaseDao {
	return &BaseDao{
		TableName: tableName,
	}
}

// SetKeyColumn sets the business key column name.
func (d *BaseDao) SetKeyColumn(column string) *BaseDao {
	d.keyColumn = column
	return d
}

// DB returns the GORM DB scoped to this table.
func (d *BaseDao) DB() *gorm.DB {
	return resource.GormDB.Table(d.TableName)
}

// Insert inserts one or more entities.
func (d *BaseDao) Insert(entities ...interface{}) error {
	for _, entity := range entities {
		if err := d.DB().Create(entity).Error; err != nil {
			return fmt.Errorf("BaseDao.Insert error: %w", err)
		}
	}
	return nil
}

// InsertIgnore inserts entities, ignoring duplicate key errors.
// Uses GORM's raw Exec with INSERT IGNORE for MySQL compatibility.
func (d *BaseDao) InsertIgnore(entities ...interface{}) error {
	for _, entity := range entities {
		err := resource.GormDB.Session(&gorm.Session{DryRun: false}).
			Table(d.TableName).
			Create(entity).Error
		if err != nil {
			// If it's a duplicate key error, ignore it
			if isDuplicateKeyError(err) {
				continue
			}
			return fmt.Errorf("BaseDao.InsertIgnore error: %w", err)
		}
	}
	return nil
}

// isDuplicateKeyError checks if the error is a MySQL duplicate key error.
func isDuplicateKeyError(err error) bool {
	if err == nil {
		return false
	}
	// MySQL error 1062: Duplicate entry
	return fmt.Sprintf("%v", err) != "" &&
		(contains(err.Error(), "Duplicate entry") || contains(err.Error(), "1062"))
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && searchString(s, substr)
}

func searchString(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

// DeleteByIds deletes records by primary key IDs.
func (d *BaseDao) DeleteByIds(ids ...int64) error {
	return d.DB().Where("id IN ?", ids).Delete(nil).Error
}

// UpdateByIds updates records by primary key IDs.
func (d *BaseDao) UpdateByIds(updates map[string]interface{}, ids ...int64) error {
	return d.DB().Where("id IN ?", ids).Updates(updates).Error
}

// SelectById selects a single record by primary key.
func (d *BaseDao) SelectById(id int64, dest interface{}) error {
	return d.DB().Where("id = ?", id).First(dest).Error
}

// SimpleQueryAnd queries records using GORM scopes.
func (d *BaseDao) SimpleQueryAnd(dest interface{}, scopes ...func(*gorm.DB) *gorm.DB) error {
	return d.DB().Scopes(scopes...).Find(dest).Error
}

// SimpleTotalAnd counts records using GORM scopes.
func (d *BaseDao) SimpleTotalAnd(scopes ...func(*gorm.DB) *gorm.DB) (int64, error) {
	var count int64
	err := d.DB().Scopes(scopes...).Count(&count).Error
	return count, err
}

// Begin starts a transaction and returns the tx handle.
func (d *BaseDao) Begin() *gorm.DB {
	return resource.GormDB.Begin()
}

// Transaction runs fc within a transaction.
func (d *BaseDao) Transaction(fc func(tx *gorm.DB) error) error {
	return resource.GormDB.Transaction(fc)
}

// SelectByKeyColumn selects by the configured key column.
func (d *BaseDao) SelectByKeyColumn(keyValue interface{}, dest interface{}) error {
	return d.DB().Where(fmt.Sprintf("%s = ?", d.keyColumn), keyValue).First(dest).Error
}

// UpdateByKeyColumn updates records matching the key column.
func (d *BaseDao) UpdateByKeyColumn(updates map[string]interface{}, keyValues ...interface{}) error {
	if len(keyValues) == 1 {
		return d.DB().Where(fmt.Sprintf("%s = ?", d.keyColumn), keyValues[0]).Updates(updates).Error
	}
	return d.DB().Where(fmt.Sprintf("%s IN ?", d.keyColumn), keyValues).Updates(updates).Error
}

// DeleteByKeyColumn deletes records matching the key column.
func (d *BaseDao) DeleteByKeyColumn(keyValues ...interface{}) error {
	if len(keyValues) == 1 {
		return d.DB().Where(fmt.Sprintf("%s = ?", d.keyColumn), keyValues[0]).Delete(nil).Error
	}
	return d.DB().Where(fmt.Sprintf("%s IN ?", d.keyColumn), keyValues).Delete(nil).Error
}

// SelectByUserKeyColumn selects by user_id and key column.
func (d *BaseDao) SelectByUserKeyColumn(userID string, keyValue interface{}, dest interface{}) error {
	return d.DB().
		Where(fmt.Sprintf("%s = ? AND %s = ?", ColumnUserID, d.keyColumn), userID, keyValue).
		First(dest).Error
}

// UpdateByUserKeyColumn updates by user_id and key column.
func (d *BaseDao) UpdateByUserKeyColumn(updates map[string]interface{}, userID string, keyValues ...interface{}) error {
	q := d.DB().Where(fmt.Sprintf("%s = ?", ColumnUserID), userID)
	if len(keyValues) == 1 {
		q = q.Where(fmt.Sprintf("%s = ?", d.keyColumn), keyValues[0])
	} else {
		q = q.Where(fmt.Sprintf("%s IN ?", d.keyColumn), keyValues)
	}
	return q.Updates(updates).Error
}

// DeleteByUserKeyColumn deletes by user_id and key column.
func (d *BaseDao) DeleteByUserKeyColumn(userID string, keyValues ...interface{}) error {
	q := d.DB().Where(fmt.Sprintf("%s = ?", ColumnUserID), userID)
	if len(keyValues) == 1 {
		q = q.Where(fmt.Sprintf("%s = ?", d.keyColumn), keyValues[0])
	} else {
		q = q.Where(fmt.Sprintf("%s IN ?", d.keyColumn), keyValues)
	}
	return q.Delete(nil).Error
}

// UpdateByConditions updates records matching the given GORM scopes.
func (d *BaseDao) UpdateByConditions(updates map[string]interface{}, scopes ...func(*gorm.DB) *gorm.DB) error {
	return d.DB().Scopes(scopes...).Updates(updates).Error
}

// --- GORM scope helpers ---

// WhereEqual returns a scope that adds a WHERE col = ? condition.
func WhereEqual(column string, value interface{}) func(*gorm.DB) *gorm.DB {
	return func(db *gorm.DB) *gorm.DB {
		return db.Where(fmt.Sprintf("%s = ?", column), value)
	}
}

// WhereIn returns a scope that adds a WHERE col IN ? condition.
func WhereIn(column string, values interface{}) func(*gorm.DB) *gorm.DB {
	return func(db *gorm.DB) *gorm.DB {
		return db.Where(fmt.Sprintf("%s IN ?", column), values)
	}
}

// Paginate returns a scope for offset/limit pagination.
func Paginate(offset, limit int64) func(*gorm.DB) *gorm.DB {
	return func(db *gorm.DB) *gorm.DB {
		return db.Offset(int(offset)).Limit(int(limit))
	}
}

// OrderByScope returns a scope for ordering.
func OrderByScope(orderBy string) func(*gorm.DB) *gorm.DB {
	return func(db *gorm.DB) *gorm.DB {
		return db.Order(orderBy)
	}
}
