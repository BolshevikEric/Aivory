package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"aivory/server/internal/mail"
	"aivory/server/internal/store"
)

func emailSettingsFixture(t *testing.T) Deps {
	t.Helper()
	db := openMigrated(t, filepath.Join(t.TempDir(), "email-settings.db"))
	t.Cleanup(func() { _ = db.Close(); store.InvalidateConfig() })
	store.InvalidateConfig()
	for key, value := range map[string]string{"smtp_host": "smtp.example.test", "smtp_from": "security@example.test", "smtp_password": "private-legacy-password"} {
		if err := store.SetSetting(db, key, value); err != nil {
			t.Fatal(err)
		}
	}
	return Deps{DB: db}
}

func getEmailSettings(t *testing.T, d Deps) map[string]json.RawMessage {
	t.Helper()
	rec := httptest.NewRecorder()
	adminSettingsGet(d, rec, httptest.NewRequest(http.MethodGet, "/api/admin/settings", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("settings %d: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "private-legacy-password") || strings.Contains(rec.Body.String(), "second-private-password") {
		t.Fatal("settings response exposed an SMTP password")
	}
	var settings map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &settings); err != nil {
		t.Fatal(err)
	}
	return settings
}

func TestAdminEmailSettingsMigrateMaskAndRetainMultipleSMTPAccounts(t *testing.T) {
	d := emailSettingsFixture(t)
	settings := getEmailSettings(t, d)
	var cfg mail.DeliveryConfig
	if err := json.Unmarshal(settings[mail.DeliverySettingKey], &cfg); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Accounts) != 1 || cfg.Accounts[0].Password != mail.PasswordMask {
		t.Fatal("legacy account not exposed with a masked password")
	}
	cfg.Accounts = append(cfg.Accounts, mail.SMTPAccount{ID: "members", Name: "Memberships", Host: "mail.example.test", Port: "465", From: "members@example.test", Password: "second-private-password", TLS: true})
	cfg.Rules["membership"] = mail.DeliveryRule{AccountID: "members", Enabled: false}
	body, _ := json.Marshal(map[string]any{mail.DeliverySettingKey: cfg})
	rec := runAuthJSONHandler(t, d, adminSettingsSet, "/api/admin/settings", string(body))
	if rec.Code != http.StatusOK {
		t.Fatalf("save %d: %s", rec.Code, rec.Body.String())
	}
	stored, err := mail.LoadDeliveryConfig(d.DB)
	if err != nil || len(stored.Accounts) != 2 || stored.Accounts[0].Password != "private-legacy-password" || stored.Accounts[1].Password != "second-private-password" || stored.Rules["membership"].Enabled {
		t.Fatalf("persisted settings differ: %v", err)
	}
	settings = getEmailSettings(t, d)
	if err := json.Unmarshal(settings[mail.DeliverySettingKey], &cfg); err != nil {
		t.Fatal(err)
	}
	for _, a := range cfg.Accounts {
		if a.Password != mail.PasswordMask {
			t.Fatal("nested password was not masked")
		}
	}
	cfg.Accounts[0], cfg.Accounts[1] = cfg.Accounts[1], cfg.Accounts[0]
	body, _ = json.Marshal(map[string]any{mail.DeliverySettingKey: cfg})
	rec = runAuthJSONHandler(t, d, adminSettingsSet, "/api/admin/settings", string(body))
	if rec.Code != http.StatusOK {
		t.Fatalf("masked resave %d", rec.Code)
	}
	stored, err = mail.LoadDeliveryConfig(d.DB)
	if err != nil || stored.Accounts[0].Password != "second-private-password" || stored.Accounts[1].Password != "private-legacy-password" {
		t.Fatal("reordering mixed up account credentials")
	}
	if ready, err := onboardingSMTPReady(d.DB); err != nil || !ready {
		t.Fatalf("onboarding did not recognize configured email accounts: %v", err)
	}
}

func TestAdminEmailSettingsRejectDisablingRequiredEmailsAndBrokenReferencesAtomically(t *testing.T) {
	for _, purpose := range []string{"verify", "reset", "missing-account"} {
		t.Run(purpose, func(t *testing.T) {
			d := emailSettingsFixture(t)
			cfg, err := mail.LoadDeliveryConfig(d.DB)
			if err != nil {
				t.Fatal(err)
			}
			if purpose == "missing-account" {
				cfg.Rules["welcome"] = mail.DeliveryRule{AccountID: "deleted", Enabled: true}
			} else {
				cfg.Rules[purpose] = mail.DeliveryRule{AccountID: "legacy", Enabled: false}
			}
			body, _ := json.Marshal(map[string]any{mail.DeliverySettingKey: cfg, "smtp_host": "changed.example.test"})
			rec := runAuthJSONHandler(t, d, adminSettingsSet, "/api/admin/settings", string(body))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("invalid config accepted: %d", rec.Code)
			}
			raw, err := store.GetSetting(d.DB, "smtp_host")
			if err != nil || string(raw) != `"smtp.example.test"` {
				t.Fatal("rejected patch partly changed SMTP settings")
			}
		})
	}
}

func TestAdminEmailPreviewIncludesEveryEmailTypeWithoutSending(t *testing.T) {
	for _, purpose := range mail.Purposes {
		req := httptest.NewRequest(http.MethodGet, "/api/admin/email/preview?purpose="+purpose+"&locale=zh", nil)
		rec := httptest.NewRecorder()
		adminEmailPreview(Deps{}, rec, req)
		var preview struct {
			Subject string `json:"subject"`
			HTML    string `json:"html"`
		}
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &preview) != nil || preview.Subject == "" || !strings.Contains(preview.HTML, `lang="zh"`) {
			t.Fatalf("%s preview %d: %s", purpose, rec.Code, rec.Body.String())
		}
	}
	rec := httptest.NewRecorder()
	adminEmailPreview(Deps{}, rec, httptest.NewRequest(http.MethodGet, "/api/admin/email/preview?purpose=unknown", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatal("unknown email preview accepted")
	}
}
