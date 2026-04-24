-- id_gen: 业务对象 ID 自增计数器
-- 参考 lightpower 的 id_gen 表设计，使用 name + max_id 实现原子自增
CREATE TABLE IF NOT EXISTS `id_gen` (
    `id`   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(50) NOT NULL,
    `max_id` BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 预置 pass 资源类型的起始行
INSERT IGNORE INTO `id_gen` (`name`, `max_id`) VALUES ('pass', 0);
