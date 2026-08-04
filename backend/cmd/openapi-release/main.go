package main

import (
	"flag"
	"fmt"
	"os"

	"chatserver/internal/api/openapirelease"
)

func main() {
	root := flag.String("root", ".", "仓库根目录")
	version := flag.String("version", "", "待冻结的 OpenAPI 版本")
	verify := flag.Bool("verify", false, "只验证 release lock")
	trustedBase := flag.String("trusted-base", "", "可信默认分支的 release lock")
	flag.Parse()
	if *verify {
		var err error
		if *trustedBase == "" {
			err = openapirelease.VerifyRoot(*root)
		} else {
			err = openapirelease.VerifyTrustedBase(*root, *trustedBase)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "OpenAPI release 验证失败："+err.Error())
			os.Exit(1)
		}
		fmt.Println("OpenAPI release lock 验证通过")
		return
	}
	if err := openapirelease.Promote(*root, *version); err != nil {
		fmt.Fprintln(os.Stderr, "OpenAPI 发布失败："+err.Error())
		os.Exit(1)
	}
	fmt.Println("OpenAPI release 已冻结：" + *version)
}
