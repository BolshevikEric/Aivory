package api

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"aivory/server/internal/oauth"
	"aivory/server/internal/store"
)

func accountEmailDeps(t *testing.T) (Deps, *recordingCodeMailer) {
	t.Helper()
	// Membership updates publish events. Keep the process-wide event hub on the
	// shared test bus while auth cooldowns remain isolated in each fixture.
	eventsHub.ensureStarted(eventsTestCache)
	d := newAuthSecurityDeps(t, "account-emails.db")
	d.Config.AllowedOrigins = []string{"https://app.example.test"}
	t.Cleanup(store.InvalidateConfig)
	if _, err := store.CreateUserWithRole(t.Context(), d.DB, "admin@example.test", "Admin", "hash", "admin"); err != nil {
		t.Fatal(err)
	}
	return d, d.Mailer.(*recordingCodeMailer)
}

func awaitAccountEmail(t *testing.T, mailer *recordingCodeMailer, count int) recordedEmail {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for mailer.count() < count {
		select {
		case <-mailer.sent:
		case <-deadline:
			t.Fatalf("got %d emails, want %d", mailer.count(), count)
		}
	}
	mailer.mu.Lock()
	defer mailer.mu.Unlock()
	return mailer.calls[count-1]
}

func noAdditionalAccountEmail(t *testing.T, mailer *recordingCodeMailer, count int) {
	t.Helper()
	// Give any erroneously queued asynchronous delivery a chance to run.
	time.Sleep(25 * time.Millisecond)
	if got := mailer.count(); got != count {
		t.Fatalf("got %d emails, want %d", got, count)
	}
}

func TestWelcomeEmailFollowsCompletedRegistrationAndVerification(t *testing.T) {
	for _, verify := range []bool{false, true} {
		t.Run(fmt.Sprint(verify), func(t *testing.T) {
			d, mailer := accountEmailDeps(t)
			if err := store.SetSetting(d.DB, "email_verification_required", verify); err != nil {
				t.Fatal(err)
			}
			rec := runAuthJSONHandler(t, d, registerHandler, "/api/auth/register", `{"email":"new@example.test","name":"New User","password":"password123","locale":"zh-Hant"}`)
			if rec.Code != http.StatusOK {
				t.Fatalf("register %d: %s", rec.Code, rec.Body.String())
			}
			count := 1
			if verify {
				if got := awaitAccountEmail(t, mailer, 1); got.purpose != "verify" {
					t.Fatalf("pending signup sent %q", got.purpose)
				}
				code, ok := d.Cache.Get("verify:new@example.test")
				if !ok {
					t.Fatal("missing verification code")
				}
				rec = runAuthJSONHandler(t, d, verifyEmailHandler, "/api/auth/verify-email", fmt.Sprintf(`{"email":"new@example.test","code":%q,"locale":"ja"}`, code))
				if rec.Code != http.StatusOK {
					t.Fatalf("verify %d: %s", rec.Code, rec.Body.String())
				}
				count++
				rec = runAuthJSONHandler(t, d, verifyEmailHandler, "/api/auth/verify-email", fmt.Sprintf(`{"email":"new@example.test","code":%q}`, code))
				if rec.Code != http.StatusBadRequest {
					t.Fatal("verification replay succeeded")
				}
			}
			got := awaitAccountEmail(t, mailer, count)
			locale := "zh-Hant"
			if verify {
				locale = "ja"
			}
			if got.to != "new@example.test" || got.purpose != "welcome" || got.message.Locale != locale || got.message.AppURL != "https://app.example.test/?lang="+locale {
				t.Fatalf("welcome = %+v", got)
			}
			u, err := store.FindUserByEmail(t.Context(), d.DB, got.to)
			if err != nil || !strings.Contains(string(u.Settings), locale) {
				t.Fatalf("signup language not saved: %v", err)
			}
			rec = runAuthJSONHandler(t, d, loginHandler, "/api/auth/login", `{"email":"new@example.test","password":"password123"}`)
			if rec.Code != http.StatusOK {
				t.Fatalf("login %d: %s", rec.Code, rec.Body.String())
			}
			noAdditionalAccountEmail(t, mailer, count)
		})
	}
}

func TestWelcomeEmailOnlyForNewOAuthAccountsWithRealAddresses(t *testing.T) {
	d, mailer := accountEmailDeps(t)
	p := namespacedOAuthProviderForTest(&store.OAuthProvider{ID: "google", Kind: "google", Name: "Google"})
	info := oauth.UserInfo{Subject: "welcome-sub", Email: "oauth-new@example.test", EmailVerified: true, Name: "OAuth User"}
	first, err := resolveOAuthUser(t.Context(), d, p, info, oauthSignupContext{Locale: "fr"})
	if err != nil {
		t.Fatal(err)
	}
	if got := awaitAccountEmail(t, mailer, 1); got.purpose != "welcome" || got.message.Locale != "fr" {
		t.Fatalf("welcome = %+v", got)
	}
	if again, err := resolveOAuthUser(t.Context(), d, p, info, oauthSignupContext{Locale: "en"}); err != nil || again.ID != first.ID {
		t.Fatalf("existing identity: %v", err)
	}
	if _, err := resolveOAuthUser(t.Context(), d, p, oauth.UserInfo{Subject: "without-email", Name: "No email"}, oauthSignupContext{Locale: "ja"}); err != nil {
		t.Fatal(err)
	}
	noAdditionalAccountEmail(t, mailer, 1)
}

