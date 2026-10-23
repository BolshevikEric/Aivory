package mail

import (
	"bufio"
	"io"
	"mime"
	"mime/quotedprintable"
	"net"
	stdmail "net/mail"
	"net/textproto"
	"strings"
	"testing"
	"time"
)

// Exercise the actual SMTP/MIME boundary so non-ASCII subjects, body text and
// long reset links survive transport through an ordinary SMTP server.
func TestSMTPLocalizedMessageSurvivesMIMETransport(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	messages := make(chan string, 1)
	failures := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			failures <- err
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		reader := textproto.NewReader(bufio.NewReader(conn))
		_, _ = io.WriteString(conn, "220 local.test ESMTP\r\n")
		for {
			line, err := reader.ReadLine()
			if err != nil {
				failures <- err
				return
			}
			switch {
			case strings.HasPrefix(line, "EHLO"), strings.HasPrefix(line, "HELO"):
				_, _ = io.WriteString(conn, "250 local.test\r\n")
			case strings.HasPrefix(line, "MAIL FROM:"), strings.HasPrefix(line, "RCPT TO:"):
				_, _ = io.WriteString(conn, "250 OK\r\n")
			case line == "DATA":
				_, _ = io.WriteString(conn, "354 Send message\r\n")
				body, err := reader.ReadDotBytes()
				if err != nil {
					failures <- err
					return
				}
				messages <- string(body)
				_, _ = io.WriteString(conn, "250 Queued\r\n")
			case line == "QUIT":
				_, _ = io.WriteString(conn, "221 Bye\r\n")
				return
			}
		}
	}()
	host, port, _ := net.SplitHostPort(listener.Addr().String())
	subject, body, err := renderAuthEmail(AuthMessage{Purpose: "reset", Locale: "zh", ResetURL: "https://example.test/reset-password?lang=zh#token=" + strings.Repeat("a", 43), ExpiresIn: 10 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	sender := &SMTPSender{}
	if err := sender.send(smtpConfig{Host: host, Port: port, From: "Aivory <security@example.test>"}, "user@example.test", subject, body); err != nil {
		t.Fatal(err)
	}
	select {
	case raw := <-messages:
		msg, err := stdmail.ReadMessage(strings.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := new(mime.WordDecoder).DecodeHeader(msg.Header.Get("Subject"))
		if err != nil || decoded != subject {
			t.Fatalf("subject transport changed: %q %v", decoded, err)
		}
		decodedBody, err := io.ReadAll(quotedprintable.NewReader(msg.Body))
		if err != nil {
			t.Fatal(err)
		}
		// SMTP normalizes line endings; compare normalized bodies.
		if strings.TrimSpace(strings.ReplaceAll(string(decodedBody), "\r\n", "\n")) != strings.TrimSpace(body) {
			t.Fatal("SMTP transport changed localized body or reset link")
		}
	case err := <-failures:
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("SMTP message was not delivered")
	}
}
