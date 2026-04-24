// Package resource ...
package resource

import (
	"fmt"
	"os"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"

	"ctl/pkg/config"
)

// ZapLogger 全局 zap logger 实例
var ZapLogger *zap.Logger

// SugaredLogger 全局 sugared logger（方便格式化日志）
var SugaredLogger *zap.SugaredLogger

// InitLog 初始化日志系统（兼容旧接口签名）
func InitLog(logConfig *config.LogConfig) error {
	_, _ = InitZapLogger(logConfig)
	return nil
}

// InitZapLogger 初始化 zap 日志系统
func InitZapLogger(logConfig *config.LogConfig) (*zap.Logger, *zap.SugaredLogger) {
	var zapConfig zap.Config

	if logConfig.Formater == "simple" || logConfig.EnableColor {
		// 开发环境：Console 格式，彩色输出
		zapConfig = zap.NewDevelopmentConfig()
		zapConfig.EncoderConfig.EncodeLevel = zapcore.CapitalColorLevelEncoder
		zapConfig.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder
	} else {
		// 生产环境：JSON 格式输出
		zapConfig = zap.NewProductionConfig()
		zapConfig.EncoderConfig.TimeKey = "timestamp"
		zapConfig.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder
	}

	// 设置日志级别
	zapConfig.Level = zap.NewAtomicLevelAt(toZapLevel(logConfig.Level))

	// 设置输出路径
	if logConfig.Path != "" && logConfig.Path != "/dev/stdout" {
		zapConfig.OutputPaths = []string{logConfig.Path}
	} else {
		zapConfig.OutputPaths = []string{"stdout"}
	}

	logger, err := zapConfig.Build(
		zap.AddCallerSkip(0),
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "zap.Build error: %v\n", err)
		logger = zap.NewNop()
	}

	ZapLogger = logger
	SugaredLogger = logger.Sugar()

	return logger, SugaredLogger
}

// FreeLog 刷新并关闭日志
func FreeLog() {
	if ZapLogger != nil {
		_ = ZapLogger.Sync()
	}
}

// toZapLevel 将旧的 golog 日志级别转换为 zap 级别
func toZapLevel(level int) zapcore.Level {
	switch {
	case level <= 2:
		return zapcore.FatalLevel
	case level == 3:
		return zapcore.ErrorLevel
	case level == 4:
		return zapcore.WarnLevel
	case level == 5:
		return zapcore.InfoLevel
	case level == 6:
		return zapcore.InfoLevel
	default:
		return zapcore.DebugLevel
	}
}
