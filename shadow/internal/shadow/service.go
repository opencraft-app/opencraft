package shadow

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"shadow/internal/billing"
	"shadow/internal/platform"
	"shadow/internal/storage"
)

var (
	ErrAlreadyRegistered = errors.New("shadow account already registered")
	ErrInvalidUserID     = errors.New("invalid user id")
	ErrDuplicatePhone    = errors.New("duplicate phone number")
)

type Service struct {
	store          storage.Store
	cloud          platform.CloudProvider
	billing        billing.Provider
	authCodeTTL    time.Duration
	shadowPlatform string
}

func NewService(store storage.Store, cloud platform.CloudProvider, billingProvider billing.Provider, authCodeTTL time.Duration, shadowPlatform string) *Service {
	return &Service{
		store:          store,
		cloud:          cloud,
		billing:        billingProvider,
		authCodeTTL:    authCodeTTL,
		shadowPlatform: shadowPlatform,
	}
}

type SendRegisterSMSInput struct {
	CountryCode  string `json:"country_code"`
	PhoneNumber  string `json:"phone_number"`
	ClientIP     string `json:"client_ip"`
	Lang         string `json:"lang"`
	CaptchaAppID string `json:"captcha_app_id"`
	Ticket       string `json:"ticket"`
	Random       string `json:"random"`
}

type SendUpdatePhoneSMSInput struct {
	UserID       string `json:"user_id"`
	CountryCode  string `json:"country_code"`
	PhoneNumber  string `json:"phone_number"`
	ClientIP     string `json:"client_ip"`
	Lang         string `json:"lang"`
	CaptchaAppID string `json:"captcha_app_id"`
	Ticket       string `json:"ticket"`
	Random       string `json:"random"`
}

type RegisterFreeTrialInput struct {
	UserID          string `json:"user_id"`
	CountryCode     string `json:"country_code"`
	PhoneNumber     string `json:"phone_number"`
	PhoneVerifyCode string `json:"phone_verify_code"`
	OrgName         string `json:"org_name"`
	ClientIP        string `json:"client_ip"`
	ClientUA        string `json:"client_ua"`
}

type RegisterFreeTrialOutput struct {
	UserID         string `json:"user_id"`
	ShadowUserName string `json:"shadow_user_name"`
	Uin            int64  `json:"uin"`
	OwnerUin       int64  `json:"owner_uin"`
	AppID          int64  `json:"appid"`
	InstanceID     string `json:"instance_id"`
	BigDealID      string `json:"big_deal_id"`
}

type RedirectInput struct {
	UserID  string
	Mode    string
	Console string
}

type UpdatePhoneInput struct {
	UserID              string `json:"user_id"`
	NewPhoneCountryCode string `json:"new_country_code"`
	NewPhoneNumber      string `json:"new_phone_number"`
	VerifyCode          string `json:"verify_code"`
}

type AuthenticateUserInput struct {
	UserID            string `json:"user_id"`
	Name              string `json:"name"`
	Type              int64  `json:"type"`
	Area              int64  `json:"area"`
	Checker           string `json:"checker"`
	CheckType         string `json:"check_type"`
	Addr              string `json:"addr"`
	IdcardType        int64  `json:"idcard_type"`
	Idcard            string `json:"idcard"`
	Contact           string `json:"contact"`
	Province          string `json:"province"`
	City              string `json:"city"`
	District          string `json:"district"`
	CreditCode        string `json:"credit_code"`
	OrgCode           string `json:"org_code"`
	LegalPersonIdcard string `json:"legal_person_idcard"`
}

type DescribeBasicAuthOutput struct {
	UserID                 string `json:"user_id"`
	IsStandardRealnameAuth bool   `json:"is_standard_realname_auth"`
	AccountOwnerUin        int64  `json:"account_owner_uin"`
	AccountType            int64  `json:"account_type"`
	Name                   string `json:"name"`
	Mobile                 string `json:"mobile"`
	CountryCode            string `json:"country_code"`
	IDCard                 string `json:"idcard"`
}

func (s *Service) SendRegisterSMS(ctx context.Context, in SendRegisterSMSInput) error {
	return s.cloud.SendRegisterSMS(ctx, platform.SendRegisterSMSInput{
		CountryCode:  in.CountryCode,
		PhoneNumber:  in.PhoneNumber,
		ClientIP:     in.ClientIP,
		Lang:         in.Lang,
		CaptchaAppID: in.CaptchaAppID,
		Ticket:       in.Ticket,
		Random:       in.Random,
	})
}

