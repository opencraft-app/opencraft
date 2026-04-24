// Package common ...
package common

import (
	"golang.org/x/sync/errgroup"

	"ctl/pkg/context"
	"ctl/pkg/util"
)

// RequestFunc ...
type RequestFunc func(ctx context.Context) (response interface{}, err error)

// BatchRequestAllRegions ...
func BatchRequestAllRegions(ctx context.Context, requestFunc RequestFunc) (responses []interface{}, err error) {
	regionList := util.AllRegionNames()
	responseChan := make(chan interface{}, len(regionList))

	eg := errgroup.Group{}
	for _, region := range regionList {
		cc := ctx.WithRegion(region)

		eg.Go(func() error {
			response, err := requestFunc(cc)
			if err != nil {
				return err
			}

			select {
			case responseChan <- response:
				return nil
			case <-cc.Done():
				return ctx.Err()
			}
		})
	}

	if err := eg.Wait(); err != nil {
		return nil, err
	}
	close(responseChan)

	for response := range responseChan {
		responses = append(responses, response)
	}
	return responses, nil
}
