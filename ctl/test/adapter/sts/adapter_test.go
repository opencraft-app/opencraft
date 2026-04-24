package sts

import (
	"testing"

	"ctl/pkg/adapter/factory"
	"ctl/pkg/adapter/sts"
	"ctl/pkg/adapter/tcloud"
	"ctl/pkg/config"
	"ctl/test"
)

func init() {
	test.InitTestResource()
}

func TestAssumeRole(t *testing.T) {
	t.Skip("external STS integration test")

	result, err := factory.DefaultAdapterFactory.StsAdapter().
		AssumeRole(dnsSslTcloudContext(), &sts.AssumeRoleParams{
			RoleArn:         "qcs::cam::uin/3237154827:role/tencentcloudServiceRoleName/Lighthouse_QCSLinkedRoleInDnsAndSsl",
			RoleSessionName: "lighthouse_dns_ssl",
			DurationSeconds: 7200,
		})

	t.Log(result, err)
}

func TestGetServiceTokenForInternal(t *testing.T) {
	t.Skip("external STS integration test")

	result, err := factory.DefaultAdapterFactory.StsAdapter().
		GetServiceTokenForInternal(lighthouseTcloudContext(), &sts.GetServiceTokenForInternalParams{
			TargetProduct:   "lighthouse",
			TargetActions:   []string{"DescribeInstances"},
			DurationSeconds: 7200,
		})

	t.Log(result, err)
}

func dnsSslTcloudContext() *tcloud.Context {
	ctx := test.Context()

	return &tcloud.Context{
		Ctx:    ctx,
		Region: ctx.GetRegion(),
		Account: &tcloud.Account{
			Credentials: &tcloud.Credential{
				SecretId:  config.ServerConf.ServiceRoleConfig.DnsSsl.SecretId,
				SecretKey: config.ServerConf.ServiceRoleConfig.DnsSsl.SecretKey,
			},
		},
	}
}

func lighthouseTcloudContext() *tcloud.Context {
	ctx := test.Context()

	return &tcloud.Context{
		Ctx:    ctx,
		Region: ctx.GetRegion(),
		Account: &tcloud.Account{
			Credentials: &tcloud.Credential{
				SecretId:  config.ServerConf.ServiceAccountConfig.Lighthouse.SecretId,
				SecretKey: config.ServerConf.ServiceAccountConfig.Lighthouse.SecretKey,
			},
		},
	}
}
