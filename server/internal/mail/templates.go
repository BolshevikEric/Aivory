package mail

import (
	"bytes"
	"fmt"
	"html/template"
	"math"
	"net/url"
	"strings"
	"time"
)

// NormalizeLocale accepts the same regional language tags as the website.
// An empty result lets callers try a request header or saved preference.
func NormalizeLocale(value string) string {
	value = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(value), "_", "-"))
	if value == "zh-hant" || strings.HasPrefix(value, "zh-hant-") || value == "zh-tw" || value == "zh-hk" || value == "zh-mo" {
		return "zh-Hant"
	}
	switch strings.Split(value, "-")[0] {
	case "zh":
		return "zh"
	case "en":
		return "en"
	case "ja":
		return "ja"
	case "fr":
		return "fr"
	}
	return ""
}

type emailCopy struct {
	VerifySubject, VerifyHeading, VerifyBody, CodeLabel, CodeSecurity     string
	ResetSubject, ResetHeading, ResetBody, Button, LinkHint, LinkSecurity string
	Expiry, Ignore, Footer                                                string
}

var emailCopies = map[string]emailCopy{
	"zh": {
		"Aivory · 邮箱验证码", "验证你的邮箱", "感谢注册 Aivory。请在注册页面输入下方验证码，完成邮箱验证。", "邮箱验证码", "请勿将验证码分享给任何人。",
		"Aivory · 重置密码", "设置新密码", "我们收到了你的密码重置请求。点击下方按钮，为你的 Aivory 账户设置新密码。", "重置密码", "如果按钮无法打开，请复制下方完整链接到浏览器：", "此链接仅可使用一次，请勿转发或分享。",
		"有效期为 %d 分钟。", "如果你没有发起此操作，请忽略这封邮件。", "这是一封自动发送的账户安全邮件，请勿直接回复。",
	},
	"zh-Hant": {
		"Aivory · 電子郵件驗證碼", "驗證你的電子郵件", "感謝註冊 Aivory。請在註冊頁面輸入下方驗證碼，完成電子郵件驗證。", "電子郵件驗證碼", "請勿將驗證碼分享給任何人。",
		"Aivory · 重設密碼", "設定新密碼", "我們收到了你的密碼重設請求。點擊下方按鈕，為你的 Aivory 帳戶設定新密碼。", "重設密碼", "如果無法開啟按鈕，請複製下方完整連結至瀏覽器：", "此連結僅可使用一次，請勿轉寄或分享。",
		"有效期限為 %d 分鐘。", "如果你沒有發起此操作，請忽略這封郵件。", "這是一封自動傳送的帳戶安全郵件，請勿直接回覆。",
	},
	"en": {
		"Aivory · Verify your email", "Verify your email", "Thanks for joining Aivory. Enter the code below on the registration page to verify your email address.", "Verification code", "Do not share this code with anyone.",
		"Aivory · Reset your password", "Choose a new password", "We received a request to reset your password. Use the button below to choose a new password for your Aivory account.", "Reset password", "If the button does not open, copy this complete link into your browser:", "This link can only be used once. Do not forward or share it.",
		"Expires in %d minutes.", "If you did not request this, you can ignore this email.", "This is an automated account security email. Please do not reply.",
	},
	"ja": {
		"Aivory · メールアドレスの確認", "メールアドレスを確認", "Aivory にご登録いただきありがとうございます。登録画面で以下の確認コードを入力し、メールアドレスの確認を完了してください。", "確認コード", "このコードを他の人と共有しないでください。",
		"Aivory · パスワードの再設定", "新しいパスワードを設定", "パスワードの再設定リクエストを受け付けました。以下のボタンから Aivory アカウントの新しいパスワードを設定してください。", "パスワードを再設定", "ボタンが開かない場合は、以下のリンク全体をブラウザーにコピーしてください：", "このリンクは一度だけ使用できます。転送や共有はしないでください。",
		"有効期限は %d 分です。", "この操作に心当たりがない場合は、このメールを無視してください。", "このメールはアカウントのセキュリティに関する自動送信メールです。返信はできません。",
	},
	"fr": {
		"Aivory · Vérifiez votre adresse e-mail", "Vérifiez votre adresse e-mail", "Merci de rejoindre Aivory. Saisissez le code ci-dessous sur la page d’inscription pour vérifier votre adresse e-mail.", "Code de vérification", "Ne partagez ce code avec personne.",
		"Aivory · Réinitialisez votre mot de passe", "Choisissez un nouveau mot de passe", "Nous avons reçu une demande de réinitialisation. Utilisez le bouton ci-dessous pour choisir un nouveau mot de passe pour votre compte Aivory.", "Réinitialiser le mot de passe", "Si le bouton ne s’ouvre pas, copiez ce lien complet dans votre navigateur :", "Ce lien ne peut être utilisé qu’une seule fois. Ne le transférez pas et ne le partagez pas.",
		"Expire dans %d minutes.", "Si vous n’êtes pas à l’origine de cette demande, vous pouvez ignorer cet e-mail.", "Ceci est un e-mail automatique de sécurité du compte. Merci de ne pas y répondre.",
	},
}

