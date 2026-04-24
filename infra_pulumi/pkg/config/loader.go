package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

func LoadInventory(path string) (*Inventory, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read inventory %s: %w", path, err)
	}

	var inv Inventory
	if err := yaml.Unmarshal(data, &inv); err != nil {
		return nil, fmt.Errorf("decode inventory %s: %w", path, err)
	}
	applyInventoryDefaults(&inv)
	if err := ValidateInventory(&inv); err != nil {
		return nil, err
	}
	return &inv, nil
}

func applyInventoryDefaults(inv *Inventory) {
	if inv == nil {
		return
	}
	if inv.Network.VpcCIDR == "" {
		inv.Network.VpcCIDR = "10.0.0.0/12"
	}
	if !inv.Stacks.TKE.ClusterInternet {
		inv.Stacks.TKE.ClusterInternet = true
	}
	if len(inv.Stacks.TKE.ClusterInternetCIDRs) == 0 {
		inv.Stacks.TKE.ClusterInternetCIDRs = []string{"0.0.0.0/0"}
	}
}
