package mail

import (
	"strings"
	"testing"
)

func TestAccountEmailsUseEveryWebsiteLanguage(t *testing.T) {
	for locale, copy := range accountEmailCopies {
		for _, purpose := range []string{"welcome", "membership"} {
			t.Run(locale+"/"+purpose, func(t *testing.T) {
				subject, body, err := renderAuthEmail(AuthMessage{
					Purpose: purpose, Locale: locale, Name: "<script>user</script>", GroupName: "Pro <Team>",
					AppURL: "https://app.example.test/", MembershipExpiresAt: 1800000000,
				})
				if err != nil {
					t.Fatal(err)
				}
				if !strings.Contains(body, `lang="`+locale+`"`) || !strings.Contains(body, copy.Footer) ||
					strings.Contains(body, "<script>") || !strings.Contains(body, "&lt;script&gt;") || strings.Contains(body, "<Team>") {
					t.Fatal("locale or HTML escaping is incorrect")
				}
				if purpose == "welcome" {
					if subject != copy.WelcomeSubject || !strings.Contains(body, copy.Availability) {
						t.Fatal("missing welcome copy")
					}
					for _, feature := range copy.Features {
						if !strings.Contains(body, feature.Title) || !strings.Contains(body, feature.Body) {
							t.Fatalf("missing feature %q", feature.Title)
						}
					}
				} else if subject != copy.MembershipSubject || !strings.Contains(body, "Pro &lt;Team&gt;") || !strings.Contains(body, "2027-01-15 08:00 UTC") {
					t.Fatal("missing membership details")
				}
			})
		}
		_, body, err := renderAuthEmail(AuthMessage{Purpose: "membership", Locale: locale, GroupName: "Pro"})
		if err != nil || !strings.Contains(body, copy.Permanent) || strings.Contains(body, `href="`) {
			t.Fatalf("permanent/no-link email: %v", err)
		}
	}
}

func TestAccountEmailsRejectUnsafeApplicationLinks(t *testing.T) {
	for _, link := range []string{"javascript:alert(1)", "//app.example.test", "https://user:pass@app.example.test", "/"} {
		if _, _, err := renderAuthEmail(AuthMessage{Purpose: "welcome", AppURL: link}); err == nil {
			t.Fatalf("accepted %q", link)
		}
	}
}
