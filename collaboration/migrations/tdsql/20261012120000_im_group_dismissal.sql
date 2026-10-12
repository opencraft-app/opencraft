-- Who dismissed a platform group and, for admin dismissals, the reason shown to its members.
ALTER TABLE `im_groups`
  ADD COLUMN `dismissed_by` varchar(16) NULL,
  ADD COLUMN `dismiss_reason` varchar(200) NULL;
