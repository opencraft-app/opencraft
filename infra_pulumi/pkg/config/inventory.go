package config

type Inventory struct {
	EnvName     string `yaml:"env_name"`
	Cloud       string `yaml:"cloud"`
	Region      string `yaml:"region"`
	EnvShort    string `yaml:"env_short"`
	ZonePrimary string `yaml:"zone_primary"`

	Network struct {
		VpcCIDR               string   `yaml:"vpc_cidr"`
		SupportSubnetKey      string   `yaml:"support_subnet_key"`
		SandboxPoolSubnetKeys []string `yaml:"sandbox_pool_subnet_keys"`
	} `yaml:"network"`

	Domains struct {
		PublicAPI        string `yaml:"public_api"`
		Admin            string `yaml:"admin"`
		FrontendStatic   string `yaml:"frontend_static"`
		ModelAPIInternal string `yaml:"model_api_internal"`
	} `yaml:"domains"`

	Stacks struct {
		TKE struct {
			ClusterName                string   `yaml:"cluster_name"`
			NodePoolName               string   `yaml:"node_pool_name"`
			ClusterVersion             string   `yaml:"cluster_version"`
			NetworkType                string   `yaml:"network_type"`
			ServiceCIDR                string   `yaml:"service_cidr"`
			VpcCniType                 string   `yaml:"vpc_cni_type"`
			EniSubnetKeys              []string `yaml:"eni_subnet_keys"`
			ClusterCIDR                string   `yaml:"cluster_cidr"`
			SubnetID                   string   `yaml:"subnet_id"`
			AvailabilityZone           string   `yaml:"availability_zone"`
			ClusterInternet            bool     `yaml:"cluster_internet"`
			ClusterInternetCIDRs       []string `yaml:"cluster_internet_cidrs"`
			InstanceType               string   `yaml:"instance_type"`
			NodePoolMinSize            int      `yaml:"node_pool_min_size"`
			NodePoolDesiredCapacity    int      `yaml:"node_pool_desired_capacity"`
			NodePoolMaxSize            int      `yaml:"node_pool_max_size"`
			NodePoolSystemDiskType     string   `yaml:"node_pool_system_disk_type"`
			NodePoolSystemDiskSize     int      `yaml:"node_pool_system_disk_size"`
			ManageScaleWorker          *bool    `yaml:"manage_scale_worker"`
			WorkerImgID                string   `yaml:"worker_img_id"`
			NodePoolPublicIngressPorts []int    `yaml:"node_pool_public_ingress_ports"`
		} `yaml:"tke"`

		Cynosdb struct {
			AvailabilityZone   string `yaml:"availability_zone"`
			ExistingEndpoint   string `yaml:"existing_endpoint"`
			DBVersion          string `yaml:"db_version"`
			SubnetID           string `yaml:"subnet_id"`
			ClusterCIDR        string `yaml:"cluster_cidr"`
			InstanceCPUCore    int    `yaml:"instance_cpu_core"`
			InstanceMemorySize int    `yaml:"instance_memory_size"`
			StorageLimit       int    `yaml:"storage_limit"`
		} `yaml:"cynosdb"`

		Networking struct {
			PrimaryNATGatewayName   string                     `yaml:"primary_nat_gateway_name"`
			SecondaryNATGatewayName string                     `yaml:"secondary_nat_gateway_name"`
			PrimaryNATPublicIPs     []string                   `yaml:"primary_nat_public_ips"`
			SecondaryNATPublicIPs   []string                   `yaml:"secondary_nat_public_ips"`
			PrimaryEIPs             map[string]EIPBandwidth    `yaml:"primary_eips"`
			SecondaryEIPs           map[string]EIPBandwidth    `yaml:"secondary_eips"`
			RouteTableName          string                     `yaml:"route_table_name"`
			SNATSubnets             map[string]SNATSubnetEntry `yaml:"snat_subnets"`
		} `yaml:"networking"`

		Connectivity struct {
			Enabled   bool `yaml:"enabled"`
			AccessVPC struct {
				CIDR             string `yaml:"cidr"`
				SubnetCIDR       string `yaml:"subnet_cidr"`
				AvailabilityZone string `yaml:"availability_zone"`
				RouteTableName   string `yaml:"route_table_name"`
			} `yaml:"access_vpc"`
			CCN struct {
				ExistingID                  string `yaml:"existing_id"`
				Name                        string `yaml:"name"`
				Description                 string `yaml:"description"`
				ChargeType                  string `yaml:"charge_type"`
				BandwidthLimitType          string `yaml:"bandwidth_limit_type"`
				Qos                         string `yaml:"qos"`
				InterRegionBandwidthLimitMB int    `yaml:"inter_region_bandwidth_limit_mbps"`
				RemoteRegion                string `yaml:"remote_region"`
				RemoteVpcID                 string `yaml:"remote_vpc_id"`
				RemoteVpcCIDR               string `yaml:"remote_vpc_cidr"`
				RemoteRouteTableID          string `yaml:"remote_route_table_id"`
			} `yaml:"ccn"`
			PrivateLink struct {
				Enabled                   bool     `yaml:"enabled"`
				ProviderServiceName       string   `yaml:"provider_service_name"`
				ProviderServiceType       string   `yaml:"provider_service_type"`
				ProviderServiceInstanceID string   `yaml:"provider_service_instance_id"`
				AutoAccept                bool     `yaml:"auto_accept"`
				ConsumerEndpointName      string   `yaml:"consumer_endpoint_name"`
				ConsumerEndpointVIP       string   `yaml:"consumer_endpoint_vip"`
				ConsumerSecurityGroupIDs  []string `yaml:"consumer_security_group_ids"`
				ProviderListenerPort      int      `yaml:"provider_listener_port"`
				ProviderTargetPort        int      `yaml:"provider_target_port"`
			} `yaml:"private_link"`
		} `yaml:"connectivity"`

		Security struct {
			SandboxSG SecurityGroupInventory `yaml:"sandbox_sg"`
		} `yaml:"security"`

		Redis struct {
			CtlMQ        RedisInventory `yaml:"ctl_mq"`
			SandboxRoute RedisInventory `yaml:"sandbox_route"`
		} `yaml:"redis"`

		Notify NotifyInventory `yaml:"notify"`

		TCR struct {
			InstanceType                   string            `yaml:"instance_type"`
			NamespaceName                  string            `yaml:"namespace_name"`
			OpenPublicOperation            bool              `yaml:"open_public_operation"`
			Tags                           map[string]string `yaml:"tags"`
			PullServiceAccountName         string            `yaml:"pull_service_account_name"`
			PullServiceAccountDurationDays int               `yaml:"pull_service_account_duration_days"`
		} `yaml:"tcr"`

		Storage struct {
			ManageCAMAccess *bool  `yaml:"manage_cam_access"`
			CAMUserName     string `yaml:"cam_user_name"`
			CAMPolicyName   string `yaml:"cam_policy_name"`
		} `yaml:"storage"`

		Monitoring struct {
			CLSLogs struct {
				LogsetName string `yaml:"logset_name"`
				TopicName  string `yaml:"topic_name"`
			} `yaml:"cls_logs"`
			CtlCLSLogs struct {
				LogsetID  string `yaml:"logset_id"`
				TopicName string `yaml:"topic_name"`
			} `yaml:"ctl_cls_logs"`
			SandboxCLSLogs struct {
				LogsetID  string `yaml:"logset_id"`
				TopicName string `yaml:"topic_name"`
			} `yaml:"sandbox_cls_logs"`
		} `yaml:"monitoring"`

		Compute struct {
			Jumpserver JumpserverInventory `yaml:"jumpserver"`
		} `yaml:"compute"`
	} `yaml:"stacks"`
}

