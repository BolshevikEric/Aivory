package sandbox

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

var (
	ErrArchiveMissing       = errors.New("sandbox archive missing")
	ErrArchiveNotConfigured = errors.New("sandbox archive storage not configured")
	ErrArchiveUnsupported   = errors.New("sandbox archive browsing unsupported")
	ErrArchiveFileMissing   = errors.New("sandbox archive file missing")
)

// ArchiveBrowser is optional for third-party sandbox implementations. Reading
// saved workspace bytes never provisions a container or rewrites an archive.
type ArchiveBrowser interface {
	ListArchivedFiles(context.Context, string, string) ([]SandboxFile, error)
	GetArchivedFile(context.Context, string, string, string) ([]byte, error)
}

// IsSessionGone distinguishes a recycled session from a missing endpoint/file,
// including the string detail returned by older sidecars.
func IsSessionGone(err error) bool {
	if errors.Is(err, ErrSessionGone) {
		return true
	}
	var httpErr *HTTPError
	if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusNotFound {
		return false
	}
	var body struct {
		Detail string `json:"detail"`
	}
	if json.Unmarshal([]byte(httpErr.Body), &body) != nil {
		return false
	}
	detail := strings.ToLower(body.Detail)
	return strings.Contains(detail, "session not found") || strings.Contains(detail, "session not running")
}

func (s *HTTPSandbox) archiveFilesRequest(ctx context.Context, endpoint, archiveKey, sessionID, path string) ([]SandboxFile, []byte, error) {
	payload := map[string]any{"archive_key": archiveKey, "session_id": sessionID, "path": path}
	if s.Storage != nil && s.Storage.Effective() {
		payload["storage"] = s.Storage
	}
	var res struct {
		Status string        `json:"archive_status"`
		Files  []SandboxFile `json:"files"`
		Data   string        `json:"data_base64"`
	}
	if err := s.do(ctx, endpoint, payload, &res); err != nil {
		var httpErr *HTTPError
		if errors.As(err, &httpErr) && httpErr.StatusCode == http.StatusNotFound {
			return nil, nil, ErrArchiveUnsupported
		}
		return nil, nil, err
	}
	switch res.Status {
	case "missing":
		return nil, nil, ErrArchiveMissing
	case "not_configured":
		return nil, nil, ErrArchiveNotConfigured
	case "file_missing":
		return nil, nil, ErrArchiveFileMissing
	case "ready":
		data, err := base64.StdEncoding.DecodeString(res.Data)
		return res.Files, data, err
	default:
		return nil, nil, ErrArchiveUnsupported
	}
}

func (s *HTTPSandbox) ListArchivedFiles(ctx context.Context, archiveKey, sessionID string) ([]SandboxFile, error) {
	files, _, err := s.archiveFilesRequest(ctx, "/archives/files/list", archiveKey, sessionID, "")
	return files, err
}

func (s *HTTPSandbox) GetArchivedFile(ctx context.Context, archiveKey, sessionID, path string) ([]byte, error) {
	_, data, err := s.archiveFilesRequest(ctx, "/archives/files/get", archiveKey, sessionID, path)
	return data, err
}
