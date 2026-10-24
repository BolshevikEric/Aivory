package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"aivory/server/internal/fileguard"
)

type missingStorageRefs struct {
	artifacts map[string]bool
	files     map[string]bool
	documents map[string]bool
}

// RepairMissingStorage removes confirmed missing local objects and their live
// references atomically. The caller must hold an exclusive storage lock until
// its subsequent backup snapshot has pinned the files. Missing roots,
// access errors and unsafe paths are errors, never evidence of deleted files.
func RepairMissingStorage(ctx context.Context, db *sql.DB, uploadDir, artifactDir string) (int, error) {
	for _, root := range []string{uploadDir, artifactDir} {
		info, err := os.Stat(root)
		if err != nil {
			return 0, fmt.Errorf("inspect storage root %q: %w", root, err)
		}
		if !info.IsDir() {
			return 0, fmt.Errorf("storage root %q is not a directory", root)
		}
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback() //nolint:errcheck
	refs := missingStorageRefs{map[string]bool{}, map[string]bool{}, map[string]bool{}}
	count := 0
	for _, item := range []struct {
		table, root string
		ids         map[string]bool
	}{
		{"artifacts", artifactDir, refs.artifacts},
		{"files", uploadDir, refs.files},
		{"documents", uploadDir, refs.documents},
	} {
		rows, err := tx.QueryContext(ctx, "SELECT id, storage_path FROM "+item.table+" WHERE trim(storage_path)<>''")
		if err != nil {
			return 0, err
		}
		type candidate struct{ id, path string }
		var missing []candidate
		for rows.Next() {
			var c candidate
			if err := rows.Scan(&c.id, &c.path); err != nil {
				_ = rows.Close()
				return 0, err
			}
			absent, err := localStorageMissing(item.root, c.path)
			if err != nil {
				_ = rows.Close()
				return 0, fmt.Errorf("inspect %s.%s: %w", item.table, c.id, err)
			}
			if absent {
				missing = append(missing, c)
			}
		}
		err = rows.Err()
		_ = rows.Close()
		if err != nil {
			return 0, err
		}
		for _, c := range missing {
			// A concurrent metadata update must not delete a row now backed by
			// a different object. Physical writers are excluded by the caller.
			res, err := tx.ExecContext(ctx, "DELETE FROM "+item.table+" WHERE id=? AND storage_path=?", c.id, c.path)
			if err != nil {
				return 0, err
			}
			n, err := res.RowsAffected()
			if err != nil {
				return 0, err
			}
			if n > 0 {
				item.ids[c.id] = true
				count++
			}
		}
	}
	if count > 0 {
		for _, column := range [][2]string{
			{"messages", "blocks"}, {"messages", "attachments"}, {"messages", "citations"},
			{"conversations", "summary_blocks"}, {"conversation_shares", "snapshot"},
		} {
			if err := repairStorageJSONColumn(ctx, tx, column[0], column[1], refs.cleanJSON); err != nil {
				return 0, err
			}
		}
		for id := range refs.files {
			if _, err := tx.ExecContext(ctx, `UPDATE aippt_decks SET file_id='' WHERE file_id=?`, id); err != nil {
				return 0, err
			}
		}
	}
	// Skill metadata also participates in the strict archive completeness check.
	if err := repairStorageJSONColumn(ctx, tx, "skills", "assets", func(raw, _ string) (string, error) {
		var assets []map[string]json.RawMessage
		if err := json.Unmarshal([]byte(raw), &assets); err != nil {
			return "", err
		}
		kept := make([]map[string]json.RawMessage, 0, len(assets))
		for _, asset := range assets {
			var path string
			if len(asset["storage_path"]) > 0 {
				if err := json.Unmarshal(asset["storage_path"], &path); err != nil {
					return "", err
				}
			}
			missing, err := localStorageMissing(uploadDir, path)
			if err != nil {
				return "", err
			}
			if !missing {
				kept = append(kept, asset)
			}
		}
		if len(kept) == len(assets) {
			return raw, nil
		}
		encoded, err := json.Marshal(kept)
		return string(encoded), err
	}); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return count, nil
}

func localStorageMissing(root, path string) (bool, error) {
	if strings.TrimSpace(path) == "" || strings.Contains(path, "://") {
		return false, nil // Remote objects are never inferred missing from local disk.
	}
	if _, err := fileguard.Relative(root, path); err != nil {
		return false, err
	}
	_, err := fileguard.ResolveExisting(path, root)
	if errors.Is(err, os.ErrNotExist) {
		// A dangling/escaping symlink is a path error, not permission to prune
		// its metadata. Inspect existing components without following them.
		rel, _ := fileguard.Relative(root, path)
		current := root
		for _, part := range strings.Split(rel, string(filepath.Separator)) {
			current = filepath.Join(current, part)
			info, inspectErr := os.Lstat(current)
			if errors.Is(inspectErr, os.ErrNotExist) {
				return true, nil
			}
			if inspectErr != nil {
				return false, inspectErr
			}
			if info.Mode()&os.ModeSymlink != 0 {
				return false, fileguard.ErrOutsideRoot
			}
		}
		return true, nil
	}
	return false, err
}

// Read candidates first, then lock and re-read only rows requiring changes.
// This preserves concurrent chat writes and unknown historical JSON fields.
func repairStorageJSONColumn(ctx context.Context, tx *sql.Tx, table, column string, clean func(string, string) (string, error)) error {
	rows, err := tx.QueryContext(ctx, "SELECT id, "+column+" FROM "+table+" WHERE "+column+" NOT IN ('[]', '', 'null')")
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id, raw string
		if err := rows.Scan(&id, &raw); err != nil {
			_ = rows.Close()
			return err
		}
		updated, err := clean(raw, column)
		if err != nil {
			_ = rows.Close()
			return fmt.Errorf("repair %s.%s %s: %w", table, id, column, err)
		}
		if updated != raw {
			ids = append(ids, id)
		}
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		query := "SELECT " + column + " FROM " + table + " WHERE id=?"
		if IsPostgres() {
			query += " FOR UPDATE"
		}
		var raw string
		if err := tx.QueryRowContext(ctx, query, id).Scan(&raw); errors.Is(err, sql.ErrNoRows) {
			continue
		} else if err != nil {
			return err
		}
		updated, err := clean(raw, column)
		if err != nil {
			return err
		}
		if updated == raw {
			continue
		}
		if table == "messages" && column == "blocks" {
			_, err = tx.ExecContext(ctx, `UPDATE messages SET blocks=?,raw='',search_text=? WHERE id=?`, updated, searchTextFromBlocks(json.RawMessage(updated)), id)
		} else {
			_, err = tx.ExecContext(ctx, "UPDATE "+table+" SET "+column+"=? WHERE id=?", updated, id)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func (m missingStorageRefs) missingURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	if u.Scheme == "doc" || u.Scheme == "kbdoc" {
		return m.documents[u.Host]
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) < 3 || parts[0] != "api" {
		return false
	}
	for i := 1; i+1 < len(parts); i++ {
		switch parts[i] {
		case "artifacts":
			return m.artifacts[parts[i+1]]
		case "files":
			return m.files[parts[i+1]]
		case "documents":
			return m.documents[parts[i+1]]
		}
	}
	return false
}

var storageMarkdownLink = regexp.MustCompile(`!?\[([^\]\n]*)\]\(([^\s)]+)(?:\s+"[^"\n]*")?\)`)
var storagePlainURL = regexp.MustCompile(`(?:https?://[^/\s<>"']+)?/api/(?:artifacts|files|documents)/[a-zA-Z0-9_-]+(?:[?#][^\s<>"')\]]*)?|(?:kbdoc|doc)://[a-zA-Z0-9_-]+`)

func (m missingStorageRefs) cleanText(text string) string {
	text = storageMarkdownLink.ReplaceAllStringFunc(text, func(link string) string {
		parts := storageMarkdownLink.FindStringSubmatch(link)
		if m.missingURL(parts[2]) {
			return parts[1] // Preserve the visible words, remove only the dead link.
		}
		return link
	})
	return storagePlainURL.ReplaceAllStringFunc(text, func(raw string) string {
		if m.missingURL(raw) {
			return ""
		}
		return raw
	})
}

func (m missingStorageRefs) cleanJSON(raw, field string) (string, error) {
	var value any
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&value); err != nil {
		// Historical malformed transcript metadata is preserved verbatim. It
		// must not block repairing an unrelated file or erase the whole message.
		return raw, nil
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return raw, nil
	}
	changed := false
	value = m.cleanValue(value, field, &changed)
	if !changed {
		return raw, nil
	}
	encoded, err := json.Marshal(value)
	return string(encoded), err
}

func jsonString(object map[string]any, key string) string {
	value, _ := object[key].(string)
	return value
}

func (m missingStorageRefs) cleanValue(value any, field string, changed *bool) any {
	switch v := value.(type) {
	case []any:
		out := make([]any, 0, len(v))
		for _, item := range v {
			object, _ := item.(map[string]any)
			id, kind := jsonString(object, "id"), jsonString(object, "kind")
			originalArtifacts, _ := object["artifacts"].([]any)
			lostArtifact := m.artifacts[id] || m.artifacts[jsonString(object, "file_ref")] || m.missingURL(jsonString(object, "url"))
			lostFile := m.files[id] || m.files[jsonString(object, "file_ref")] || m.missingURL(jsonString(object, "url"))
			lostDocument := m.documents[id] || m.documents[jsonString(object, "file_ref")] || m.documents[jsonString(object, "document_id")]
			if (field == "artifacts" && lostArtifact) || (field == "media" && ((kind == "artifact" && m.artifacts[id]) || (kind == "attachment" && m.files[id]))) {
				*changed = true
				continue
			}
			if field == "attachments" && lostFile {
				if object["deleted"] != true || jsonString(object, "url") != "" || jsonString(object, "document_id") != "" {
					object["deleted"] = true
					delete(object, "url")
					delete(object, "document_id")
					*changed = true
				}
			} else if field == "attachments" && lostDocument {
				// A failed document source must not disable a healthy upload that
				// happens to carry its old ingestion ID.
				delete(object, "document_id")
				*changed = true
			}
			item = m.cleanValue(item, "", changed)
			if field == "blocks" && kind == "artifact" && len(originalArtifacts) > 0 && id == "" && jsonString(object, "file_ref") == "" && jsonString(object, "url") == "" {
				if remaining, _ := object["artifacts"].([]any); len(remaining) == 0 {
					*changed = true
					out = append(out, unavailableStorageBlock(object))
					continue
				}
			}
			if field == "blocks" && ((kind == "artifact" && lostArtifact) || ((kind == "image" || kind == "document") && (lostFile || lostDocument))) {
				*changed = true
				survivors, _ := object["artifacts"].([]any)
				if len(survivors) == 0 {
					out = append(out, unavailableStorageBlock(object))
					continue
				}
				first, _ := survivors[0].(map[string]any)
				object["file_ref"], object["url"], object["title"] = first["id"], first["url"], first["filename"]
				object["summary"], object["mime_type"] = first["mime_type"], first["mime_type"]
				delete(object, "id")
				delete(object, "data")
			}
			out = append(out, item)
		}
		return out
	case map[string]any:
		for key, child := range v {
			if text, ok := child.(string); ok {
				if key == "url" && m.missingURL(text) {
					v[key] = ""
					*changed = true
				} else if (key == "base_artifact_id" && m.artifacts[text]) || (key == "mask_file_id" && m.files[text]) {
					delete(v, key)
					*changed = true
				} else if key == "text" {
					if cleaned := m.cleanText(text); cleaned != text {
						v[key] = cleaned
						*changed = true
					}
				}
				continue
			}
			v[key] = m.cleanValue(child, key, changed)
		}
	}
	return value
}

// Keep artifact-only turns readable and valid as provider history. Removing
// their final block entirely would leave an empty assistant message.
func unavailableStorageBlock(object map[string]any) map[string]any {
	text := "[File unavailable]"
	if name := jsonString(object, "title"); name != "" {
		text = "[File unavailable: " + name + "]"
	}
	return map[string]any{"kind": "text", "text": text}
}
