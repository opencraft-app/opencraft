package test

import (
	"os"
	"testing"

	"github.com/stretchr/testify/require"

	"ctl/pkg/config"
	"ctl/pkg/resource"
)

// InitConfigForTest initializes the configuration for testing purposes.
// It requires the CONF_DIR environment variable to be set.
func InitConfigForTest(t *testing.T) {
	confDir := os.Getenv("CONF_DIR")
	require.NotEmpty(t, confDir, "Environment variable CONF_DIR must be set")

	err := config.Init(confDir)
	require.NoError(t, err, "Failed to initialize config")
}

// InitTestEnv initializes the full test environment, including config and resources like logger.
func InitTestEnv(t *testing.T) {
	InitConfigForTest(t)

	// Init logger
	err := resource.InitLog(config.ServerConf.LogConfig.Service)
	require.NoError(t, err, "Failed to initialize logger")
}
