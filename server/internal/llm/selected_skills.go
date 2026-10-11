package llm

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"aivory/server/internal/store"
)

// Cancelled skills must not return through a prior use_skill exchange. This is
// a request-only projection; the saved transcript remains unchanged.
func stripDisabledSkillHistory(ctx context.Context, db *sql.DB, history []store.Message, ids []string) ([]store.Message, error) {
	if len(ids) == 0 {
		return history, nil
	}
	hasSkillCall := false
	for _, message := range history {
		if message.Role == "assistant" && strings.Contains(string(message.Blocks), "use_skill") {
			hasSkillCall = true
			break
		}
	}
	if !hasSkillCall {
		return history, nil
	}
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	rows, err := db.QueryContext(ctx, `SELECT name FROM skills WHERE id IN (`+strings.TrimRight(strings.Repeat("?,", len(ids)), ",")+`)`, args...)
	if err != nil {
		return nil, err
	}
	names := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			_ = rows.Close()
			return nil, err
		}
		names[strings.ToLower(strings.TrimSpace(name))] = true
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, err
	}
	deniedCalls := map[string]bool{}
	for _, message := range history {
		var blocks []UnifiedBlock
		_ = json.Unmarshal(message.Blocks, &blocks)
		for _, block := range blocks {
			if block.Kind == "tool_call" && block.ToolName == "use_skill" {
				var input struct {
					Name string `json:"name"`
				}
				_ = json.Unmarshal(block.Input, &input)
				if names[strings.ToLower(strings.TrimSpace(input.Name))] {
					deniedCalls[block.ToolID] = true
				}
			}
		}
	}
	out := append([]store.Message(nil), history...)
	for i, message := range out {
		var blocks []UnifiedBlock
		_ = json.Unmarshal(message.Blocks, &blocks)
		kept := []UnifiedBlock{}
		affected := false
		for _, block := range blocks {
			if (block.Kind == "tool_call" || block.Kind == "tool_output") && deniedCalls[block.ToolID] {
				affected = true
				continue
			}
			kept = append(kept, block)
		}
		if affected {
			if strings.TrimSpace(renderBlocksAsText(kept)) == "" {
				kept = append(kept, UnifiedBlock{Kind: "text", Text: "[A previously loaded skill is disabled for this turn.]"})
			}
			out[i].Blocks, _ = json.Marshal(kept)
			out[i].Raw = nil
		}
	}
	return out, nil
}

// Exclusions only remove defaults; unknown IDs cannot grant any capability.
func NormalizeDisabledModelSkillIDs(ids []string) ([]string, error) {
	if len(ids) > 256 {
		return nil, errors.New("too many disabled model skills")
	}
	out := []string{}
	seen := map[string]bool{}
	for _, raw := range ids {
		id := strings.TrimSpace(raw)
		if len(id) > 160 {
			return nil, errors.New("invalid disabled model skill id")
		}
		if id != "" && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out, nil
}

func disabledModelSkillIDSet(ids []string) map[string]bool {
	out := map[string]bool{}
	for _, id := range ids {
		out[id] = true
	}
	return out
}

func selectedAdminSkillIDs(skills []store.UserSkill) map[string]bool {
	ids := map[string]bool{}
	for _, skill := range skills {
		if skill.SourceSkillID != "" {
			ids[skill.SourceSkillID] = true
		}
	}
	return ids
}

func selectedSkillNames(skills []store.UserSkill) []string {
	names := make([]string, 0, len(skills))
	for _, skill := range skills {
		names = append(names, skill.Name)
	}
	return names
}