type emailData struct {
	Locale, Heading, Body, Code, CodeLabel, ResetURL, Button, LinkHint string
	Expiry, Security, Ignore, Footer                                   string
	Year                                                               int
	Greeting, ActionURL                                                string
	Features                                                           []emailFeature
	Details                                                            []emailDetail
}

func renderAuthEmail(message AuthMessage) (string, string, error) {
	locale := NormalizeLocale(message.Locale)
	if locale == "" {
		locale = "en"
	}
	if message.Purpose == "welcome" || message.Purpose == "membership" {
		return renderAccountEmail(message, locale)
	}
	copy := emailCopies[locale]
	expiry := fmt.Sprintf(copy.Expiry, max(1, int(message.ExpiresIn.Minutes())))
	if message.ExpiresIn%time.Minute != 0 {
		secondsCopy := map[string]string{"en": "Expires in %d seconds.", "zh": "有效期为 %d 秒。", "zh-Hant": "有效期限為 %d 秒。", "ja": "有効期限は %d 秒です。", "fr": "Expire dans %d secondes."}
		expiry = fmt.Sprintf(secondsCopy[locale], max(1, int(math.Ceil(message.ExpiresIn.Seconds()))))
	}
	data := emailData{Locale: locale, Expiry: expiry, Ignore: copy.Ignore, Footer: copy.Footer, Year: time.Now().Year()}
	var subject string
	switch message.Purpose {
	case "verify":
		if message.Code == "" {
			return "", "", fmt.Errorf("verification code is required")
		}
		subject = copy.VerifySubject
		data.Heading, data.Body, data.Code, data.CodeLabel, data.Security = copy.VerifyHeading, copy.VerifyBody, message.Code, copy.CodeLabel, copy.CodeSecurity
	case "reset":
		link, err := url.Parse(message.ResetURL)
		if err != nil || link.Host == "" || link.User != nil || (link.Scheme != "https" && link.Scheme != "http") {
			return "", "", fmt.Errorf("valid reset URL is required")
		}
		data.ActionURL = message.ResetURL
		subject = copy.ResetSubject
		data.Heading, data.Body, data.ResetURL, data.Button, data.LinkHint, data.Security = copy.ResetHeading, copy.ResetBody, message.ResetURL, copy.Button, copy.LinkHint, copy.LinkSecurity
	default:
		return "", "", fmt.Errorf("unsupported email purpose")
	}
	var body bytes.Buffer
	if err := emailTmpl.Execute(&body, data); err != nil {
		return "", "", err
	}
	return subject, body.String(), nil
}

