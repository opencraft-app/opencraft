package api

import (
	"git.woa.com/polaris/polaris-go/v2/pkg/config"
	"git.woa.com/polaris/polaris-go/v2/pkg/model"
)

type ConsumerAPI interface {
	GetOneInstance(*GetOneInstanceRequest) (*model.InstancesResponse, error)
	UpdateServiceCallResult(*ServiceCallResult) error
	Destroy()
}

type GetOneInstanceRequest struct {
	model.GetOneInstanceRequest
}

type ServiceCallResult struct {
	model.ServiceCallResult
}

type noopConsumerAPI struct{}

func NewConsumerAPIByConfig(config.Configuration) (ConsumerAPI, error) {
	return noopConsumerAPI{}, nil
}

func (noopConsumerAPI) GetOneInstance(*GetOneInstanceRequest) (*model.InstancesResponse, error) {
	return &model.InstancesResponse{}, nil
}

func (noopConsumerAPI) UpdateServiceCallResult(*ServiceCallResult) error {
	return nil
}

func (noopConsumerAPI) Destroy() {}
