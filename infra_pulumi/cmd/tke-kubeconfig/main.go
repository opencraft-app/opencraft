package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/skipzhang/mono/infra_pulumi/pkg/tencenttke"
)

func main() {
	var (
		clusterID  string
		region     string
		outputPath string
		extranet   bool
	)

	flag.StringVar(&clusterID, "cluster-id", "", "Tencent Cloud TKE cluster ID")
	flag.StringVar(&region, "region", "", "Tencent Cloud region, for example ap-beijing")
	flag.StringVar(&outputPath, "output", "", "Path to write kubeconfig to")
	flag.BoolVar(&extranet, "extranet", false, "Fetch extranet kubeconfig instead of intranet")
	flag.Parse()

	if clusterID == "" || region == "" || outputPath == "" {
		fmt.Fprintln(os.Stderr, "usage: tke-kubeconfig --cluster-id <id> --region <region> --output <path> [--extranet]")
		os.Exit(2)
	}

	secretID := os.Getenv("TENCENTCLOUD_SECRET_ID")
	secretKey := os.Getenv("TENCENTCLOUD_SECRET_KEY")
	kubeconfig, err := tencenttke.GetClusterKubeconfig(secretID, secretKey, region, clusterID, extranet)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fetch kubeconfig: %v\n", err)
		os.Exit(1)
	}

	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "create output dir: %v\n", err)
		os.Exit(1)
	}
	if err := os.WriteFile(outputPath, []byte(kubeconfig), 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "write kubeconfig: %v\n", err)
		os.Exit(1)
	}
	if err := os.Chmod(outputPath, 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "chmod kubeconfig: %v\n", err)
		os.Exit(1)
	}
}
