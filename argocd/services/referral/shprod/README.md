# Referral Shanghai activation

This directory deploys the Shanghai Referral campaign:

- Referral API replicas: 2
- Referral worker replicas: 2
- `REFERRAL_ENABLED=true`
- `REFERRAL_PROCESSING_ENABLED=true`
- campaign bootstrap runs as an Argo PostSync hook

Auth/CTL relays, exact Gateway routes, and the CTL runtime flag are released as
the same source activation but remain separately ordered Argo applications.
Shanghai owns an independent campaign and never inherits the Beijing campaign.
