package mail

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"net/textproto"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"aivory/server/internal/store"
)

func exampleDeliveryConfig() DeliveryConfig {
	cfg := EmptyDeliveryConfig()
	cfg.Accounts = []SMTPAccount{
		{ID: "security", Name: "Security", Host: "smtp.example.test", Port: "587", User: "security@example.test", Password: "first-secret", From: "Aivory <security@example.test>"},
		{ID: "members", Name: "Members", Host: "smtp.example.test", Port: "465", User: "members@example.test", Password: "second-secret", TLS: true},
	}
	for _, purpose := range Purposes {
		cfg.Rules[purpose] = DeliveryRule{AccountID: "security", Enabled: true}
	}
	cfg.Rules["membership"] = DeliveryRule{AccountID: "members", Enabled: true}
	return cfg
}

func TestDeliveryConfigMasksAndPreservesPasswordsByAccountID(t *testing.T) {
	previous := exampleDeliveryConfig()
	masked := MaskDeliveryConfig(previous)
	if previous.Accounts[0].Password != "first-secret" || masked.Accounts[1].Password != PasswordMask {
		t.Fatal("mask mutated the stored account or exposed a password")
	}
	masked.Accounts[0], masked.Accounts[1] = masked.Accounts[1], masked.Accounts[0]
	raw, _ := json.Marshal(masked)
	got, err := NormalizeDeliveryConfig(raw, previous)
	if err != nil || got.Accounts[0].Password != "second-secret" || got.Accounts[1].Password != "first-secret" {
		t.Fatalf("password merge = %+v %v", MaskDeliveryConfig(got), err)
	}
	masked.Accounts[0].Password = ""
	raw, _ = json.Marshal(masked)
	got, err = NormalizeDeliveryConfig(raw, previous)
	if err != nil || got.Accounts[0].Password != "" {
		t.Fatal("clearing a password was ignored")
	}
}

func TestDeliveryConfigRejectsBrokenRoutesAndDisablingSecurityEmails(t *testing.T) {
	for _, name := range []string{"verify-disabled", "reset-disabled", "missing-account", "duplicate-id", "bad-host", "bad-port", "bad-from", "unknown-type", "new-masked-account", "empty"} {
		t.Run(name, func(t *testing.T) {
			cfg := exampleDeliveryConfig()
			switch name {
			case "verify-disabled":
				cfg.Rules["verify"] = DeliveryRule{AccountID: "security", Enabled: false}
			case "reset-disabled":
				cfg.Rules["reset"] = DeliveryRule{AccountID: "security", Enabled: false}
			case "missing-account":
				cfg.Accounts = cfg.Accounts[:1]
			case "duplicate-id":
				cfg.Accounts[1].ID = cfg.Accounts[0].ID
			case "bad-host":
				cfg.Accounts[0].Host = "https://smtp.example.test/path"
			case "bad-port":
				cfg.Accounts[0].Port = "0"
			case "bad-from":
				cfg.Accounts[0].From = "sender\r\nBcc: other@example.test"
			case "unknown-type":
				cfg.Rules["unknown"] = DeliveryRule{AccountID: "security", Enabled: true}
			case "new-masked-account":
				cfg.Accounts[1].ID = "new"
				cfg.Accounts[1].Password = PasswordMask
			case "empty":
				cfg.Accounts = nil
			}
			raw, _ := json.Marshal(cfg)
			if _, err := NormalizeDeliveryConfig(raw, DeliveryConfig{}); err == nil {
				t.Fatal("invalid configuration accepted")
			}
		})
	}
	for _, raw := range []string{`null`, `{"accounts":[]}`, `{"unknown":true}`, `{} {}`} {
		if _, err := NormalizeDeliveryConfig(json.RawMessage(raw), DeliveryConfig{}); err == nil {
			t.Fatal("invalid object accepted")
		}
	}
}

func smtpMailbox(t *testing.T) (string, <-chan string) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	messages := make(chan string, 8)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			func() {
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
				reader := textproto.NewReader(bufio.NewReader(conn))
				_, _ = io.WriteString(conn, "220 test ESMTP\r\n")
				for {
					line, err := reader.ReadLine()
					if err != nil {
						return
					}
					switch {
					case strings.HasPrefix(line, "EHLO"), strings.HasPrefix(line, "HELO"):
						_, _ = io.WriteString(conn, "250 test\r\n")
					case line == "DATA":
						_, _ = io.WriteString(conn, "354 Send message\r\n")
						body, err := reader.ReadDotBytes()
						if err != nil {
							return
						}
						messages <- string(body)
						_, _ = io.WriteString(conn, "250 Queued\r\n")
					case line == "QUIT":
						_, _ = io.WriteString(conn, "221 Bye\r\n")
						return
					default:
						_, _ = io.WriteString(conn, "250 OK\r\n")
					}
				}
			}()
		}
	}()
	t.Cleanup(func() { _ = listener.Close(); <-done })
	_, port, _ := net.SplitHostPort(listener.Addr().String())
	return port, messages
}

