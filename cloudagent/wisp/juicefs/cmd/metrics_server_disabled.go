//go:build nometricsserver

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
	"os"
	"strings"

	"github.com/juicedata/juicefs/pkg/metric"
	"github.com/juicedata/juicefs/pkg/utils"
	"github.com/juicedata/juicefs/pkg/version"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/urfave/cli/v2"
)

func exposeMetrics(c *cli.Context, registerer prometheus.Registerer, registry *prometheus.Registry) string {
	go metric.UpdateMetrics(registerer)
	if c.IsSet("metrics") {
		logger.Warnf("Prometheus metrics server is disabled by the nometricsserver build tag")
	}
	return ""
}

func wrapRegister(c *cli.Context, mp, name string) (prometheus.Registerer, *prometheus.Registry) {
	commonLabels := prometheus.Labels{"mp": mp, "vol_name": name, "juicefs_version": version.Version()}
	if h, err := os.Hostname(); err == nil {
		commonLabels["instance"] = h
	} else {
		logger.Warnf("cannot get hostname: %s", err)
	}
	if c.IsSet("custom-labels") {
		for _, kv := range strings.Split(c.String("custom-labels"), ";") {
			splited := strings.Split(kv, ":")
			if len(splited) != 2 {
				logger.Fatalf("invalid label format: %q", kv)
			}
			if utils.StringContains([]string{"mp", "vol_name", "instance"}, splited[0]) {
				logger.Warnf("overriding reserved label: %q", splited[0])
			}
			commonLabels[splited[0]] = splited[1]
		}
	}
	registry := prometheus.NewRegistry()
	registerer := prometheus.WrapRegistererWithPrefix("juicefs_",
		prometheus.WrapRegistererWith(commonLabels, registry))
	return registerer, registry
}
