package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/url"
	"strings"
)

// A generation can hold blocks in memory while a backup repairs their missing
// files. Check again at finalization so that late output cannot resurrect the
// repaired references. This checks metadata only; physical writes keep their
// own storage lock, and only export repair infers absence from the filesystem.
func cleanFinishingStorageRefs(ctx context.Context, tx *sql.Tx, messageID string, p MessageFinishPatch) (MessageFinishPatch, error) {
	refs := missingStorageRefs{map[string]bool{}, map[string]bool{}, map[string]bool{}}
	for _, raw := range []json.RawMessage{p.Blocks, p.Citations} {
		var value any
		if json.Unmarshal(raw, &value) == nil {
			refs.collectCandidates(value, "")
		}
	}
	if len(refs.artifacts)+len(refs.files)+len(refs.documents) == 0 {
		return p, nil
	}
	// Repair locks and re-reads this row before changing JSON. Lock it before
	// checking references so repair either observes our final write or commits
	// first and makes its deleted records visible to these reads.
	if IsPostgres() {
		var id string
		if err := tx.QueryRowContext(ctx, `SELECT id FROM messages WHERE id=? FOR UPDATE`, messageID).Scan(&id); err != nil {
			return p, err
		}
	}
	for _, item := range []struct {
		table string
		ids   map[string]bool
	}{{"artifacts", refs.artifacts}, {"files", refs.files}, {"documents", refs.documents}} {
		ids := make([]string, 0, len(item.ids))
		for id := range item.ids {
			ids = append(ids, id)
		}
		for start := 0; start < len(ids); start += 256 {
			batch := ids[start:min(start+256, len(ids))]
			rows, err := tx.QueryContext(ctx, "SELECT id FROM "+item.table+" WHERE id IN ("+idPlaceholders(len(batch))+")", anySlice(batch)...)
			if err != nil {
				return p, err
			}
			for rows.Next() {
				var id string
				if err := rows.Scan(&id); err != nil {
					_ = rows.Close()
					return p, err
				}
				delete(item.ids, id)
			}
			err = rows.Err()
			_ = rows.Close()
			if err != nil {
				return p, err
			}
		}
	}
	if len(refs.artifacts)+len(refs.files)+len(refs.documents) == 0 {
		return p, nil
	}
	blocks, err := refs.cleanJSON(string(p.Blocks), "blocks")
	if err != nil {
		return p, err
	}
	citations, err := refs.cleanJSON(string(p.Citations), "citations")
	if err != nil {
		return p, err
	}
	if blocks != string(p.Blocks) || citations != string(p.Citations) {
		p.Raw = nil // provider-native replay must not retain the old file references
		p.Blocks, p.Citations = json.RawMessage(blocks), json.RawMessage(citations)
	}
	return p, nil
}

func (m missingStorageRefs) collectCandidates(value any, field string) {
	add := func(ids map[string]bool, id string) {
		if id != "" {
			ids[id] = true
		}
	}
	switch v := value.(type) {
	case []any:
		for _, child := range v {
			m.collectCandidates(child, field)
		}
	case map[string]any:
		kind := jsonString(v, "kind")
		if kind == "artifact" || field == "artifacts" {
			add(m.artifacts, jsonString(v, "id"))
			add(m.artifacts, jsonString(v, "file_ref"))
		} else if kind == "attachment" || field == "attachments" {
			add(m.files, jsonString(v, "id"))
			add(m.files, jsonString(v, "file_ref"))
		}
		add(m.documents, jsonString(v, "document_id"))
		add(m.artifacts, jsonString(v, "base_artifact_id"))
		add(m.files, jsonString(v, "mask_file_id"))
		for key, child := range v {
			if text, ok := child.(string); ok && key == "url" {
				for _, target := range storagePlainURL.FindAllString(text, -1) {
					// External sites may expose their own /api/files routes.
					if strings.HasPrefix(target, "/") || strings.HasPrefix(target, "doc://") || strings.HasPrefix(target, "kbdoc://") {
						m.collectURLCandidate(target)
					}
				}
				continue
			}
			m.collectCandidates(child, key)
		}
	}
}

func (m missingStorageRefs) collectURLCandidate(raw string) {
	u, err := url.Parse(raw)
	if err != nil {
		return
	}
	if u.Scheme == "doc" || u.Scheme == "kbdoc" {
		if u.Host != "" {
			m.documents[u.Host] = true
		}
		return
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) < 3 || parts[0] != "api" {
		return
	}
	for i := 1; i+1 < len(parts); i++ {
		switch parts[i] {
		case "artifacts":
			m.artifacts[parts[i+1]] = true
		case "files":
			m.files[parts[i+1]] = true
		case "documents":
			m.documents[parts[i+1]] = true
		}
	}
}
