package main

import (
	"context"
	"log"
	"time"

	"git.woa.com/wisp/mono/referral/internal/config"
	"git.woa.com/wisp/mono/referral/internal/domain"
	"git.woa.com/wisp/mono/referral/internal/store"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	campaign := domain.Campaign{
		ID: cfg.Campaign.ID, Name: cfg.Campaign.Name, Status: cfg.Campaign.Status,
		StartsAt: cfg.Campaign.StartsAt, EndsAt: cfg.Campaign.EndsAt,
		InviterCredit: cfg.Campaign.InviterCredit, InviteeCredit: cfg.Campaign.InviteeCredit,
		VestingDays:    cfg.Campaign.VestingDays,
		PendingTTLDays: cfg.Campaign.PendingTTLDays, MaxRewardsPerInviter: cfg.Campaign.MaxRewardsPerInviter,
		BudgetCredit: cfg.Campaign.BudgetCredit,
	}
	st, err := store.NewMySQLStore(cfg.MySQLDSN)
	if err != nil {
		log.Fatalf("init referral store: %v", err)
	}
	defer st.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := st.UpsertCampaign(ctx, campaign); err != nil {
		log.Fatalf("upsert referral campaign: %v", err)
	}
	log.Printf("referral campaign ready: id=%s status=%s", campaign.ID, campaign.Status)
}