func (s *Service) SendUpdatePhoneSMS(ctx context.Context, in SendUpdatePhoneSMSInput) error {
	if err := ValidateUserID(in.UserID); err != nil {
		return err
	}
	user, err := s.store.GetUserByID(ctx, in.UserID)
	if err != nil {
		return err
	}
	if user.CountryCode == in.CountryCode && user.PhoneNumber == in.PhoneNumber {
		return nil
	}
	if _, err := s.store.GetBindingByUserID(ctx, in.UserID); err != nil {
		return err
	}
	return s.cloud.SendRegisterSMS(ctx, platform.SendRegisterSMSInput{
		CountryCode:  in.CountryCode,
		PhoneNumber:  in.PhoneNumber,
		ClientIP:     in.ClientIP,
		Lang:         in.Lang,
		CaptchaAppID: in.CaptchaAppID,
		Ticket:       in.Ticket,
		Random:       in.Random,
	})
}

func (s *Service) RegisterFreeTrial(ctx context.Context, in RegisterFreeTrialInput) (RegisterFreeTrialOutput, error) {
	if err := ValidateUserID(in.UserID); err != nil {
		return RegisterFreeTrialOutput{}, err
	}
	user, _, err := s.store.EnsureUser(ctx, in.UserID, in.CountryCode, in.PhoneNumber)
	if err != nil {
		return RegisterFreeTrialOutput{}, err
	}
	if _, err := s.store.GetBindingByUserID(ctx, user.ID); err == nil {
		return RegisterFreeTrialOutput{}, ErrAlreadyRegistered
	}

	shadowUserName := user.ID
	cloudAccountPassword := CloudAccountPassword(user.ID, user.CountryCode, user.PhoneNumber)
	if !user.IsRegisterShadowAccount {
		_, err := s.cloud.RegisterShadowAccount(ctx, platform.RegisterShadowAccountInput{
			ClientUA:    in.ClientUA,
			ClientIP:    in.ClientIP,
			CountryName: "CN",
			// Keep CountryCode as the raw mainland China code (86), not +86.
			// Tencent Cloud platform-side validation is sensitive to these region fields.
			CountryCode:  in.CountryCode,
			RegisterType: "phone",
			Lang:         "zh",
			// NOTE: old code fixed Area=1 for CN, but the current platform config may
			// expect a different value. Recheck the internal country/area mapping docs
			// before changing this field.
			Area:            1,
			AccessLevel:     2,
			PhoneNumber:     in.PhoneNumber,
			PhoneVerifyCode: in.PhoneVerifyCode,
			// Tencent Cloud test env echoes UserName back through the
			// checkSaaSAccountExist callback as user_id, so this must stay aligned
			// with the SaaS-visible shadow user id format.
			UserName: shadowUserName,
			// Phone registration may require Password on some Tencent Cloud
			// SaaS platform configurations, so send a stable generated value.
			Password: cloudAccountPassword,
		})
		if err != nil {
			return RegisterFreeTrialOutput{}, err
		}
		if err := s.store.MarkShadowAccountRegistered(ctx, user.ID); err != nil {
			return RegisterFreeTrialOutput{}, err
		}
		user.IsRegisterShadowAccount = true
	}

	saasToken, err := s.issueSaaSToken(ctx, user.ID, in.ClientIP, in.ClientUA)
	if err != nil {
		return RegisterFreeTrialOutput{}, err
	}
	if !user.IsShadowAccountBasicAuth {
		creds, err := s.cloud.GetSaaSAccessToken(ctx, saasToken, in.ClientIP, in.ClientUA)
		if err != nil {
			return RegisterFreeTrialOutput{}, err
		}
		if err := s.cloud.SaveBasicAuth(ctx, platform.SaveBasicAuthInput{
			AccountType: 0,
			Name:        shadowUserName,
			Creds:       creds,
		}); err != nil {
			return RegisterFreeTrialOutput{}, err
		}
		if err := s.store.MarkShadowAccountBasicAuth(ctx, user.ID); err != nil {
			return RegisterFreeTrialOutput{}, err
		}
		user.IsShadowAccountBasicAuth = true
	}

	appID, err := s.cloud.GetAppIDByUin(ctx, saasToken.Uin)
	if err != nil {
		return RegisterFreeTrialOutput{}, err
	}
	orderCheckpoint, err := s.store.GetFreeTrialOrderCheckpointByUserID(ctx, user.ID)
	if err != nil {
		if !errors.Is(err, storage.ErrNotFound) {
			return RegisterFreeTrialOutput{}, err
		}
		order, err := s.billing.CreateFreeTrialOrderAndPay(ctx, billing.FreeTrialOrderInput{
			UserID:         user.ID,
			ShadowUserName: shadowUserName,
			CountryCode:    user.CountryCode,
			PhoneNumber:    user.PhoneNumber,
			Uin:            saasToken.Uin,
			OwnerUin:       saasToken.OwnerUin,
			AppID:          appID,
			SaaSToken:      saasToken.Token,
			ClientIP:       in.ClientIP,
			ClientUA:       in.ClientUA,
		})
		if err != nil {
			return RegisterFreeTrialOutput{}, err
		}
		orderCheckpoint = storage.FreeTrialOrderCheckpoint{
			UserID:     user.ID,
			BigDealID:  order.BigDealID,
			DealName:   order.DealName,
			InstanceID: order.InstanceID,
			AppID:      appID,
			CreatedAt:  time.Now().UTC(),
		}
		if err := s.store.SaveFreeTrialOrderCheckpoint(ctx, orderCheckpoint); err != nil {
			return RegisterFreeTrialOutput{}, err
		}
	}

	if err := s.store.SaveBinding(ctx, storage.Binding{
		UserID:         user.ID,
		ShadowUserName: shadowUserName,
		Uin:            saasToken.Uin,
		OwnerUin:       saasToken.OwnerUin,
		AppID:          appID,
		InstanceID:     orderCheckpoint.InstanceID,
		CountryCode:    user.CountryCode,
		PhoneNumber:    user.PhoneNumber,
		CreatedAt:      time.Now().UTC(),
	}); err != nil {
		return RegisterFreeTrialOutput{}, err
	}
	if err := s.store.SaveAppPhoneBinding(ctx, appID, user.CountryCode, user.PhoneNumber); err != nil {
		return RegisterFreeTrialOutput{}, err
	}
	if err := s.store.DeletePendingFreeTrialOrderByOwnerUin(ctx, saasToken.OwnerUin); err != nil {
		return RegisterFreeTrialOutput{}, err
	}

	return RegisterFreeTrialOutput{
		UserID:         user.ID,
		ShadowUserName: shadowUserName,
		Uin:            saasToken.Uin,
		OwnerUin:       saasToken.OwnerUin,
		AppID:          appID,
		InstanceID:     orderCheckpoint.InstanceID,
		BigDealID:      orderCheckpoint.BigDealID,
	}, nil
}