func TestMembershipEmailOnAdminAssignmentAndRenewalOnly(t *testing.T) {
	d, mailer := accountEmailDeps(t)
	u, err := store.CreateUser(t.Context(), d.DB, "member@example.test", "Member", "hash")
	if err != nil {
		t.Fatal(err)
	}
	saveSignupLocale(t.Context(), d, u, "zh")
	group, err := store.CreateUserGroup(t.Context(), d.DB, store.UserGroup{ID: "ug_email_pro", Name: "Pro"})
	if err != nil {
		t.Fatal(err)
	}
	assign := func(groupID string, expiry int64) {
		t.Helper()
		req := httptest.NewRequest(http.MethodPut, "/api/admin/users/"+u.ID+"/group", strings.NewReader(fmt.Sprintf(`{"group_id":%q,"group_expires_at":%d}`, groupID, expiry)))
		req.Header.Set("Accept-Language", "fr")
		req = paymentAPIRequest(req, nil, map[string]string{"id": u.ID})
		rec := httptest.NewRecorder()
		setUserGroupAdmin(d, rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("assign %d: %s", rec.Code, rec.Body.String())
		}
	}
	expiry := time.Now().Add(24 * time.Hour).Unix()
	assign(group.ID, expiry)
	if got := awaitAccountEmail(t, mailer, 1); got.purpose != "membership" || got.message.Locale != "zh" || got.message.GroupName != "Pro" || got.message.MembershipExpiresAt != expiry {
		t.Fatalf("membership = %+v", got)
	}
	assign(group.ID, expiry)
	noAdditionalAccountEmail(t, mailer, 1)
	assign(group.ID, expiry+86400)
	awaitAccountEmail(t, mailer, 2)
	assign(store.DefaultGroupID, 0)
	noAdditionalAccountEmail(t, mailer, 2)
}

func TestMembershipRedemptionEmailsSkipPreviewCreditsAndReplay(t *testing.T) {
	d, mailer := accountEmailDeps(t)
	u, err := store.CreateUser(t.Context(), d.DB, "redeemer@example.test", "Redeemer", "hash")
	if err != nil {
		t.Fatal(err)
	}
	saveSignupLocale(t.Context(), d, u, "ja")
	group, err := store.CreateUserGroup(t.Context(), d.DB, store.UserGroup{ID: "ug_redeem_mail", Name: "Member"})
	if err != nil {
		t.Fatal(err)
	}
	for _, rc := range []store.RedeemCode{
		{Code: "MEMBER-MAIL", GroupID: group.ID, DurationDays: 30, MaxUses: 1, Enabled: true},
		{Code: "CREDITS-MAIL", Kind: store.RedeemKindCredits, Credits: 10, MaxUses: 1, Enabled: true},
	} {
		if _, err := store.CreateRedeemCode(t.Context(), d.DB, rc); err != nil {
			t.Fatal(err)
		}
	}
	redeem := func(code string, confirm bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/me/redeem", strings.NewReader(fmt.Sprintf(`{"code":%q,"confirm":%t}`, code, confirm)))
		req = paymentAPIRequest(req, u, nil)
		rec := httptest.NewRecorder()
		redeemCodeHandler(d, rec, req)
		return rec
	}
	if rec := redeem("CREDITS-MAIL", false); rec.Code != http.StatusOK {
		t.Fatalf("credits: %s", rec.Body.String())
	}
	// A switch from another membership requires confirmation before any email.
	other, err := store.CreateUserGroup(t.Context(), d.DB, store.UserGroup{ID: "ug_other_mail", Name: "Other"})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserGroup(t.Context(), d.DB, u.ID, other.ID, time.Now().Add(time.Hour).Unix()); err != nil {
		t.Fatal(err)
	}
	if rec := redeem("MEMBER-MAIL", false); !strings.Contains(rec.Body.String(), `"requires_confirmation":true`) {
		t.Fatalf("preview: %s", rec.Body.String())
	}
	noAdditionalAccountEmail(t, mailer, 0)
	if rec := redeem("MEMBER-MAIL", true); rec.Code != http.StatusOK {
		t.Fatalf("redeem: %s", rec.Body.String())
	}
	if got := awaitAccountEmail(t, mailer, 1); got.purpose != "membership" || got.message.Locale != "ja" {
		t.Fatalf("membership: %+v", got)
	}
	if rec := redeem("MEMBER-MAIL", true); rec.Code == http.StatusOK {
		t.Fatal("replay succeeded")
	}
	noAdditionalAccountEmail(t, mailer, 1)
}

func TestOAuthBannedAccountUsesIndependentStatusPage(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "https://app.example.test/api/auth/oauth/callback", nil)
	rec := httptest.NewRecorder()
	completeOAuthLoginWithGuard(Deps{}, rec, req, &store.User{Status: "banned"}, "https://app.example.test", nil)
	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "https://app.example.test/account-suspended" || len(rec.Result().Cookies()) != 0 {
		t.Fatalf("banned callback: %d %s", rec.Code, rec.Header())
	}
}
