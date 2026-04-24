package model

import "time"

type GetOneInstanceRequest struct {
	Service    string
	Namespace  string
	Timeout    *time.Duration
	RetryCount *int
}

type Instance struct {
	Host string
}

func (i *Instance) GetHost() string {
	if i == nil {
		return ""
	}
	return i.Host
}

type InstancesResponse struct {
	Instances []Instance
}

type RetStatus int

type ServiceCallResult struct {
	CalledInstance Instance
	RetStatus      RetStatus
	RetCode        *int32
	Delay          *time.Duration
}
