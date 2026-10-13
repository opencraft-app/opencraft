package cli

import (
	"context"
	"crypto/rand"
	"flag"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	tencentimadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/tencentim"
	"git.woa.com/wisp/mono2/collaboration/internal/apperror"
	"git.woa.com/wisp/mono2/collaboration/internal/database"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/account"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/agent"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/imgroup"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/imgroupmember"
	botimport "git.woa.com/wisp/mono2/collaboration/internal/ports/botim"
	clockport "git.woa.com/wisp/mono2/collaboration/internal/ports/clock"
	tencentimport "git.woa.com/wisp/mono2/collaboration/internal/ports/tencentim"
)

// imAccountRecord 是平台为一个腾讯 IM 账号保存的事实。腾讯不提供列出全部账号的接口，
// 所以平台库是账号清单的唯一来源：三条导入路径都先落库再调用 account_import。
type imAccountRecord struct {
	Kind     string // human / bot / agent
	UserID   string
	Nick     string
	State    string
	Owner    string
	Expected string // present / retired / pending
	Tencent  string // imported / missing / 空（未核对）
}

func expectation(kind, state string) string {
	switch {
	case state == "ready":
		return "present"
	case kind == "bot" && state == botimport.BotStateDeleted, kind == "agent" && state == "deleted":
		// 体验版会删掉腾讯账号；付费版不允许删除，账号下线后闲置。两种都不算不一致。
		return "retired"
	default:
		return "pending"
	}
}

func loadIMAccountRecords(ctx context.Context, handle *database.Handle) ([]imAccountRecord, error) {
	client := handle.Client()
	var records []imAccountRecord
	humans, err := client.Account.Query().Where(account.ImUserIDNEQ("")).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, entity := range humans {
		records = append(records, imAccountRecord{
			Kind: "human", UserID: entity.ImUserID, Nick: entity.DisplayName, State: entity.ImState, Owner: entity.ID,
			Expected: expectation("human", entity.ImState),
		})
	}
	bots, err := client.BotAgent.Query().All(ctx)
	if err != nil {
		return nil, err
	}
	for _, entity := range bots {
		records = append(records, imAccountRecord{
			Kind: "bot", UserID: entity.ImUserID, Nick: entity.DisplayName, State: entity.State,
			Owner:    entity.AccountID + " " + entity.InstanceID + "/" + entity.BotID,
			Expected: expectation("bot", entity.State),
		})
	}
	agents, err := client.Agent.Query().Where(agent.ImUserIDNEQ("")).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, entity := range agents {
		records = append(records, imAccountRecord{
			Kind: "agent", UserID: entity.ImUserID, State: entity.ImState, Owner: entity.ServerID,
			Expected: expectation("agent", entity.ImState),
		})
	}
	sort.Slice(records, func(i, j int) bool {
		if records[i].Kind != records[j].Kind {
			return records[i].Kind < records[j].Kind
		}
		return records[i].UserID < records[j].UserID
	})
	return records, nil
}

// loadActiveGroups 读取进行中的平台群及其在群成员，用于在腾讯侧补建。
func loadActiveGroups(ctx context.Context, handle *database.Handle) ([]botimport.TencentGroup, error) {
	client := handle.Client()
	groups, err := client.IMGroup.Query().Where(imgroup.StateEQ(botimport.GroupStateActive)).All(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]botimport.TencentGroup, 0, len(groups))
	for _, group := range groups {
		members, err := client.IMGroupMember.Query().
			Where(imgroupmember.GroupIDEQ(group.ID), imgroupmember.StateEQ(botimport.MemberStateActive)).
			Order(imgroupmember.ByCreatedAt()).All(ctx)
		if err != nil {
			return nil, err
		}
		target := botimport.TencentGroup{GroupID: group.TencentGroupID, Name: group.Name}
		for _, member := range members {
			if member.Role == botimport.RoleOwner {
				target.OwnerUserID = member.ImUserID
			} else {
				target.MemberUserIDs = append(target.MemberUserIDs, member.ImUserID)
			}
		}
		result = append(result, target)
	}
	return result, nil
}

