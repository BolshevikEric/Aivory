package mail

import (
	"bytes"
	"fmt"
	"net/url"
	"strings"
	"time"
)

type emailFeature struct{ Title, Body string }
type emailDetail struct{ Label, Value string }
type accountEmailCopy struct {
	WelcomeSubject, WelcomeHeading, WelcomeBody, WelcomeButton             string
	MembershipSubject, MembershipHeading, MembershipBody, MembershipButton string
	Greeting, GroupLabel, ExpiryLabel, Permanent, Footer, Availability     string
	Features                                                               []emailFeature
}

var accountEmailCopies = map[string]accountEmailCopy{
	"zh": {
		WelcomeSubject: "Aivory · 欢迎加入", WelcomeHeading: "欢迎来到 Aivory", WelcomeBody: "你的账户已准备就绪。从一个问题、一张图片或一份文件开始，让想法自在生长。", WelcomeButton: "开始使用 Aivory",
		MembershipSubject: "Aivory · 会员已生效", MembershipHeading: "你的会员已生效", MembershipBody: "你的会员用户组已成功开通或续期，最新会员信息如下。", MembershipButton: "查看我的会员",
		Greeting: "你好，%s。", GroupLabel: "会员用户组", ExpiryLabel: "有效期至", Permanent: "长期有效", Footer: "这是一封自动发送的账户通知邮件，请勿直接回复。", Availability: "实际可用功能以你的账户权限和网站配置为准。",
		Features: []emailFeature{{"AI 对话", "提问、写作、翻译或梳理思路，让 AI 陪你推进日常任务。"}, {"图片生成", "用文字描述画面，创作插画、海报或其他视觉灵感。"}, {"文件处理", "上传文档和图片，让 AI 帮你阅读、总结和分析。"}, {"知识库与项目", "整理参考资料与相关对话，让长期任务更有条理。"}},
	},
	"zh-Hant": {
		WelcomeSubject: "Aivory · 歡迎加入", WelcomeHeading: "歡迎來到 Aivory", WelcomeBody: "你的帳戶已準備就緒。從一個問題、一張圖片或一份檔案開始，讓想法自在生長。", WelcomeButton: "開始使用 Aivory",
		MembershipSubject: "Aivory · 會員已生效", MembershipHeading: "你的會員已生效", MembershipBody: "你的會員使用者群組已成功開通或續期，最新會員資訊如下。", MembershipButton: "查看我的會員",
		Greeting: "你好，%s。", GroupLabel: "會員使用者群組", ExpiryLabel: "有效期限至", Permanent: "長期有效", Footer: "這是一封自動傳送的帳戶通知郵件，請勿直接回覆。", Availability: "實際可用功能以你的帳戶權限與網站設定為準。",
		Features: []emailFeature{{"AI 對話", "提問、寫作、翻譯或整理思緒，讓 AI 陪你推進日常任務。"}, {"圖片生成", "用文字描述畫面，創作插畫、海報或其他視覺靈感。"}, {"檔案處理", "上傳文件和圖片，讓 AI 幫你閱讀、摘要和分析。"}, {"知識庫與專案", "整理參考資料與相關對話，讓長期任務更有條理。"}},
	},
	"en": {
		WelcomeSubject: "Aivory · Welcome aboard", WelcomeHeading: "Welcome to Aivory", WelcomeBody: "Your account is ready. Start with a question, an image or a document, and give your ideas room to grow.", WelcomeButton: "Start using Aivory",
		MembershipSubject: "Aivory · Membership activated", MembershipHeading: "Your membership is active", MembershipBody: "Your membership group has been activated or renewed. Here are your updated membership details.", MembershipButton: "View my membership",
		Greeting: "Hello, %s.", GroupLabel: "Membership group", ExpiryLabel: "Valid until", Permanent: "No expiration", Footer: "This is an automated account notification. Please do not reply.", Availability: "Available features depend on your account permissions and site configuration.",
		Features: []emailFeature{{"AI conversations", "Ask questions, write, translate and work through ideas with AI."}, {"Image generation", "Describe a scene to create illustrations, posters and visual ideas."}, {"Work with files", "Upload documents and images for help reading, summarizing and analyzing them."}, {"Knowledge bases and projects", "Organize reference materials and conversations to keep ongoing work in order."}},
	},
	"ja": {
		WelcomeSubject: "Aivory · ようこそ", WelcomeHeading: "Aivory へようこそ", WelcomeBody: "アカウントの準備ができました。質問、画像、ドキュメントから始めて、アイデアを広げましょう。", WelcomeButton: "Aivory を使い始める",
		MembershipSubject: "Aivory · メンバーシップが有効になりました", MembershipHeading: "メンバーシップが有効になりました", MembershipBody: "メンバーシップグループの有効化または更新が完了しました。最新の情報をご確認ください。", MembershipButton: "メンバーシップを確認",
		Greeting: "%s さん、こんにちは。", GroupLabel: "メンバーシップグループ", ExpiryLabel: "有効期限", Permanent: "無期限", Footer: "このメールはアカウントに関する自動送信通知です。返信はできません。", Availability: "利用できる機能は、アカウントの権限とサイトの設定によって異なります。",
		Features: []emailFeature{{"AI との対話", "質問、文章作成、翻訳、アイデアの整理を AI と進められます。"}, {"画像生成", "イメージを言葉で伝えて、イラストやポスターなどを作成できます。"}, {"ファイルの活用", "ドキュメントや画像をアップロードし、読み取り、要約、分析を依頼できます。"}, {"ナレッジベースとプロジェクト", "参考資料や関連する会話を整理し、継続的な作業を管理できます。"}},
	},
	"fr": {
		WelcomeSubject: "Aivory · Bienvenue", WelcomeHeading: "Bienvenue sur Aivory", WelcomeBody: "Votre compte est prêt. Commencez par une question, une image ou un document, et donnez vie à vos idées.", WelcomeButton: "Commencer avec Aivory",
		MembershipSubject: "Aivory · Abonnement activé", MembershipHeading: "Votre abonnement est actif", MembershipBody: "Votre groupe d’abonnement a été activé ou renouvelé. Voici les informations à jour.", MembershipButton: "Voir mon abonnement",
		Greeting: "Bonjour, %s.", GroupLabel: "Groupe d’abonnement", ExpiryLabel: "Valable jusqu’au", Permanent: "Sans expiration", Footer: "Ceci est une notification automatique de votre compte. Merci de ne pas y répondre.", Availability: "Les fonctionnalités disponibles dépendent des autorisations de votre compte et de la configuration du site.",
		Features: []emailFeature{{"Conversations avec l’IA", "Posez des questions, rédigez, traduisez et développez vos idées avec l’IA."}, {"Génération d’images", "Décrivez une scène pour créer des illustrations, des affiches et d’autres idées visuelles."}, {"Travail sur les fichiers", "Importez des documents et des images pour les lire, les résumer et les analyser."}, {"Bases de connaissances et projets", "Organisez vos références et vos conversations pour structurer vos travaux au fil du temps."}},
	},
}

