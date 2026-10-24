package api

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode"
)

// Server restores also accept archives copied in by an operator. Temporary
// uploads should keep a non-.zip suffix until the transfer has completed.
func safeServerBackupArchiveName(name string) bool {
	return name != "" && filepath.Base(name) == name && !strings.HasPrefix(name, ".") &&
		!strings.ContainsAny(name, "/\\") && !strings.ContainsFunc(name, unicode.IsControl) &&
		strings.EqualFold(filepath.Ext(name), ".zip")
}

func openServerBackupArchive(dir, name string) (*os.File, os.FileInfo, int, error) {
	if strings.TrimSpace(dir) == "" || !safeServerBackupArchiveName(name) {
		return nil, nil, http.StatusBadRequest, errors.New("invalid server backup archive name or directory")
	}
	// Root confines even a raced symlink to the configured backup directory.
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, nil, http.StatusNotFound, fmt.Errorf("open backup directory: %w", err)
	}
	defer root.Close()
	before, err := root.Lstat(name)
	if err != nil || !before.Mode().IsRegular() {
		return nil, nil, http.StatusNotFound, errors.New("server backup archive not found or not a regular file")
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, nil, http.StatusNotFound, fmt.Errorf("open server backup archive: %w", err)
	}
	after, err := file.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) ||
		before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
		_ = file.Close()
		return nil, nil, http.StatusConflict, errors.New("server backup archive changed; refresh the list and try again")
	}
	// Keep this descriptor pinned until cancellation or restoration finishes.
	// Renaming/replacing the directory entry cannot switch the selected input.
	return file, after, http.StatusOK, nil
}

func validateServerBackupDirectory(d Deps) error {
	base, err := filepath.EvalSymlinks(d.Config.BackupDir)
	if err != nil {
		return err
	}
	base, err = filepath.Abs(base)
	if err != nil {
		return err
	}
	for _, root := range []string{d.Config.UploadDir, d.Config.ArtifactDir} {
		if strings.TrimSpace(root) == "" {
			continue
		}
		if resolved, err := filepath.EvalSymlinks(root); err == nil {
			root = resolved
		}
		root, err = filepath.Abs(root)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, base)
		if err != nil {
			return err
		}
		if rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return errors.New("server backup directory must be outside the uploads and artifacts directories replaced by restore")
		}
	}
	return nil
}
