package main

import (
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/skipzhang/mono/infra_pulumi/pkg/app"
)

func main() {
	pulumi.Run(app.Run)
}