func renderAccountEmail(message AuthMessage, locale string) (string, string, error) {
	copy := accountEmailCopies[locale]
	data := emailData{Locale: locale, Footer: copy.Footer, Year: time.Now().Year()}
	if name := strings.TrimSpace(message.Name); name != "" {
		data.Greeting = fmt.Sprintf(copy.Greeting, name)
	}
	if message.AppURL != "" {
		link, err := url.Parse(message.AppURL)
		if err != nil || link.Host == "" || link.User != nil || (link.Scheme != "http" && link.Scheme != "https") {
			return "", "", fmt.Errorf("valid application URL is required")
		}
		data.ActionURL = message.AppURL
	}
	var subject string
	if message.Purpose == "welcome" {
		subject = copy.WelcomeSubject
		data.Heading, data.Body, data.Button, data.Features = copy.WelcomeHeading, copy.WelcomeBody, copy.WelcomeButton, copy.Features
		data.Security = copy.Availability
	} else {
		if strings.TrimSpace(message.GroupName) == "" {
			return "", "", fmt.Errorf("membership group is required")
		}
		subject = copy.MembershipSubject
		data.Heading, data.Body, data.Button = copy.MembershipHeading, copy.MembershipBody, copy.MembershipButton
		expires := copy.Permanent
		if message.MembershipExpiresAt > 0 {
			expires = time.Unix(message.MembershipExpiresAt, 0).UTC().Format("2006-01-02 15:04 UTC")
		}
		data.Details = []emailDetail{{copy.GroupLabel, message.GroupName}, {copy.ExpiryLabel, expires}}
	}
	var body bytes.Buffer
	if err := emailTmpl.Execute(&body, data); err != nil {
		return "", "", err
	}
	return subject, body.String(), nil
}