// runIMAccountsCommand 列出平台创建过的全部腾讯 IM 账号；--check 时逐个向腾讯核对，
// 找出“平台认为在但腾讯没有”和“平台已删除但腾讯还在”的账号。--repair 在核对后把平台认为就绪但腾讯没有的账号补导入，
// 并在腾讯侧补建进行中的平台群（换 SDKAppID 或腾讯侧被删后恢复）；不改平台数据库，可与 serve 并存。
func runIMAccountsCommand(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	var (
		adminUserID, secretFile, restBaseURL string
		sdkAppID                             int
		check, list, repair                  bool
	)
	own := make([]string, 0, len(args))
	filtered := make([]string, 0, len(args))
	for index := 0; index < len(args); index++ {
		name, _, hasValue := strings.Cut(strings.TrimLeft(args[index], "-"), "=")
		switch name {
		case "check", "list", "repair":
			own = append(own, args[index])
		case "im-sdk-app-id", "im-admin-user-id", "im-secret-key-file", "im-rest-base-url":
			own = append(own, args[index])
			if !hasValue && index+1 < len(args) {
				own = append(own, args[index+1])
				index++
			}
		default:
			filtered = append(filtered, args[index])
		}
	}
	flags := flag.NewFlagSet("im accounts", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.BoolVar(&check, "check", false, "向腾讯核对每个账号是否存在")
	flags.BoolVar(&list, "list", false, "逐个列出账号")
	flags.BoolVar(&repair, "repair", false, "核对后补导入缺失账号，并在腾讯侧补建进行中的平台群")
	flags.IntVar(&sdkAppID, "im-sdk-app-id", 0, "腾讯云 IM SDKAppID")
	flags.StringVar(&adminUserID, "im-admin-user-id", "", "腾讯云 IM 管理员 UserID")
	flags.StringVar(&secretFile, "im-secret-key-file", "", "腾讯云 IM SecretKey 文件")
	flags.StringVar(&restBaseURL, "im-rest-base-url", defaultIMRESTBaseURL, "腾讯云 IM REST API 基础 URL")
	if err := flags.Parse(own); err != nil || flags.NArg() != 0 {
		writeCommandError(stderr, apperror.New("CONFIG_INVALID", "im accounts 参数无效", err))
		return 2
	}
	check = check || repair
	if check && (sdkAppID <= 0 || strings.TrimSpace(adminUserID) == "" || strings.TrimSpace(secretFile) == "") {
		writeCommandError(stderr, apperror.New("CONFIG_INVALID", "--check 需要完整的腾讯云 IM 配置", nil))
		return 2
	}
	cfg, err := parseDatabaseConfig("im accounts", filtered)
	if err != nil {
		writeCommandError(stderr, err)
		return exitCode(err)
	}
	handle, err := database.OpenReadOnly(ctx, cfg)
	if err != nil {
		writeCommandError(stderr, err)
		return exitCode(err)
	}
	defer handle.Close()
	records, err := loadIMAccountRecords(ctx, handle)
	if err != nil {
		writeCommandError(stderr, apperror.New("DATABASE_READ_FAILED", "无法读取 IM 账号记录", err))
		return 1
	}

	if check && len(records) > 0 {
		secret, err := loadTextSecret(secretFile, "腾讯云 IM 密钥")
		if err != nil {
			writeCommandError(stderr, err)
			return exitCode(err)
		}
		userSigs, err := tencentimadapter.NewUserSigIssuer(sdkAppID, secret, clockport.System{})
		var provisioner *tencentimadapter.RESTIdentityProvisioner
		if err == nil {
			provisioner, err = tencentimadapter.NewRESTIdentityProvisioner(tencentimadapter.RESTConfig{
				SDKAppID: sdkAppID, AdminUserID: adminUserID, BaseURL: restBaseURL,
				HTTPClient: &http.Client{Timeout: 15 * time.Second}, Random: rand.Reader,
				AdminSignatures: userSigs, AdminSigTTL: 10 * time.Minute,
			})
		}
		var imported map[string]bool
		if err == nil {
			userIDs := make([]string, 0, len(records))
			for _, record := range records {
				userIDs = append(userIDs, record.UserID)
			}
			imported, err = provisioner.CheckIdentities(ctx, userIDs)
		}
		if err != nil {
			writeCommandError(stderr, apperror.New("TENCENT_CHECK_FAILED", "无法向腾讯核对账号", err))
			return 1
		}
		for index := range records {
			records[index].Tencent = "missing"
			if imported[records[index].UserID] {
				records[index].Tencent = "imported"
			}
		}
		if repair {
			groupManager, err := tencentimadapter.NewRESTGroupManager(tencentimadapter.RESTConfig{
				SDKAppID: sdkAppID, AdminUserID: adminUserID, BaseURL: restBaseURL,
				HTTPClient: &http.Client{Timeout: 15 * time.Second}, Random: rand.Reader,
				AdminSignatures: userSigs, AdminSigTTL: 10 * time.Minute,
			})
			if err != nil {
				writeCommandError(stderr, apperror.New("CONFIG_INVALID", "腾讯云 IM 群配置无效", err))
				return 2
			}
			if code := repairTencent(ctx, handle, records, provisioner, groupManager, stdout, stderr); code != 0 {
				return code
			}
		}
	}
	writeIMAccountReport(stdout, records, check, list)
	return 0
}

// repairTencent 补导入平台认为就绪但腾讯没有的账号，再补建进行中的平台群（建群要求成员已存在）。
func repairTencent(
	ctx context.Context, handle *database.Handle, records []imAccountRecord,
	identities *tencentimadapter.RESTIdentityProvisioner, groups *tencentimadapter.RESTGroupManager, stdout, stderr io.Writer,
) int {
	repaired := 0
	for index, record := range records {
		if record.Expected != "present" || record.Tencent == "imported" {
			continue
		}
		if err := identities.EnsureIdentity(ctx, tencentimport.Identity{UserID: record.UserID, Nick: record.Nick}); err != nil {
			writeCommandError(stderr, apperror.New("TENCENT_REPAIR_FAILED", "无法补导入账号 "+record.UserID, err))
			return 1
		}
		records[index].Tencent = "imported"
		repaired++
	}
	active, err := loadActiveGroups(ctx, handle)
	if err != nil {
		writeCommandError(stderr, apperror.New("DATABASE_READ_FAILED", "无法读取平台群", err))
		return 1
	}
	for _, group := range active {
		if err := groups.EnsureGroup(ctx, group); err != nil {
			writeCommandError(stderr, apperror.New("TENCENT_REPAIR_FAILED", "无法补建群 "+group.GroupID, err))
			return 1
		}
	}
	fmt.Fprintf(stdout, "已补导入 %d 个账号，已确认 %d 个进行中的平台群在腾讯侧存在\n", repaired, len(active))
	return 0
}

func writeIMAccountReport(output io.Writer, records []imAccountRecord, checked, list bool) {
	type key struct{ kind, state string }
	counts := map[key]int{}
	var keys []key
	occupied, drift := 0, 0
	for _, record := range records {
		k := key{record.Kind, record.State}
		if counts[k] == 0 {
			keys = append(keys, k)
		}
		counts[k]++
		if checked {
			if record.Tencent == "imported" {
				occupied++
			}
			if record.Expected == "present" && record.Tencent != "imported" {
				drift++
			}
		} else if record.Expected != "retired" {
			occupied++
		}
	}
	table := tabwriter.NewWriter(output, 0, 2, 2, ' ', 0)
	fmt.Fprintln(table, "类型\t状态\t数量")
	for _, k := range keys {
		fmt.Fprintf(table, "%s\t%s\t%d\n", k.kind, k.state, counts[k])
	}
	_ = table.Flush()
	if checked {
		fmt.Fprintf(output, "平台记录 %d 个账号，腾讯侧存在 %d 个，与预期不符 %d 个\n", len(records), occupied, drift)
	} else {
		fmt.Fprintf(output, "平台记录 %d 个账号，占用腾讯账号 %d 个（--check 向腾讯核对）\n", len(records), occupied)
	}
	if !list && drift == 0 {
		return
	}
	table = tabwriter.NewWriter(output, 0, 2, 2, ' ', 0)
	fmt.Fprintln(table, "\n类型\tUserID\t状态\t腾讯\t归属")
	for _, record := range records {
		mismatch := checked && record.Expected == "present" && record.Tencent != "imported"
		if !list && !mismatch {
			continue
		}
		mark := record.Tencent
		if mismatch {
			mark += " (不符)"
		}
		fmt.Fprintf(table, "%s\t%s\t%s\t%s\t%s\n", record.Kind, record.UserID, record.State, mark, record.Owner)
	}
	_ = table.Flush()
}
