// Package mail provides a small SMTP sender that reads its configuration
// from admin settings (live-reloaded on each send — no restart required).
//
// The HTML template is inline to keep the deployment to a single binary;
// it uses the Aivory brand palette via CSS variables that we compile to
// literal values at render time so the HTML works in any email client.
package mail

import (
	"bytes"
	"crypto/tls"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"mime"
	"mime/quotedprintable"
	"net"
	stdmail "net/mail"
	"net/smtp"
	"strings"
	"time"

	"aivory/server/internal/store"
)

// Sender is the surface the auth handlers use. Implementations must be safe
// for concurrent use.
type Sender interface {
	SendAuth(to string, message AuthMessage) error
}

// smtpConfig is the resolved SMTP config read from admin settings.
type smtpConfig struct {
	Host     string
	Port     string
	User     string
	Password string
	From     string
	TLS      bool
}

// SMTPSender reads SMTP config from admin settings on every send so changes
// in the admin UI take effect immediately without a restart.
type SMTPSender struct {
	DB     *sql.DB
	Logger *log.Logger
}

// NewSMTPSender creates a new sender backed by admin-configurable SMTP.
func NewSMTPSender(db *sql.DB, logger *log.Logger) *SMTPSender {
	return &SMTPSender{DB: db, Logger: logger}
}

// AuthMessage carries presentation options independently of SMTP delivery.
// ResetURL is only used for password recovery; registration retains its code.
type AuthMessage struct {
	Purpose             string
	Locale              string
	Code                string
	ResetURL            string
	ExpiresIn           time.Duration
	Name                string
	AppURL              string
	GroupName           string
	MembershipExpiresAt int64
}

func (s *SMTPSender) SendAuth(to string, message AuthMessage) error {
	cfg, enabled, err := s.configForPurpose(message.Purpose)
	if err != nil {
		// Never log the code, reset URL or token on delivery failures.
		return fmt.Errorf("load SMTP configuration: %w", err)
	}
	if !enabled {
		return nil
	}
	subject, body, err := renderAuthEmail(message)
	if err != nil {
		return fmt.Errorf("render email: %w", err)
	}
	return s.send(cfg, to, subject, body)
}

func (s *SMTPSender) send(cfg smtpConfig, to, subject, htmlBody string) error {
	addr := net.JoinHostPort(cfg.Host, cfg.Port)

	// Parse mailbox values before interpolating them into MIME headers.
	from, err := stdmail.ParseAddress(cfg.From)
	if err != nil {
		return fmt.Errorf("invalid SMTP sender address")
	}
	recipient, err := stdmail.ParseAddress(to)
	if err != nil {
		return fmt.Errorf("invalid recipient address")
	}
	var msg bytes.Buffer
	msg.WriteString("From: " + from.String() + "\r\n")
	msg.WriteString("To: " + recipient.String() + "\r\n")
	msg.WriteString("Subject: " + mime.QEncoding.Encode("UTF-8", subject) + "\r\n")
	msg.WriteString("MIME-Version: 1.0\r\n")
	msg.WriteString("Content-Type: text/html; charset=UTF-8\r\n")
	msg.WriteString("Content-Transfer-Encoding: quoted-printable\r\n")
	msg.WriteString("Date: " + time.Now().UTC().Format(time.RFC1123Z) + "\r\n\r\n")
	encoded := quotedprintable.NewWriter(&msg)
	if _, err := encoded.Write([]byte(htmlBody)); err != nil {
		return err
	}
	if err := encoded.Close(); err != nil {
		return err
	}

	auth := smtp.PlainAuth("", cfg.User, cfg.Password, cfg.Host)
	tlsCfg := &tls.Config{ServerName: cfg.Host}

	// Bound EVERY network step. The standard library's tls.Dial / smtp.SendMail
	// have NO timeout, so a wrong port or a TLS-mode mismatch (587 expects
	// STARTTLS, 465 expects implicit TLS) hangs forever — which froze the
	// register request on an infinite spinner. A 10s dial + a 25s overall
	// deadline make a misconfigured server fail fast instead.
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	deadline := time.Now().Add(25 * time.Second)

	var c *smtp.Client
	if cfg.TLS || cfg.Port == "465" {
		// Implicit TLS (port 465): the connection is TLS from the first byte.
		conn, err := tls.DialWithDialer(dialer, "tcp", addr, tlsCfg)
		if err != nil {
			return fmt.Errorf("tls dial: %w", err)
		}
		_ = conn.SetDeadline(deadline)
		c, err = smtp.NewClient(conn, cfg.Host)
		if err != nil {
			_ = conn.Close()
			return fmt.Errorf("smtp client: %w", err)
		}
	} else {
		// Plain connect, then upgrade with STARTTLS when the server offers it
		// (port 587 / 25). Auto-detect so the common 587 setup just works.
		conn, err := dialer.Dial("tcp", addr)
		if err != nil {
			return fmt.Errorf("dial: %w", err)
		}
		_ = conn.SetDeadline(deadline)
		c, err = smtp.NewClient(conn, cfg.Host)
		if err != nil {
			_ = conn.Close()
			return fmt.Errorf("smtp client: %w", err)
		}
		if ok, _ := c.Extension("STARTTLS"); ok {
			if err := c.StartTLS(tlsCfg); err != nil {
				_ = c.Close()
				return fmt.Errorf("starttls: %w", err)
			}
		}
	}
	defer c.Close()

	// Authenticate only when credentials are set AND the server advertises AUTH.
	if cfg.User != "" {
		if ok, _ := c.Extension("AUTH"); ok {
			if err := c.Auth(auth); err != nil {
				return fmt.Errorf("smtp auth: %w", err)
			}
		}
	}
	if err := c.Mail(from.Address); err != nil {
		return fmt.Errorf("smtp mail: %w", err)
	}
	if err := c.Rcpt(recipient.Address); err != nil {
		return fmt.Errorf("smtp rcpt: %w", err)
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("smtp data: %w", err)
	}
	if _, err := w.Write(msg.Bytes()); err != nil {
		return fmt.Errorf("smtp write: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("smtp write close: %w", err)
	}
	return c.Quit()
}

// CheckDomainWhitelist validates that the email's domain is in the admin-configured
// whitelist. An empty whitelist means all domains are allowed.
func CheckDomainWhitelist(db *sql.DB, email string) error {
	email, err := store.NormalizeUserEmail(email)
	if err != nil {
		return fmt.Errorf("invalid email: %w", err)
	}
	raw, err := store.GetSetting(db, "email_domain_whitelist")
	if err != nil {
		return fmt.Errorf("read email domain whitelist: %w", err)
	}
	var whitelist string
	if err := json.Unmarshal(raw, &whitelist); err != nil {
		return fmt.Errorf("decode email domain whitelist: %w", err)
	}
	whitelist = strings.TrimSpace(whitelist)
	if whitelist == "" {
		return nil // empty = allow all
	}

	parts := strings.SplitN(email, "@", 2)
	if len(parts) != 2 {
		return fmt.Errorf("invalid email")
	}
	domain := strings.ToLower(parts[1])

	for _, raw := range strings.FieldsFunc(whitelist, func(r rune) bool {
		return r == ',' || r == ';' || r == ' ' || r == '\n'
	}) {
		allowed := strings.ToLower(strings.TrimSpace(raw))
		allowed = strings.TrimPrefix(allowed, "@")
		if allowed == domain {
			return nil
		}
	}
	return fmt.Errorf("email domain @%s is not allowed", domain)
}
