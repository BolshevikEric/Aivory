package mail

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	stdmail "net/mail"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"aivory/server/internal/store"
)

const DeliverySettingKey = "email_delivery"
const PasswordMask = "••••••"

var Purposes = []string{"verify", "reset", "welcome", "membership"}

type SMTPAccount struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Host     string `json:"host"`
	Port     string `json:"port"`
	User     string `json:"user"`
	Password string `json:"password"`
	From     string `json:"from"`
	TLS      bool   `json:"tls"`
}

type DeliveryRule struct {
	AccountID string `json:"account_id"`
	Enabled   bool   `json:"enabled"`
}

type DeliveryConfig struct {
	Accounts []SMTPAccount           `json:"accounts"`
	Rules    map[string]DeliveryRule `json:"rules"`
}

func RequiredPurpose(purpose string) bool { return purpose == "verify" || purpose == "reset" }

func EmptyDeliveryConfig() DeliveryConfig {
	cfg := DeliveryConfig{Accounts: []SMTPAccount{}, Rules: map[string]DeliveryRule{}}
	for _, purpose := range Purposes {
		cfg.Rules[purpose] = DeliveryRule{Enabled: true}
	}
	return cfg
}

func decodeDeliveryConfig(raw json.RawMessage) (DeliveryConfig, error) {
	var cfg DeliveryConfig
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return cfg, errors.New("email configuration must be an object")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cfg); err != nil {
		return cfg, errors.New("invalid email configuration")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return cfg, errors.New("invalid email configuration")
	}
	return cfg, nil
}

// Legacy SMTP settings remain usable until an administrator saves the new
// account list. The stable legacy ID also preserves its masked password.
func LoadDeliveryConfig(db *sql.DB) (DeliveryConfig, error) {
	raw, err := store.GetSetting(db, DeliverySettingKey)
	if err == nil {
		return decodeDeliveryConfig(raw)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return DeliveryConfig{}, err
	}
	cfg := EmptyDeliveryConfig()
	account := SMTPAccount{ID: "legacy", Port: "587"}
	for key, dst := range map[string]*string{
		"smtp_host": &account.Host, "smtp_port": &account.Port, "smtp_user": &account.User,
		"smtp_password": &account.Password, "smtp_from": &account.From,
	} {
		value, readErr := store.GetSetting(db, key)
		if errors.Is(readErr, sql.ErrNoRows) {
			continue
		}
		if readErr != nil {
			return cfg, readErr
		}
		if json.Unmarshal(value, dst) != nil {
			return cfg, fmt.Errorf("invalid %s", key)
		}
		*dst = strings.TrimSpace(*dst)
	}
	if raw, readErr := store.GetSetting(db, "smtp_tls"); readErr == nil {
		if json.Unmarshal(raw, &account.TLS) != nil {
			return cfg, errors.New("invalid smtp_tls")
		}
	} else if !errors.Is(readErr, sql.ErrNoRows) {
		return cfg, readErr
	}
	if account.Port == "" {
		account.Port = "587"
	}
	if account.Host != "" {
		account.Name = account.From
		if account.Name == "" {
			account.Name = account.User
		}
		if account.Name == "" {
			account.Name = account.Host
		}
		cfg.Accounts = append(cfg.Accounts, account)
		for _, purpose := range Purposes {
			cfg.Rules[purpose] = DeliveryRule{AccountID: account.ID, Enabled: true}
		}
	}
	return cfg, nil
}

var accountIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)
var smtpHostPattern = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// NormalizeDeliveryConfig merges masked passwords by stable account ID and
// validates the complete account/routing change before anything is persisted.
func NormalizeDeliveryConfig(raw json.RawMessage, previous DeliveryConfig) (DeliveryConfig, error) {
	cfg, err := decodeDeliveryConfig(raw)
	if err != nil {
		return cfg, err
	}
	if len(cfg.Accounts) == 0 || len(cfg.Accounts) > 20 {
		return cfg, errors.New("one to twenty email accounts are required")
	}
	oldPasswords := map[string]string{}
	for _, account := range previous.Accounts {
		oldPasswords[account.ID] = account.Password
	}
	ids := map[string]bool{}
	for i := range cfg.Accounts {
		a := &cfg.Accounts[i]
		a.ID, a.Name, a.Host, a.Port, a.User, a.From = strings.TrimSpace(a.ID), strings.TrimSpace(a.Name), strings.TrimSpace(a.Host), strings.TrimSpace(a.Port), strings.TrimSpace(a.User), strings.TrimSpace(a.From)
		if !accountIDPattern.MatchString(a.ID) || ids[a.ID] || a.Name == "" || utf8.RuneCountInString(a.Name) > 100 {
			return cfg, errors.New("invalid email account identity")
		}
		ids[a.ID] = true
		if a.Password == PasswordMask {
			password, ok := oldPasswords[a.ID]
			if !ok {
				return cfg, errors.New("new email accounts need their own credentials")
			}
			a.Password = password
		}
		if a.Port == "" {
			a.Port = "587"
		}
		if err := validateSMTPAccount(*a); err != nil {
			return cfg, err
		}
	}
	if cfg.Rules == nil {
		cfg.Rules = map[string]DeliveryRule{}
	}
	for purpose := range cfg.Rules {
		known := false
		for _, value := range Purposes {
			if value == purpose {
				known = true
			}
		}
		if !known {
			return cfg, errors.New("unknown email type")
		}
	}
	for _, purpose := range Purposes {
		rule, exists := cfg.Rules[purpose]
		if !exists {
			rule = DeliveryRule{AccountID: cfg.Accounts[0].ID, Enabled: true}
		}
		if RequiredPurpose(purpose) && !rule.Enabled {
			return cfg, errors.New("security emails cannot be disabled")
		}
		if !ids[rule.AccountID] {
			return cfg, errors.New("email type references a missing account")
		}
		cfg.Rules[purpose] = rule
	}
	return cfg, nil
}

func validateSMTPAccount(a SMTPAccount) error {
	if a.Host == "" || len(a.Host) > 253 || (!smtpHostPattern.MatchString(a.Host) && net.ParseIP(a.Host) == nil) {
		return errors.New("invalid SMTP host")
	}
	port, err := strconv.Atoi(a.Port)
	if err != nil || port < 1 || port > 65535 {
		return errors.New("invalid SMTP port")
	}
	if len(a.User) > 320 || strings.ContainsAny(a.User, "\r\n") || len(a.Password) > 4096 {
		return errors.New("invalid SMTP credentials")
	}
	from := a.From
	if from == "" {
		from = a.User
	}
	if len(from) > 500 || strings.ContainsAny(from, "\r\n") {
		return errors.New("invalid SMTP sender")
	}
	if _, err := stdmail.ParseAddress(from); err != nil {
		return errors.New("invalid SMTP sender")
	}
	return nil
}

func MaskDeliveryConfig(cfg DeliveryConfig) DeliveryConfig {
	cfg.Accounts = append([]SMTPAccount{}, cfg.Accounts...)
	for i := range cfg.Accounts {
		if cfg.Accounts[i].Password != "" {
			cfg.Accounts[i].Password = PasswordMask
		}
	}
	return cfg
}

func (s *SMTPSender) configForPurpose(purpose string) (smtpConfig, bool, error) {
	cfg, err := LoadDeliveryConfig(s.DB)
	if err != nil {
		return smtpConfig{}, false, err
	}
	rule, ok := cfg.Rules[purpose]
	if !ok {
		return smtpConfig{}, false, errors.New("email type is not configured")
	}
	if !rule.Enabled && !RequiredPurpose(purpose) {
		return smtpConfig{}, false, nil
	}
	for _, a := range cfg.Accounts {
		if a.ID != rule.AccountID {
			continue
		}
		if err := validateSMTPAccount(a); err != nil {
			return smtpConfig{}, false, err
		}
		from := a.From
		if from == "" {
			from = a.User
		}
		return smtpConfig{Host: a.Host, Port: a.Port, User: a.User, Password: a.Password, From: from, TLS: a.TLS}, true, nil
	}
	return smtpConfig{}, false, errors.New("sending email account is not configured")
}

func SecurityReady(db *sql.DB) bool {
	sender := NewSMTPSender(db, nil)
	for _, purpose := range []string{"verify", "reset"} {
		if _, enabled, err := sender.configForPurpose(purpose); err != nil || !enabled {
			return false
		}
	}
	return true
}
