# Referral Shanghai foundation

This directory deploys only the disabled Shanghai Referral foundation:

- Referral API replicas: 2
- Referral worker replicas: 0
- `REFERRAL_ENABLED=false`
- `REFERRAL_PROCESSING_ENABLED=false`
- no campaign bootstrap Job
- no Auth/CTL relay, Gateway route, or frontend activation

Production activation is a separate reviewed change after schema migration and
API health are verified. Shanghai never inherits the Beijing campaign.