func (s *Service) BuildPaymentRedirect(ctx context.Context, in RedirectInput, userAgent string) (string, error) {
	if err := ValidateUserID(in.UserID); err != nil {
		return "", err
	}
	binding, err := s.store.GetBindingByUserID(ctx, in.UserID)
	if err != nil {
		return "", err
	}
	authCode, err := s.store.IssueAuthCode(ctx, binding.UserID, s.authCodeTTL)
	if err != nil {
		return "", err
	}
	targetURL, err := billing.BuildTargetURL(in.Mode, binding.InstanceID, in.Console)
	if err != nil {
		return "", err
	}
	return billing.BuildJumpLoginURL(s.shadowPlatform, authCode.Code, userAgent, targetURL), nil
}

func (s *Service) CheckSaaSAccountExist(ctx context.Context, userID string) (bool, error) {
	if err := ValidateUserID(userID); err != nil {
		return false, nil
	}
	if _, err := s.store.GetUserByID(ctx, userID); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func (s *Service) CheckSaaSAuthCode(ctx context.Context, authCode string) (string, error) {
	record, err := s.store.ConsumeAuthCode(ctx, authCode)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			return "", nil
		}
		return "", err
	}
	return record.UserID, nil
}

func (s *Service) UpdatePhone(ctx context.Context, in UpdatePhoneInput) error {
	if err := ValidateUserID(in.UserID); err != nil {
		return err
	}
	user, err := s.store.GetUserByID(ctx, in.UserID)
	if err != nil {
		return err
	}
	binding, err := s.store.GetBindingByUserID(ctx, in.UserID)
	if err != nil {
		return err
	}
	if in.NewPhoneCountryCode == "" || in.NewPhoneNumber == "" || in.VerifyCode == "" {
		return errors.New("new phone payload is incomplete")
	}
	if user.CountryCode == in.NewPhoneCountryCode && user.PhoneNumber == in.NewPhoneNumber {
		return nil
	}
	if err := s.store.UpdateUserPhone(ctx, in.UserID, in.NewPhoneCountryCode, in.NewPhoneNumber); err != nil {
		if errors.Is(err, storage.ErrConflict) {
			return ErrDuplicatePhone
		}
		return err
	}
	authCode, err := s.store.IssueAuthCode(ctx, in.UserID, s.authCodeTTL)
	if err != nil {
		_ = s.store.UpdateUserPhone(ctx, in.UserID, user.CountryCode, user.PhoneNumber)
		return err
	}
	if err := s.cloud.UpdatePhone(ctx, platform.UpdatePhoneInput{
		OldPhoneCountryCode: user.CountryCode,
		OldPhoneNumber:      user.PhoneNumber,
		NewPhoneCountryCode: in.NewPhoneCountryCode,
		NewPhoneNumber:      in.NewPhoneNumber,
		AuthCode:            authCode.Code,
		VerifyCode:          in.VerifyCode,
	}); err != nil {
		_ = s.store.UpdateUserPhone(ctx, in.UserID, user.CountryCode, user.PhoneNumber)
		return err
	}
	if err := s.store.SaveAppPhoneBinding(ctx, binding.AppID, in.NewPhoneCountryCode, in.NewPhoneNumber); err != nil {
		_ = s.store.UpdateUserPhone(ctx, in.UserID, user.CountryCode, user.PhoneNumber)
		return err
	}
	return nil
}

