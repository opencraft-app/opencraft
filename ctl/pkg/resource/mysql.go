// Package resource ...
package resource

import (
	"fmt"
	"time"

	gomysql "github.com/go-sql-driver/mysql"
	"go.uber.org/zap"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"

	"ctl/pkg/config"
)

// GormDB 全局 GORM DB 实例
var GormDB *gorm.DB

// InitGormDB 初始化 GORM 数据库连接
func InitGormDB(conf *config.DBConfig) *gorm.DB {
	cfg := gomysql.NewConfig()
	cfg.User = conf.User
	cfg.Passwd = conf.Password
	cfg.Net = "tcp"
	cfg.Addr = fmt.Sprintf("%s:%d", conf.Host, conf.Port)
	cfg.DBName = conf.Database
	cfg.Params = map[string]string{
		"charset":   "utf8mb4",
		"time_zone": "'+00:00'",
	}
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	dsn := cfg.FormatDSN()

	db, err := gorm.Open(mysql.Open(dsn), newUTCGormConfig())
	if err != nil {
		panic(fmt.Sprintf("failed to connect to database: %v", err))
	}

	sqlDB, err := db.DB()
	if err != nil {
		panic(fmt.Sprintf("failed to get underlying sql.DB: %v", err))
	}

	// 连接池配置
	maxIdleConns := conf.MaxIdleConns
	if maxIdleConns <= 0 {
		maxIdleConns = 10
	}
	maxOpenConns := conf.MaxOpenConns
	if maxOpenConns <= 0 {
		maxOpenConns = 100
	}
	connMaxLifetimeSec := conf.ConnMaxLifetimeSec
	if connMaxLifetimeSec <= 0 {
		connMaxLifetimeSec = 3600
	}

	sqlDB.SetMaxIdleConns(maxIdleConns)
	sqlDB.SetMaxOpenConns(maxOpenConns)
	sqlDB.SetConnMaxLifetime(time.Duration(connMaxLifetimeSec) * time.Second)

	if ZapLogger != nil {
		ZapLogger.Info("GORM database connected",
			zap.String("host", conf.Host),
			zap.Uint("port", conf.Port),
			zap.String("database", conf.Database),
			zap.Int("maxIdleConns", maxIdleConns),
			zap.Int("maxOpenConns", maxOpenConns),
		)
	}

	return db
}

func newUTCGormConfig() *gorm.Config {
	return &gorm.Config{
		Logger:  gormlogger.Default.LogMode(gormlogger.Silent),
		NowFunc: func() time.Time { return time.Now().UTC() },
	}
}

// InitMySQL initializes the MySQL connection using GORM (alias for backward compatibility)
func InitMySQL(conf *config.DBConfig) error {
	GormDB = InitGormDB(conf)
	return nil
}
