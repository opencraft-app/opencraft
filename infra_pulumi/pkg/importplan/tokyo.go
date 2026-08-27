package importplan

func tokyoPlan() *Plan {
	return &Plan{
		Security: SecurityPlan{
			SandboxSecurityGroupID: "sg-14cou8p0",
		},
		TKE: TKEPlan{
			NodePoolSecurityGroupID: "sg-84hqfbsc",
			ClusterID:               "cls-kqn1an4m",
			NodePoolID:              "cls-kqn1an4m#np-dpmaf61m",
		},
		Cynosdb: CynosdbPlan{
			SecurityGroupID: "sg-qgy09tew",
			ClusterID:       "cynosdbmysql-r1wrylc5",
		},
		Redis: RedisPlan{
			CtlMQID:        "crs-4yqfur9y",
			SandboxRouteID: "crs-r831lh3s",
		},
		TCR: TCRPlan{
			InstanceID:       "tcr-f7emx0nt",
			NamespaceID:      "tcr-f7emx0nt#lightclaw",
			ServiceAccountID: "tcr-f7emx0nt#lightclaw-pull",
		},
		adoption: adoptionMetadata{
			adoptable: []string{"cynosdb", "redis", "security", "tcr", "tke"},
			external: []string{
				"clb",
				"compute",
				"connectivity",
				"monitoring",
				"networking",
				"notify",
				"storage",
			},
		},
	}
}
