package importplan

type Plan struct {
	Networking NetworkingPlan
	Security   SecurityPlan
	TKE        TKEPlan
	Cynosdb    CynosdbPlan
	Redis      RedisPlan
	TCR        TCRPlan
	Storage    StoragePlan
	Monitoring MonitoringPlan
	Compute    ComputePlan
}

type NetworkingPlan struct {
	VpcID          string
	PrimaryNATID   string
	SecondaryNATID string
	RouteTableID   string
	RouteEntryID   string
	PrimaryEIPs    map[string]string
	SecondaryEIPs  map[string]string
	Subnets        map[string]string
}

type SecurityPlan struct {
	SandboxSecurityGroupID string
}

type TKEPlan struct {
	NodePoolSecurityGroupID string
	ClusterID               string
	ClusterEndpointID       string
	NodePoolID              string
	ScaleWorkerID           string
}

type CynosdbPlan struct {
	SecurityGroupID string
	ClusterID       string
}

type RedisPlan struct {
	CtlMQID        string
	SandboxRouteID string
}

type TCRPlan struct {
	InstanceID       string
	NamespaceID      string
	ServiceAccountID string
}

type StoragePlan struct {
	BucketID                 string
	CAMUserID                string
	CAMPolicyID              string
	CAMUserPolicyAttachID    string
	CAMAccessKeyImportIDHint string
}

type MonitoringPlan struct {
	ServiceGatewayLogsetID string
	ServiceGatewayTopicID  string
	ServiceGatewayIndexID  string
	CtlRuntimeTopicID      string
	CtlRuntimeIndexID      string
	SandboxRuntimeTopicID  string
	SandboxRuntimeIndexID  string
}

type ComputePlan struct {
	JumpserverID string
}

func ForEnvironment(env string) *Plan {
	if env != "beijing-sandbox" {
		return &Plan{}
	}

	return &Plan{
		Networking: NetworkingPlan{
			VpcID:          "vpc-21gzr2dc",
			PrimaryNATID:   "nat-jf0rbcvz",
			SecondaryNATID: "nat-depy9j01",
			RouteTableID:   "rtb-q8vgxkrt",
			RouteEntryID:   "5286665.rtb-q8vgxkrt",
			PrimaryEIPs: map[string]string{
				"eip-l5c4rwrr": "eip-l5c4rwrr",
				"eip-0mcvnzhj": "eip-0mcvnzhj",
				"eip-n7hu1nu7": "eip-n7hu1nu7",
				"eip-kgco7kpv": "eip-kgco7kpv",
				"eip-lbxks87d": "eip-lbxks87d",
				"eip-q60z6o69": "eip-q60z6o69",
				"eip-ieuqg9wh": "eip-ieuqg9wh",
				"eip-giimutd9": "eip-giimutd9",
				"eip-e3jayxk3": "eip-e3jayxk3",
				"eip-rm54ehz9": "eip-rm54ehz9",
			},
			SecondaryEIPs: map[string]string{
				"eip-noa4c357": "eip-noa4c357",
			},
			Subnets: map[string]string{
				"pool-a":  "subnet-07q7chg3",
				"pool-b":  "subnet-642xx4yj",
				"pool-c":  "subnet-83va49sv",
				"pool-d":  "subnet-dsr6f02j",
				"pool-e":  "subnet-1iiuss0v",
				"pool-f":  "subnet-apr9z44z",
				"support": "subnet-ieszm71b",
			},
		},
		Security: SecurityPlan{
			SandboxSecurityGroupID: "sg-hrhn5nf5",
		},
		TKE: TKEPlan{
			NodePoolSecurityGroupID: "sg-85w4itn9",
			ClusterID:               "cls-8gnhos9p",
			ClusterEndpointID:       "cls-8gnhos9p",
			NodePoolID:              "cls-8gnhos9p#np-4fdv8kif",
			ScaleWorkerID:           "cls-8gnhos9p#ins-85lpngpt",
		},
		Cynosdb: CynosdbPlan{
			SecurityGroupID: "sg-7a62rxgb",
			ClusterID:       "cynosdbmysql-3dh7jyee",
		},
		Redis: RedisPlan{
			CtlMQID:        "crs-3e3ldcop",
			SandboxRouteID: "crs-r5xziv3p",
		},
		TCR: TCRPlan{
			InstanceID:       "tcr-ih6tzely",
			NamespaceID:      "tcr-ih6tzely#lightclaw",
			ServiceAccountID: "tcr-ih6tzely#lightclaw-pull",
		},
		Storage: StoragePlan{
			BucketID:                 "lightclawuser-1388575217",
			CAMUserID:                "lightclawuser-cos",
			CAMPolicyID:              "267370633",
			CAMUserPolicyAttachID:    "lightclawuser-cos#267370633",
			CAMAccessKeyImportIDHint: "set via Pulumi secret storageAccessKeyImportId",
		},
		Monitoring: MonitoringPlan{
			ServiceGatewayLogsetID: "26c8cefe-07fe-4da8-96da-2c5918522d99",
			ServiceGatewayTopicID:  "8cb9d04f-16fc-4297-8d56-5d1dd68e9dfe",
			ServiceGatewayIndexID:  "8cb9d04f-16fc-4297-8d56-5d1dd68e9dfe",
			CtlRuntimeTopicID:      "7af98669-1a34-4f37-b60a-431c41f69794",
			CtlRuntimeIndexID:      "7af98669-1a34-4f37-b60a-431c41f69794",
			SandboxRuntimeTopicID:  "72e91c1f-d7ea-485d-a488-5f422af27b0d",
			SandboxRuntimeIndexID:  "72e91c1f-d7ea-485d-a488-5f422af27b0d",
		},
		Compute: ComputePlan{
			JumpserverID: "ins-0ry130tf",
		},
	}
}
