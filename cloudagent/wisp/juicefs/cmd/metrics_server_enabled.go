//go:build !nometricsserver

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
	"net"
	"net/http"
	"os"
	"strings"

	"github.com/juicedata/juicefs/pkg/metric"
	"github.com/juicedata/juicefs/pkg/utils"
	"github.com/juicedata/juicefs/pkg/version"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/urfave/cli/v2"
)

func exposeMetrics(c *cli.Context, registerer prometheus.Registerer, registry *prometheus.Registry) string {
	var ip, port string
	// default set
	ip, port, err := net.SplitHostPort(c.String("metrics"))
	if err != nil {
		logger.Fatalf("metrics format error %q: %v", c.String("metrics"), err)
	}
	go metric.UpdateMetrics(registerer)
	http.Handle("/metrics", promhttp.HandlerFor(
		registry,
		promhttp.HandlerOpts{
			// Opt into OpenMetrics to support exemplars.
			EnableOpenMetrics: true,
		},
	))
	registerer.MustRegister(collectors.NewBuildInfoCollector())

	// If not set metrics addr,the port will be auto set
	if !c.IsSet("metrics") {
		// If only set consul, ip will auto set
		if c.IsSet("consul") {
			ip, err = utils.GetLocalIp(c.String("consul"))
			if err != nil {
				logger.Errorf("Get local ip failed: %v", err)
				return ""
			}
		}
	}

	ln, err := net.Listen("tcp", net.JoinHostPort(ip, port))
	if err != nil {
		// Don't try other ports on metrics set but listen failed
		if c.IsSet("metrics") {
			logger.Errorf("listen on %q:%q failed: %v", ip, port, err)
			return ""
		}
		// Listen port on 0 will auto listen on a free port
		ln, err = net.Listen("tcp", net.JoinHostPort(ip, "0"))
		if err != nil {
			logger.Errorf("Listen failed: %v", err)
			return ""
		}
	}

	go func() {
		if err := http.Serve(ln, nil); err != nil {
			logger.Errorf("Serve for metrics: %s", err)
		}
	}()

	metricsAddr := ln.Addr().String()
	logger.Infof("Prometheus metrics listening on %q", metricsAddr)
	return metricsAddr
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
	registry := prometheus.NewRegistry() // replace default so only JuiceFS metrics are exposed
	registerer := prometheus.WrapRegistererWithPrefix("juicefs_",
		prometheus.WrapRegistererWith(commonLabels, registry))

	registerer.MustRegister(collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	registerer.MustRegister(collectors.NewGoCollector())
	return registerer, registry
}
