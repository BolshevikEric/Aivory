package api

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"aivory/server/internal/config"
)

func TestBackupUploadExactLimitUsesDataDisk(t *testing.T) {
	for _, confirmLast := range []bool{false, true} {
		t.Run(map[bool]string{false: "confirm first", true: "confirm last"}[confirmLast], func(t *testing.T) {
			root := t.TempDir()
			data := bytes.Repeat([]byte("archive bytes"), 8192)
			var body bytes.Buffer
			mw := multipart.NewWriter(&body)
			if !confirmLast {
				_ = mw.WriteField("confirm", "REPLACE")
			}
			part, _ := mw.CreateFormFile("file", "archive.zip")
			_, _ = part.Write(data)
			if confirmLast {
				_ = mw.WriteField("confirm", "REPLACE")
			}
			_ = mw.Close()
			d := Deps{Config: config.Config{UploadDir: filepath.Join(root, "uploads"), ArtifactDir: filepath.Join(root, "artifacts"), MaxBackupBytes: int64(len(data))}}
			req := httptest.NewRequest(http.MethodPost, "/", &body)
			req.Header.Set("Content-Type", mw.FormDataContentType())
			file, size, err := receiveBackupUpload(d, httptest.NewRecorder(), req)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = file.Close(); _ = os.Remove(file.Name()) }()
			if filepath.Dir(file.Name()) != root || size != int64(len(data)) {
				t.Fatalf("upload path=%s size=%d", file.Name(), size)
			}
			got, err := io.ReadAll(io.NewSectionReader(file, 0, size))
			if err != nil || !bytes.Equal(got, data) {
				t.Fatalf("upload bytes differ: %v", err)
			}
		})
	}
}

func TestBackupUploadRejectsInvalidFormsAndCleansPartialFiles(t *testing.T) {
	for _, kind := range []string{"oversize", "unknown-length oversize", "missing confirm", "duplicate confirm", "duplicate file", "truncated", "cancelled"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			var body bytes.Buffer
			mw := multipart.NewWriter(&body)
			if kind != "missing confirm" {
				_ = mw.WriteField("confirm", "REPLACE")
			}
			if kind == "duplicate confirm" {
				_ = mw.WriteField("confirm", "REPLACE")
			}
			part, _ := mw.CreateFormFile("file", "archive.zip")
			_, _ = part.Write(bytes.Repeat([]byte("x"), 65))
			if kind == "duplicate file" {
				part, _ = mw.CreateFormFile("file", "other.zip")
				_, _ = part.Write([]byte("other"))
			}
			_ = mw.Close()
			data := body.Bytes()
			if kind == "truncated" {
				data = data[:len(data)-10]
			}
			limit := int64(100)
			if strings.Contains(kind, "oversize") {
				limit = 64
			}
			d := Deps{Config: config.Config{UploadDir: filepath.Join(root, "uploads"), MaxBackupBytes: limit}}
			req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(data))
			if kind == "unknown-length oversize" {
				req.ContentLength = -1
			}
			req.Header.Set("Content-Type", mw.FormDataContentType())
			if kind == "cancelled" {
				ctx, cancel := context.WithCancel(req.Context())
				cancel()
				req = req.WithContext(ctx)
			}
			file, _, err := receiveBackupUpload(d, httptest.NewRecorder(), req)
			if err == nil {
				if file != nil {
					_ = file.Close()
				}
				t.Fatal("invalid upload accepted")
			}
			if strings.Contains(kind, "oversize") {
				var uploadErr *backupUploadError
				if !errors.As(err, &uploadErr) || uploadErr.status != http.StatusRequestEntityTooLarge {
					t.Fatalf("want 413, got %v", err)
				}
			}
			entries, _ := os.ReadDir(root)
			if len(entries) != 0 {
				t.Fatalf("temporary files leaked: %v", entries)
			}
		})
	}
}

func TestBackupUploadStorageFailureIsActionable(t *testing.T) {
	for _, err := range []error{syscall.ENOSPC, &os.PathError{Op: "write", Path: "archive", Err: syscall.EDQUOT}} {
		rec := httptest.NewRecorder()
		writeBackupUploadError(rec, backupUploadFailure(err, 1024))
		if rec.Code != http.StatusInsufficientStorage || !strings.Contains(rec.Body.String(), "insufficient storage") {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body)
		}
	}
}

func TestBackupImportSlowUploadDoesNotExhaustResponseDeadline(t *testing.T) {
	d := Deps{Config: config.Config{UploadDir: filepath.Join(t.TempDir(), "uploads")}}
	body, contentType := multipartArchive(t, []byte("this is not a zip"))
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { importBackupAdmin(d, w, r) }))
	server.Config.WriteTimeout = 30 * time.Millisecond
	server.Start()
	defer server.Close()
	reader, writer := io.Pipe()
	defer reader.Close()
	go func() {
		data := body.Bytes()
		_, _ = writer.Write(data[:len(data)/2])
		time.Sleep(100 * time.Millisecond)
		_, _ = writer.Write(data[len(data)/2:])
		_ = writer.Close()
	}()
	req, _ := http.NewRequest(http.MethodPost, server.URL, reader)
	req.Header.Set("Content-Type", contentType)
	client := &http.Client{Timeout: 3 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		t.Fatalf("slow upload lost its response: %v", err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusBadRequest || !bytes.Contains(data, []byte("not a valid backup")) {
		t.Fatalf("status=%d body=%s", res.StatusCode, data)
	}
	leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(d.Config.UploadDir), ".aivory-backup-upload-*"))
	if len(leftovers) != 0 {
		t.Fatalf("invalid ZIP left temp uploads: %v", leftovers)
	}
}
