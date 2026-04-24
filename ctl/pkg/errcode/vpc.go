package errcode

// VPC/Subnet 错误码范围: 10101-10199
var (
	ErrVPCNotFound            = Register(New("VPC_NOT_FOUND", 404, "VPC not found"))
	ErrSubnetAllocationFailed = Register(New("SUBNET_ALLOCATION_FAILED", 500, "subnet allocation failed"))
	ErrResourcePoolExhausted  = Register(New("RESOURCE_POOL_EXHAUSTED", 500, "resource pool exhausted"))
	ErrSubnetNotFound         = Register(New("SUBNET_NOT_FOUND", 404, "subnet not found"))
	ErrSecurityGroupNotFound  = Register(New("SECURITY_GROUP_NOT_FOUND", 404, "security group not found"))
)