func (s *Service) AuthenticateUser(ctx context.Context, in AuthenticateUserInput) error {
	if err := ValidateUserID(in.UserID); err != nil {
		return err
	}
	if strings.TrimSpace(in.Name) == "" || strings.TrimSpace(in.Checker) == "" || strings.TrimSpace(in.CheckType) == "" {
		return errors.New("realname payload is incomplete")
	}
	binding, err := s.store.GetBindingByUserID(ctx, in.UserID)
	if err != nil {
		return err
	}
	if err := s.cloud.AuthenticateUser(ctx, platform.AuthenticateUserInput{
		AuthUin:           binding.Uin,
		Name:              in.Name,
		Type:              in.Type,
		Area:              in.Area,
		Checker:           in.Checker,
		CheckType:         in.CheckType,
		Addr:              in.Addr,
		IdcardType:        in.IdcardType,
		Idcard:            in.Idcard,
		Contact:           in.Contact,
		Province:          in.Province,
		City:              in.City,
		District:          in.District,
		CreditCode:        in.CreditCode,
		OrgCode:           in.OrgCode,
		LegalPersonIdcard: in.LegalPersonIdcard,
	}); err != nil {
		return err
	}
	return s.store.MarkStandardRealnameAuth(ctx, in.UserID)
}

func (s *Service) DescribeBasicAuth(ctx context.Context, userID string) (DescribeBasicAuthOutput, error) {
	if err := ValidateUserID(userID); err != nil {
		return DescribeBasicAuthOutput{}, err
	}
	user, err := s.store.GetUserByID(ctx, userID)
	if err != nil {
		return DescribeBasicAuthOutput{}, err
	}
	auth, err := s.cloud.DescribeBasicAuth(ctx)
	if err != nil {
		return DescribeBasicAuthOutput{}, err
	}
	return DescribeBasicAuthOutput{
		UserID:                 userID,
		IsStandardRealnameAuth: user.IsStandardRealnameAuth,
		AccountOwnerUin:        auth.AccountOwnerUin,
		AccountType:            auth.AccountType,
		Name:                   auth.Name,
		Mobile:                 auth.Mobile,
		CountryCode:            auth.CountryCode,
		IDCard:                 auth.IDCard,
	}, nil
}

func (s *Service) issueSaaSToken(ctx context.Context, userID string, clientIP, clientUA string) (platform.SaaSTokenResult, error) {
	bootstrapCode, err := s.store.IssueAuthCode(ctx, userID, s.authCodeTTL)
	if err != nil {
		return platform.SaaSTokenResult{}, err
	}
	return s.cloud.GetSaaSTokenByAuthCode(ctx, bootstrapCode.Code, clientIP, clientUA)
}

func CloudAccountPassword(userID, countryCode, phoneNumber string) string {
	seed := fmt.Sprintf("password:%s:%s:%s", userID, strings.TrimSpace(countryCode), strings.TrimSpace(phoneNumber))
	return "Aa1" + strings.ReplaceAll(uuid.NewSHA1(uuid.NameSpaceURL, []byte(seed)).String(), "-", "")
}

func ValidateUserID(v string) error {
	if len(strings.TrimSpace(v)) == 0 || len(v) > 60 {
		return ErrInvalidUserID
	}
	return nil
}
