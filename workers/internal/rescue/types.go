package rescue

var CommonRegions = []string{
	"ap-guangzhou",
	"ap-shanghai",
	"ap-beijing",
	"ap-nanjing",
	"ap-chengdu",
	"ap-chongqing",
	"ap-hongkong",
	"ap-singapore",
	"ap-tokyo",
	"ap-seoul",
	"na-siliconvalley",
	"na-ashburn",
	"eu-frankfurt",
}

type TemporalConfig struct {
	Address   string
	Namespace string
	TLS       bool
	AuthToken string
	TaskQueue string
}

type TencentConfig struct {
	Region           string
	CredentialFile   string
	RegionCandidates []string
}

type ExportRequest struct {
	InstanceID             string
	Region                 string
	NotificationEmail      string
	NotifyEmail            string
	RescueUsername         string
	RescuePasswordEnv      string
	StopType               string
	SkipBackup             bool
	ReenterRescue          bool
	BackupName             string
	ForcePoweroffForImage  bool
	DeviceGlobs            []string
	RemotePaths            []string
	MountRoot              string
	RemoteWorkDir          string
	LocalOutputDir         string
	CommandTransport       string
	SSHHost                string
	SSHUser                string
	SSHPort                int
	SSHIdentityFile        string
	SSHPasswordEnv         string
	StrictHostKeyChecking  bool
	SCPExtraOptions        []string
	TATUsername            string
	TATWorkingDirectory    string
	TATWaitTimeoutSeconds  int
	TATOutputCOSBucketURL  string
	TATOutputCOSKeyPrefix  string
	COSUploadBucket        string
	COSUploadRegion        string
	COSUploadKeyPrefix     string
	COSUploadURLTTLSeconds int
	KeepRemoteArchive      bool
	DisableCOSAutoDelete   bool
	NotificationEmails     []string
	SearchAttributes       []string
	Execute                bool
	Confirmed              bool
	WaitTimeoutSeconds     int
	CommandTimeoutSeconds  int
}

type InstanceInfo struct {
	InstanceID string
	Region     string
	State      string
	PublicIP   string
	PrivateIP  string
}

type PreparedArchive struct {
	InstanceID    string
	Region        string
	RemotePath    string
	MountedDevice string
	SHA256        string
	ByteSize      int64
	RemoteOutput  string
	ObjectURL     string
	DownloadURL   string
	ObjectKey     string
	Bucket        string
}

type TATCommandRequest struct {
	CommandName    string
	Script         string
	TimeoutSeconds int
}

type PreparedTATArchive struct {
	InstanceID    string
	Region        string
	Mode          string
	Command       TATCommandRequest
	ObjectURL     string
	DownloadURL   string
	ObjectKey     string
	Bucket        string
	RemotePath    string
	MountedDevice string
	SHA256        string
	ByteSize      int64
}

type SCPResult struct {
	LocalPath string
	Command   []string
	Stdout    string
	Stderr    string
	OutputURL string
}

type ExportResult struct {
	Instance              InstanceInfo
	Backup                BackupInfo
	Archive               PreparedArchive
	SCP                   SCPResult
	ExitedRescue          bool
	COSDeleteWorkflowID   string
	COSDeleteAfterSeconds int
	NotificationEmail     string
	EmailMessageID        string
	EmailDelivered        bool
	EmailDeliverStatus    int
	EmailDeliverMessage   string
	DryRun                bool
}

type ExportStatus struct {
	WorkflowID            string
	RunID                 string
	Phase                 string
	Instance              InstanceInfo
	Backup                BackupInfo
	Archive               PreparedArchive
	SCP                   SCPResult
	TATCommand            TATCommandResult
	ExitedRescue          bool
	COSDeleteWorkflowID   string
	COSDeleteAfterSeconds int
	NotificationEmail     string
	EmailMessageID        string
	EmailDelivered        bool
	EmailDeliverStatus    int
	EmailDeliverMessage   string
	Error                 string
	DryRun                bool
}

type BackupInfo struct {
	Mode   string
	ID     string
	Name   string
	State  string
	DryRun bool
}

type COSDeleteRequest struct {
	InstanceID   string
	BucketURL    string
	BucketRegion string
	ObjectKey    string
	ObjectURL    string
	DelaySeconds int
	WorkflowID   string
}

type COSDeleteResult struct {
	ObjectKey string
	ObjectURL string
	Deleted   bool
	DryRun    bool
}
