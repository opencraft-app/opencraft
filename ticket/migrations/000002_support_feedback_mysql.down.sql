-- 000002_support_feedback_mysql.down.sql

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS `support_feedback_attachment`;
DROP TABLE IF EXISTS `support_feedback`;

SET FOREIGN_KEY_CHECKS = 1;