func TestSMTPSenderUsesSelectedAccountAndLiveDeliverySwitches(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "delivery.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close(); store.InvalidateConfig() })
	if err := store.Migrate(db); err != nil {
		t.Fatal(err)
	}
	store.InvalidateConfig()
	firstPort, first := smtpMailbox(t)
	secondPort, second := smtpMailbox(t)
	cfg := exampleDeliveryConfig()
	for i := range cfg.Accounts {
		cfg.Accounts[i].Host = "127.0.0.1"
		cfg.Accounts[i].TLS = false
	}
	cfg.Accounts[0].Port, cfg.Accounts[1].Port = firstPort, secondPort
	if err := store.SetSetting(db, DeliverySettingKey, cfg); err != nil {
		t.Fatal(err)
	}
	if !SecurityReady(db) {
		t.Fatal("valid required-email accounts reported unavailable")
	}
	sender := NewSMTPSender(db, nil)
	if err := sender.SendAuth("recipient@example.test", AuthMessage{Purpose: "verify", Code: "123456", Locale: "zh"}); err != nil {
		t.Fatal(err)
	}
	if err := sender.SendAuth("recipient@example.test", AuthMessage{Purpose: "membership", GroupName: "Pro", Locale: "fr"}); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		messages <-chan string
		from     string
	}{{first, "security@example.test"}, {second, "members@example.test"}} {
		select {
		case body := <-test.messages:
			if !strings.Contains(body, test.from) {
				t.Fatal("wrong sender address")
			}
		case <-time.After(3 * time.Second):
			t.Fatal("selected SMTP account did not receive the message")
		}
	}
	cfg.Rules["welcome"] = DeliveryRule{AccountID: "security", Enabled: false}
	cfg.Rules["membership"] = DeliveryRule{AccountID: "members", Enabled: false}
	// Even a malformed persisted switch cannot turn off a mandatory email.
	cfg.Rules["verify"] = DeliveryRule{AccountID: "security", Enabled: false}
	if err := store.SetSetting(db, DeliverySettingKey, cfg); err != nil {
		t.Fatal(err)
	}
	if err := sender.SendAuth("recipient@example.test", AuthMessage{Purpose: "welcome"}); err != nil {
		t.Fatal(err)
	}
	if err := sender.SendAuth("recipient@example.test", AuthMessage{Purpose: "membership", GroupName: "Pro"}); err != nil {
		t.Fatal(err)
	}
	if err := sender.SendAuth("recipient@example.test", AuthMessage{Purpose: "verify", Code: "654321"}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-first:
	case <-time.After(3 * time.Second):
		t.Fatal("mandatory verification email was disabled")
	}
	select {
	case <-first:
		t.Fatal("welcome email ignored its disabled switch")
	case <-second:
		t.Fatal("membership email ignored its disabled switch")
	default:
	}
}

func TestLegacySMTPAccountRemainsUsableAndMigratesWithoutLosingItsPassword(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "legacy.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close(); store.InvalidateConfig() })
	if err := store.Migrate(db); err != nil {
		t.Fatal(err)
	}
	store.InvalidateConfig()
	for key, value := range map[string]string{"smtp_host": "smtp.example.test", "smtp_from": "noreply@example.test", "smtp_password": "legacy-secret"} {
		if err := store.SetSetting(db, key, value); err != nil {
			t.Fatal(err)
		}
	}
	cfg, err := LoadDeliveryConfig(db)
	if err != nil || len(cfg.Accounts) != 1 || cfg.Rules["reset"].AccountID != "legacy" || !SecurityReady(db) {
		t.Fatalf("legacy config: %v", err)
	}
	raw, _ := json.Marshal(MaskDeliveryConfig(cfg))
	next, err := NormalizeDeliveryConfig(raw, cfg)
	if err != nil || next.Accounts[0].Password != "legacy-secret" {
		t.Fatal("legacy password was not preserved")
	}
}
