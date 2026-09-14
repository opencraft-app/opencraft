package worker

import (
	"context"
	"log"
	"math"
	"time"

	"github.com/google/uuid"

	"git.woa.com/wisp/mono/referral/internal/broker"
	"git.woa.com/wisp/mono/referral/internal/ctlclient"
	"git.woa.com/wisp/mono/referral/internal/domain"
	"git.woa.com/wisp/mono/referral/internal/service"
	"git.woa.com/wisp/mono/referral/internal/store"
)

type creditGranter interface {
	Grant(context.Context, ctlclient.GrantRequest) (ctlclient.GrantResult, error)
}

type Worker struct {
	store         store.Store
	service       *service.Service
	consumer      broker.Consumer
	granter       creditGranter
	now           func() time.Time
	batchSize     int
	pollInterval  time.Duration
	leaseDuration time.Duration
	leaseOwner    string
}

func New(st store.Store, svc *service.Service, consumer broker.Consumer, granter creditGranter, batchSize int, pollInterval, leaseDuration time.Duration) *Worker {
	return &Worker{
		store: st, service: svc, consumer: consumer, granter: granter,
		now: time.Now, batchSize: batchSize, pollInterval: pollInterval,
		leaseDuration: leaseDuration, leaseOwner: "referral-worker-" + uuid.NewString(),
	}
}

func (w *Worker) Run(ctx context.Context) error {
	errCh := make(chan error, 1)
	go func() { errCh <- w.consume(ctx) }()
	ticker := time.NewTicker(w.pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-errCh:
			return err
		case <-ticker.C:
			w.processRewards(ctx)
		}
	}
}

func (w *Worker) consume(ctx context.Context) error {
	for {
		message, err := w.consumer.Receive(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err
		}
		if err := w.service.Ingest(ctx, message.Payload()); err != nil {
			log.Printf("referral event ingest failed: %v", err)
			w.consumer.Nack(message)
			continue
		}
		if err := w.consumer.Ack(message); err != nil {
			return err
		}
	}
}

func (w *Worker) processRewards(ctx context.Context) {
	now := w.now().UTC()
	if _, err := w.store.CancelExpiredRewards(ctx, now); err != nil {
		log.Printf("cancel expired referral rewards: %v", err)
	}
	rewards, err := w.store.ClaimRewards(ctx, now, w.batchSize, w.leaseOwner, w.leaseDuration)
	if err != nil {
		log.Printf("claim referral rewards: %v", err)
		return
	}
	for _, reward := range rewards {
		w.grant(ctx, reward)
	}
}

func (w *Worker) grant(ctx context.Context, reward domain.Reward) {
	now := w.now().UTC()
	result, err := w.granter.Grant(ctx, ctlclient.GrantRequest{
		UserID: reward.BeneficiaryUserID, CreditAmount: reward.CreditAmount,
		Source: "referral", IdempotencyKey: reward.IdempotencyKey,
		InviteeUserID: reward.InviteeUserID, QualifyingPassID: reward.QualifyingPassID,
	})
	if err == nil {
		if markErr := w.store.MarkRewardGranted(ctx, reward.ID, result.SubscriptionID, result.SubscriptionName, now); markErr != nil {
			log.Printf("mark referral reward granted: %v", markErr)
		}
		return
	}
	backoff := rewardBackoff(reward.AttemptCount)
	if markErr := w.store.MarkRewardRetryable(ctx, reward.ID, "grant_failed", err.Error(), now.Add(backoff)); markErr != nil {
		log.Printf("mark referral reward retryable: %v", markErr)
	}
}

func rewardBackoff(attemptCount int) time.Duration {
	return time.Duration(math.Min(math.Pow(2, float64(attemptCount)), 60)) * time.Minute
}
