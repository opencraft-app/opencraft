CREATE DATABASE IF NOT EXISTS lightclaw_auth CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS payment CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS subscription CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS ai_gateway CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS sandbox CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS ctl CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS trade CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS mock_control CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'lightclaw_auth'@'%' IDENTIFIED BY 'local_lightclaw_auth';
CREATE USER IF NOT EXISTS 'payment'@'%' IDENTIFIED BY 'local_payment';
CREATE USER IF NOT EXISTS 'subscription'@'%' IDENTIFIED BY 'local_subscription';
CREATE USER IF NOT EXISTS 'ai_gateway'@'%' IDENTIFIED BY 'local_ai_gateway';
CREATE USER IF NOT EXISTS 'sandbox'@'%' IDENTIFIED BY 'local_sandbox';
CREATE USER IF NOT EXISTS 'trade'@'%' IDENTIFIED BY 'local_trade';
CREATE USER IF NOT EXISTS 'mock_control'@'%' IDENTIFIED BY 'local_mock_control';

GRANT ALL PRIVILEGES ON lightclaw_auth.* TO 'lightclaw_auth'@'%';
GRANT ALL PRIVILEGES ON payment.* TO 'payment'@'%';
GRANT ALL PRIVILEGES ON subscription.* TO 'subscription'@'%';
GRANT ALL PRIVILEGES ON ai_gateway.* TO 'ai_gateway'@'%';
GRANT ALL PRIVILEGES ON sandbox.* TO 'sandbox'@'%';
GRANT ALL PRIVILEGES ON trade.* TO 'trade'@'%';
GRANT ALL PRIVILEGES ON mock_control.* TO 'mock_control'@'%';

FLUSH PRIVILEGES;
