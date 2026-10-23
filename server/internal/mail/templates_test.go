package mail

import (
	"strings"
	"testing"
	"time"
)

func TestAuthEmailsUseEveryWebsiteLanguage(t *testing.T) {
	for locale, copy := range emailCopies {
		for _, purpose := range []string{"verify", "reset"} {
			t.Run(locale+"/"+purpose, func(t *testing.T) {
				subject, body, err := renderAuthEmail(AuthMessage{Purpose: purpose, Locale: locale, Code: "123456", ResetURL: "https://example.test/reset-password?lang=" + locale + "#token=secret", ExpiresIn: 23 * time.Minute})
				if err != nil {
					t.Fatal(err)
				}
				for _, text := range []string{`lang="` + locale + `"`, copy.Ignore, copy.Footer, "23"} {
					if !strings.Contains(body, text) {
						t.Fatalf("missing localized content %q", text)
					}
				}
				if purpose == "reset" {
					if subject != copy.ResetSubject || !strings.Contains(body, copy.Button) || !strings.Contains(body, copy.LinkHint) || !strings.Contains(body, "#token=secret") || strings.Contains(body, "123456") {
						t.Fatal("reset email did not render a localized link")
					}
				} else if subject != copy.VerifySubject || !strings.Contains(body, "123456") || strings.Contains(body, "#token=secret") {
					t.Fatal("registration email did not render a localized verification code")
				}
				if locale != "en" && (strings.Contains(body, "Do not share") || strings.Contains(body, "This is an automated")) {
					t.Fatal("English copy leaked into localized email")
				}
			})
		}
	}
}

func TestAuthEmailEscapesUntrustedValuesAndRejectsUnsafeLinks(t *testing.T) {
	_, body, err := renderAuthEmail(AuthMessage{Purpose: "verify", Locale: "zh", Code: `<img src=x onerror="alert(1)">`, ExpiresIn: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(body, "<img") || !strings.Contains(body, "&lt;img") {
		t.Fatal("verification value was not HTML escaped")
	}
	for _, link := range []string{"javascript:alert(1)", "//example.test/reset", "https://user:pass@example.test/reset", "/reset"} {
		if _, _, err := renderAuthEmail(AuthMessage{Purpose: "reset", ResetURL: link}); err == nil {
			t.Fatal("unsafe reset link accepted")
		}
	}
}

func TestEmailLocaleNormalization(t *testing.T) {
	for input, want := range map[string]string{"zh-CN": "zh", "zh_SG": "zh", "zh-TW": "zh-Hant", "zh-Hant-HK": "zh-Hant", "EN-gb": "en", "ja-JP": "ja", "fr-CA": "fr", "de": "", "": ""} {
		if got := NormalizeLocale(input); got != want {
			t.Errorf("NormalizeLocale(%q)=%q, want %q", input, got, want)
		}
	}
}

func TestAuthEmailDisplaysConfiguredSubMinuteExpiry(t *testing.T) {
	_, body, err := renderAuthEmail(AuthMessage{Purpose: "verify", Locale: "zh", Code: "123456", ExpiresIn: 45 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(body, "有效期为 45 秒。") {
		t.Fatal("configured expiry was rounded to minutes")
	}
}
