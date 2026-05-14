# Using LightVela Safely

LightVela helps you connect AI capabilities to everyday collaboration and messaging channels such as WeChat, Telegram, WhatsApp, Discord, and Slack. To use LightVela safely, avoid entering sensitive, private, or high-risk information when interacting with AI.

## Basic Principles

Before using LightVela, consider whether the content you are about to send is appropriate for AI processing.

Please follow these principles:

- Do not use LightVela as a place to store passwords, secrets, or private information.
- Do not enter information that you are not authorized to share.
- Do not enter data that may affect personal privacy, financial security, medical safety, or business security.
- When using LightVela in shared channels or team workspaces, confirm that the message is appropriate for everyone in that channel to see.
- If you are unsure whether something is sensitive, redact it first or do not send it.

## Accounts, Passwords, and Access Credentials

Do not enter any account credentials in LightVela, including but not limited to:

- Login passwords
- One-time verification codes
- API keys
- Access tokens
- Secret keys
- OAuth tokens
- SSH private keys
- Database connection passwords
- Internal system login information

Incorrect example:

> Help me log in to this system. The account is xxx and the password is xxx.

Recommended approach:

> Please explain how to configure a third-party service API key securely, but do not ask me to send the key directly.

## Financial and Payment Information

Do not enter sensitive financial, payment, or transaction information, including but not limited to:

- Bank card numbers
- Credit card numbers
- CVV / CVC codes
- Bank account information
- Payment passwords
- Wallet private keys
- Seed phrases
- Transaction verification codes
- Sensitive identifiers in invoices

Incorrect example:

> Here is my credit card number and security code. Please check whether I can make a payment.

Recommended approach:

> Please explain the security considerations when designing a payment flow.

## Health and Medical Information

Do not enter personal health, medical diagnosis, or medical record information, including but not limited to:

- Medical records
- Diagnosis reports
- Test results
- Medication history
- Health insurance information
- Mental health records
- Biometric information
- Health status descriptions tied to a specific person

Incorrect example:

> Here is my health check report. Please tell me whether I have a serious illness.

Recommended approach:

> Please provide general suggestions for organizing health information, but do not replace professional medical diagnosis.

## Identity Information and Personal Privacy

Do not enter information that can directly identify an individual, including but not limited to:

- Passport numbers
- Driver's license numbers
- Social security numbers
- Residential addresses
- Personal phone numbers
- Personal email addresses
- Combinations of full name and date of birth
- Biometric information such as face, fingerprint, or voiceprint data

If you need to describe a case, redact the information first.

For example:

- Replace names with "User A"
- Replace phone numbers with "+1-***-***-1234"
- Replace addresses with "a district in a city"
- Replace ID numbers with "ID-****"

## Trade Secrets and Internal Materials

Do not enter unpublished business information or internal company materials, including but not limited to:

- Unreleased product roadmaps
- Business plans
- Financial forecasts
- Customer lists
- Contract terms
- Internal pricing
- Supplier information
- Unreleased marketing plans
- Private repository content
- Security vulnerability details
- Internal system architecture diagrams
- Non-public partnership information

Incorrect example:

> Here is our unreleased product plan for next quarter. Help me write a public announcement.

Recommended approach:

> Based on public information, help me write a general product launch announcement template.

## Customer and Third-Party Data

If you use LightVela in a team or enterprise environment, be especially careful not to enter customer, partner, or third-party private data, including:

- Customer contact information
- Customer order details
- Customer chat records
- User behavior logs
- Personal information in support tickets
- Partner contract content
- Non-public data from third-party platforms

If you need to analyze this type of content, remove information that can identify a person or organization first.

## Notes for Team Collaboration Channels

LightVela may connect to messaging channels such as WeChat, Telegram, WhatsApp, Discord, and Slack. Please remember:

- Messages in group chats or channels may be visible to more members.
- Different platforms have different message retention, forwarding, and permission mechanisms.
- Do not send sensitive information in public channels or multi-person groups.
- Administrators should regularly review which channels are connected to LightVela.
- For production environments, customer groups, or external collaboration channels, use stricter usage rules.

## Recommended Safe Input Patterns

You can ask questions safely in the following ways:

### Use Sample Data

> Here is a sample order dataset. Please help me design an analysis template.

### Use Redacted Information

> User A submitted an order in a certain region, and the order failed. Please help me analyze possible reasons.

### Ask for General Advice

> Please tell me what security issues to consider when designing an OAuth login flow.

### Ask for Templates Instead of Sharing Real Data

> Please give me a customer support email template without using real customer information.

## If You Accidentally Enter Sensitive Information

If you accidentally enter sensitive information in LightVela, we recommend that you immediately:

1. Stop sending related content.
2. Notify your team administrator or security owner.
3. Take remediation steps based on the information type, such as:
   - Change passwords
   - Revoke API keys
   - Rotate tokens
   - Freeze payment credentials
   - Delete or restrict access to related chat records
4. Check whether the information has been forwarded to other channels or members.
5. Update your team's usage guidelines to prevent similar incidents from happening again.

## Recommendations for Team Administrators

If you are a team administrator, we recommend that you:

- Clearly define which channels may connect to LightVela.
- Publish AI usage safety guidelines within your team.
- Remind members not to enter passwords, financial information, health information, or trade secrets.
- Apply stricter access controls for sensitive business scenarios.
- Regularly review bot permissions, channel scope, and integration settings.
- Provide basic AI safety training for new members.

## Summary

LightVela can improve how teams collaborate with AI, but safe usage is equally important. Always avoid entering passwords, financial information, health information, identity information, customer privacy data, and trade secrets.

Before sending a message, ask yourself:

> Is this content safe to share with an AI system for processing?

If the answer is uncertain, redact the content first or do not send it.
