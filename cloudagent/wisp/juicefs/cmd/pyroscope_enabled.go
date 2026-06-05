//go:build !nopyroscope

/*
 * JuiceFS, Copyright 2026 Juicedata, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package cmd

import (
	"fmt"
	"os"
	"strconv"

	"github.com/grafana/pyroscope-go"
	_ "github.com/grafana/pyroscope-go/godeltaprof/http/pprof"
	"github.com/juicedata/juicefs/pkg/version"
	"github.com/urfave/cli/v2"
)

func startPyroscope(c *cli.Context) {
	if !c.IsSet("pyroscope") {
		return
	}
	tags := make(map[string]string)
	appName := fmt.Sprintf("juicefs.%s", c.Command.Name)
	if c.Command.Name == "mount" {
		tags["mountpoint"] = c.Args().Get(1)
	}
	if hostname, err := os.Hostname(); err == nil {
		tags["hostname"] = hostname
	}
	tags["pid"] = strconv.Itoa(os.Getpid())
	tags["version"] = version.Version()

	types := []pyroscope.ProfileType{pyroscope.ProfileCPU, pyroscope.ProfileInuseObjects, pyroscope.ProfileAllocObjects,
		pyroscope.ProfileInuseSpace, pyroscope.ProfileAllocSpace, pyroscope.ProfileGoroutines, pyroscope.ProfileMutexCount,
		pyroscope.ProfileMutexDuration, pyroscope.ProfileBlockCount, pyroscope.ProfileBlockDuration}
	if _, err := pyroscope.Start(pyroscope.Config{
		ApplicationName: appName,
		ServerAddress:   c.String("pyroscope"),
		Logger:          logger,
		Tags:            tags,
		AuthToken:       os.Getenv("PYROSCOPE_AUTH_TOKEN"),
		ProfileTypes:    types,
	}); err != nil {
		logger.Errorf("start pyroscope agent: %v", err)
	}
}
