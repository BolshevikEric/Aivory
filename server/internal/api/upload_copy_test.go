package api

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type failingUploadReader struct {
	read bool
}

func (reader *failingUploadReader) Read(buffer []byte) (int, error) {
	if reader.read {
		return 0, errors.New("simulated upload disconnect")
	}
	reader.read = true
	return copy(buffer, "partial bytes"), nil
}

func TestWriteUploadCopyRemovesIncompleteAndOversizedFiles(t *testing.T) {
	tests := []struct {
		name   string
		source io.Reader
		limit  int64
	}{
		{name: "reader failure", source: &failingUploadReader{}, limit: 1024},
		{name: "over limit", source: strings.NewReader("too many bytes"), limit: 3},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "upload.bin")
			if _, err := writeUploadCopy(path, test.source, test.limit); err == nil {
				t.Fatal("writeUploadCopy succeeded, want error")
			}
			if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("incomplete upload still exists: %v", err)
			}
		})
	}
}

func TestWriteUploadCopyPersistsCompleteFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "upload.bin")
	const content = "complete upload"
	n, err := writeUploadCopy(path, strings.NewReader(content), 1024)
	if err != nil {
		t.Fatal(err)
	}
	if n != int64(len(content)) {
		t.Fatalf("bytes written=%d, want %d", n, len(content))
	}
	stored, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(stored) != content {
		t.Fatalf("stored content=%q, want %q", stored, content)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if permissions := info.Mode().Perm(); permissions&0o077 != 0 {
		t.Fatalf("stored permissions=%#o, want no group or other access", permissions)
	}
}

func TestWriteUploadCopyNeverOverwritesExistingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "upload.bin")
	if err := os.WriteFile(path, []byte("existing bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := writeUploadCopy(path, &failingUploadReader{}, 1024); !errors.Is(err, os.ErrExist) {
		t.Fatalf("expected collision rejection, got %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "existing bytes" {
		t.Fatalf("existing object damaged: %q %v", data, err)
	}
}