type EIPBandwidth struct {
	Bandwidth int `yaml:"bandwidth"`
}

type SNATSubnetEntry struct {
	AvailabilityZone string   `yaml:"availability_zone"`
	Description      string   `yaml:"description"`
	PublicIPAddrs    []string `yaml:"public_ip_addrs"`
}

type SecurityGroupInventory struct {
	SecurityGroupName string   `yaml:"security_group_name"`
	Description       string   `yaml:"description"`
	Ingress           []string `yaml:"ingress"`
	Egress            []string `yaml:"egress"`
}

type RedisInventory struct {
	AvailabilityZone string   `yaml:"availability_zone"`
	ExistingEndpoint string   `yaml:"existing_endpoint"`
	MemSize          int      `yaml:"mem_size"`
	TypeID           int      `yaml:"type_id"`
	SubnetID         string   `yaml:"subnet_id"`
	RedisShardNum    int      `yaml:"redis_shard_num"`
	RedisReplicasNum int      `yaml:"redis_replicas_num"`
	SecurityGroups   []string `yaml:"security_groups"`
}

type NotifyInventory struct {
	Enabled                   bool   `yaml:"enabled"`
	ManageTriggers            bool   `yaml:"manage_triggers"`
	TriggersEnabled           bool   `yaml:"triggers_enabled"`
	TestAllowlistEnabled      bool   `yaml:"test_allowlist_enabled"`
	DBUser                    string `yaml:"db_user"`
	DBHost                    string `yaml:"db_host"`
	DBPort                    int    `yaml:"db_port"`
	DBSecretName              string `yaml:"db_secret_name"`
	RedisHost                 string `yaml:"redis_host"`
	RedisPort                 int    `yaml:"redis_port"`
	RedisSecretName           string `yaml:"redis_secret_name"`
	VPCID                     string `yaml:"vpc_id"`
	SubnetID                  string `yaml:"subnet_id"`
	CLSLogsetID               string `yaml:"cls_logset_id"`
	CLSTopicID                string `yaml:"cls_topic_id"`
	SMSSDKAppID               string `yaml:"sms_sdk_app_id"`
	SMSSignName               string `yaml:"sms_sign_name"`
	SMSTemplateID             string `yaml:"sms_template_id"`
	ExpiryWindowsDays         string `yaml:"expiry_windows_days"`
	SMSQPS                    int    `yaml:"sms_qps"`
	SMSBurst                  int    `yaml:"sms_burst"`
	ScanPageSize              int    `yaml:"scan_page_size"`
	WorkerBatchSize           int    `yaml:"worker_batch_size"`
	WorkerMaxMessages         int    `yaml:"worker_max_messages"`
	ScannerCron               string `yaml:"scanner_cron"`
	WorkerCron                string `yaml:"worker_cron"`
	ScannerFunctionName       string `yaml:"scanner_function_name"`
	WorkerFunctionName        string `yaml:"worker_function_name"`
	ExistingScannerFunctionID string `yaml:"existing_scanner_function_id"`
	ExistingWorkerFunctionID  string `yaml:"existing_worker_function_id"`
	ExistingScannerTriggerID  string `yaml:"existing_scanner_trigger_id"`
	ExistingWorkerTriggerID   string `yaml:"existing_worker_trigger_id"`
}

type JumpserverInventory struct {
	AvailabilityZone   string   `yaml:"availability_zone"`
	InstanceType       string   `yaml:"instance_type"`
	ImageID            string   `yaml:"image_id"`
	InstanceChargeType string   `yaml:"instance_charge_type"`
	SystemDiskType     string   `yaml:"system_disk_type"`
	SystemDiskSize     int      `yaml:"system_disk_size"`
	SubnetID           string   `yaml:"subnet_id"`
	SecurityGroups     []string `yaml:"security_groups"`
	UserDataRaw        string   `yaml:"user_data_raw"`
}