// Table layout, inline styles and literal colors work in web and desktop mail
// clients without downloading external fonts, images or tracking pixels.
var emailTmpl = template.Must(template.New("auth-email").Parse(`<!DOCTYPE html>
<html lang="{{.Locale}}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#F6F5FA;color:#1B1830;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans',sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F5FA;"><tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
<tr><td style="padding:0 8px 24px;font-size:23px;font-weight:600;letter-spacing:-0.5px;color:#1B1830;">Aivory<span style="color:#6A4DE6;">.</span></td></tr>
<tr><td style="background:#FFFFFF;border:1px solid #E4E2EC;border-radius:16px;padding:32px 24px;">
<h1 style="margin:0 0 16px;font-size:26px;line-height:1.4;font-weight:600;letter-spacing:-0.4px;color:#1B1830;">{{.Heading}}</h1>
{{if .Greeting}}<p style="margin:0 0 12px;font-size:15px;line-height:1.8;color:#1B1830;">{{.Greeting}}</p>{{end}}
<p style="margin:0 0 24px;font-size:15px;line-height:1.8;color:#5F5677;">{{.Body}}</p>
{{if .Features}}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{{range .Features}}<tr><td style="padding:0 0 20px;"><h2 style="margin:0 0 4px;font-size:15px;line-height:1.6;font-weight:600;color:#1B1830;">{{.Title}}</h2><p style="margin:0;font-size:14px;line-height:1.8;color:#5F5677;">{{.Body}}</p></td></tr>{{end}}</table>{{end}}
{{if .Details}}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;background:#F6F5FA;border:1px solid #E4E2EC;border-radius:10px;">{{range .Details}}<tr><td style="padding:12px 16px;font-size:13px;line-height:1.6;color:#5F5677;vertical-align:top;">{{.Label}}</td><td style="padding:12px 16px;font-size:14px;line-height:1.6;text-align:right;word-break:break-word;color:#1B1830;">{{.Value}}</td></tr>{{end}}</table>{{end}}
{{if .Code}}<p style="margin:0 0 8px;font-size:12px;color:#5F5677;">{{.CodeLabel}}</p>
<div style="padding:20px 12px;background:#F6F5FA;border:1px solid #E4E2EC;border-radius:10px;text-align:center;font-family:'SF Mono',Consolas,monospace;font-size:34px;letter-spacing:8px;font-weight:600;color:#1B1830;">{{.Code}}</div>
{{else if .ActionURL}}<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#6A4DE6" style="border-radius:8px;text-align:center;"><a href="{{.ActionURL}}" style="display:inline-block;padding:14px 24px;color:#FFFFFF;font-size:15px;line-height:1.5;font-weight:600;text-decoration:none;">{{.Button}}</a></td></tr></table>{{end}}
{{if or .Expiry .Security}}<p style="margin:20px 0 0;font-size:13px;line-height:1.8;color:#5F5677;">{{.Expiry}} {{.Security}}</p>{{end}}
{{if .ResetURL}}<div style="margin-top:24px;padding-top:20px;border-top:1px solid #E4E2EC;"><p style="margin:0 0 8px;font-size:12px;line-height:1.8;color:#5F5677;">{{.LinkHint}}</p><a href="{{.ResetURL}}" style="font-size:12px;line-height:1.8;color:#5940C9;word-break:break-all;overflow-wrap:anywhere;">{{.ResetURL}}</a></div>{{end}}
{{if .Ignore}}<p style="margin:24px 0 0;font-size:13px;line-height:1.8;color:#5F5677;">{{.Ignore}}</p>{{end}}
</td></tr>
<tr><td style="padding:24px 8px 0;font-size:12px;line-height:1.8;color:#5F5677;">{{.Footer}}<br>&copy; {{.Year}} Aivory</td></tr>
</table></td></tr></table></body></html>`))

// Preview uses the same templates as delivery without contacting SMTP.
func Preview(message AuthMessage) (string, string, error) { return renderAuthEmail(message) }
