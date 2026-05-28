//go:build !nodebugagent

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
	"net/http"
	_ "net/http/pprof"
	"sync"

	"github.com/urfave/cli/v2"
)

var debugAgentOnce sync.Once

func startDebugAgent(c *cli.Context) {
	if c.Bool("no-agent") {
		return
	}
	go debugAgentOnce.Do(func() {
		for port := 6060; port < 6100; port++ {
			debugAgent = fmt.Sprintf("127.0.0.1:%d", port)
			logger.Debugf("Debug agent listening on %s", debugAgent)
			_ = http.ListenAndServe(debugAgent, nil)
		}
	})
}
