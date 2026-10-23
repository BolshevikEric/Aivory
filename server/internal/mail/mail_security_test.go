package mail

import (
	"bytes"
	"log"
	"path/filepath"
	"strings"
	"testing"

	"aivory/server/internal/config"
	"aivory/server/internal/store"
)

func TestSendAuthNeverLogsSecretWhenSMTPIsUnavailable(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "mail-security.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := store.Migrate(db); err != nil {
		t.Fatal(err)
	}
	if err := store.Seed(db, config.Config{}); err != nil {
		t.Fatal(err)
	}
	store.InvalidateConfig()
	var logs bytes.Buffer
	sender := NewSMTPSender(db, log.New(&logs, "", 0))
	err = sender.SendAuth("victim@example.test", AuthMessage{Purpose: "reset", ResetURL: "https://example.test/reset-password#token=123456", Locale: "zh"})
	if err == nil {
		t.Fatal("SendAuth succeeded without SMTP configuration")
	}
	if strings.Contains(logs.String(), "123456") {
		t.Fatalf("SMTP failure leaked verification code to logs: %s", logs.String())
	}
}

func TestSMTPSenderRejectsMalformedConfiguration(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "mail-malformed.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := store.Migrate(db); err != nil {
		t.Fatal(err)
	}
	if err := store.Seed(db, config.Config{}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE settings SET value='not-json' WHERE key='smtp_tls'`); err != nil {
		t.Fatal(err)
	}
	store.InvalidateConfig()
	sender := NewSMTPSender(db, log.New(&bytes.Buffer{}, "", 0))
	if err := sender.SendAuth("victim@example.test", AuthMessage{Purpose: "verify", Code: "654321", Locale: "zh"}); err == nil {
		t.Fatal("SendAuth accepted malformed SMTP configuration")
	}
}
