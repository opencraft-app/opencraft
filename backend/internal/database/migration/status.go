package migration

import (
	"context"
	"database/sql"

	atlasmigrate "ariga.io/atlas/sql/migrate"
	"chatserver/internal/apperror"
	"chatserver/internal/config"
)

// StatusInfo 是不修改数据库的 migration 状态快照。
type StatusInfo struct {
	Kind              StateKind
	Reason            string
	CurrentVersion    string
	LatestVersion     string
	Applied           int
	Pending           int
	AppliedStatements int
	TotalStatements   int
	ChecksumValid     bool
}

// Status 校验内嵌目录并读取 revision 状态，不创建表或修改 PRAGMA。
func Status(ctx context.Context, db *sql.DB) (StatusInfo, error) {
	return StatusFor(ctx, db, config.DatabaseDriverSQLite)
}

// StatusFor 只读检查指定方言的 migration 状态。
func StatusFor(
	ctx context.Context,
	db *sql.DB,
	dialect config.DatabaseDriver,
) (StatusInfo, error) {
	if dialect == config.DatabaseDriverTDSQL {
		return statusTDSQL(ctx, db)
	}
	dir, err := embeddedDirFor(dialect)
	if err != nil {
		return StatusInfo{}, apperror.New("MIGRATION_FAILED", "无法加载内嵌数据库迁移", err)
	}
	defer dir.Close()
	if err := atlasmigrate.Validate(dir); err != nil {
		return StatusInfo{}, apperror.New("MIGRATION_CHECKSUM_MISMATCH", "数据库迁移校验和不一致", err)
	}
	files, err := dir.Files()
	if err != nil {
		return StatusInfo{}, apperror.New("MIGRATION_FAILED", "无法读取内嵌数据库迁移", err)
	}
	checksums, err := dir.Checksum()
	if err != nil {
		return StatusInfo{}, apperror.New("MIGRATION_CHECKSUM_MISMATCH", "无法计算数据库迁移校验和", err)
	}
	info := StatusInfo{Kind: StateEmpty, ChecksumValid: true}
	if len(files) > 0 {
		info.LatestVersion = files[len(files)-1].Version()
	}

	revisions, err := readExistingRevisionsFor(ctx, db, dialect)
	if err != nil {
		return StatusInfo{}, apperror.New("MIGRATION_FAILED", "无法读取数据库迁移状态", err)
	}
	info.Applied = len(revisions)
	known := make(map[string]struct{}, len(files))
	filesByVersion := make(map[string]atlasmigrate.File, len(files))
	for _, file := range files {
		known[file.Version()] = struct{}{}
		filesByVersion[file.Version()] = file
	}
	applied := make(map[string]struct{}, len(revisions))
	for _, revision := range revisions {
		if _, ok := known[revision.Version]; !ok {
			return StatusInfo{}, apperror.New(
				"DATABASE_VERSION_TOO_NEW",
				"数据库版本高于当前程序支持范围",
				nil,
			)
		}
		if revision.Error != "" || revision.Applied != revision.Total {
			return StatusInfo{}, apperror.New("MIGRATION_FAILED", "数据库存在未完成的迁移记录", nil)
		}
		file := filesByVersion[revision.Version]
		expectedHash, err := checksums.SumByName(file.Name())
		if err != nil || revision.Hash != expectedHash {
			return StatusInfo{}, apperror.New(
				"MIGRATION_CHECKSUM_MISMATCH",
				"数据库迁移记录与当前程序校验和不一致",
				err,
			)
		}
		applied[revision.Version] = struct{}{}
		info.CurrentVersion = revision.Version
	}
	for _, file := range files {
		if _, ok := applied[file.Version()]; !ok {
			info.Pending++
		}
	}
	if len(revisions) != 0 {
		info.Kind = StatePending
		if info.Pending == 0 {
			info.Kind = StateClean
		}
	}
	return info, nil
}

func readExistingRevisions(ctx context.Context, db *sql.DB) ([]*atlasmigrate.Revision, error) {
	return readExistingRevisionsFor(ctx, db, config.DatabaseDriverSQLite)
}

func readExistingRevisionsFor(
	ctx context.Context,
	db *sql.DB,
	dialect config.DatabaseDriver,
) ([]*atlasmigrate.Revision, error) {
	var exists int
	existsQuery := `
		SELECT COUNT(*) FROM sqlite_schema
		WHERE type = 'table' AND name = ?
	`
	if dialect == config.DatabaseDriverTDSQL {
		existsQuery = `
			SELECT COUNT(*) FROM information_schema.tables
			WHERE table_schema = DATABASE() AND table_name = ?
		`
	}
	if err := db.QueryRowContext(ctx, existsQuery, revisionTable).Scan(&exists); err != nil {
		return nil, err
	}
	if exists == 0 {
		return nil, nil
	}
	rows, err := db.QueryContext(ctx, `
		SELECT version, description, revision_type, applied, total, executed_at,
		       execution_time_ns, error, error_stmt, hash, partial_hashes, operator_version
		FROM atlas_schema_revisions
		ORDER BY version
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var revisions []*atlasmigrate.Revision
	for rows.Next() {
		revision, err := scanRevision(rows)
		if err != nil {
			return nil, err
		}
		revisions = append(revisions, revision)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return revisions, nil
}
