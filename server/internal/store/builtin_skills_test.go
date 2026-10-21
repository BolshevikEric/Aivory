package store

import (
	"errors"
	"strings"
	"testing"
)

func TestBuiltinSkillSeedPreservesAdministratorChanges(t *testing.T) {
	db, ctx := openLibraryTestDB(t)
	if err := seedBuiltinSkills(db); err != nil {
		t.Fatal(err)
	}
	skill, err := GetSkill(ctx, db, GenerativeUISkillID)
	if err != nil || !skill.Enabled || !strings.Contains(skill.Instructions, "aivory-ui") {
		t.Fatalf("skill=%+v err=%v", skill, err)
	}
	if strings.Contains(strings.ToLower(skill.Instructions), "json") || strings.Contains(skill.Instructions, "blocks array") {
		t.Fatal("built-in UI instructions mention the retired output format")
	}
	for _, required := range []string{"Both complete UI layouts", "Raw tags do not require a code fence or an outer container", "Immediately following Markdown blocks", "Separate groups do not share state", "do not invent component names", "Code, escaped braces, and LaTeX remain literal"} {
		if !strings.Contains(skill.Instructions, required) {
			t.Errorf("built-in UI instructions are missing %q", required)
		}
	}
	if _, err := db.Exec(`UPDATE skills SET instructions='custom',enabled=0 WHERE id=?`, GenerativeUISkillID); err != nil {
		t.Fatal(err)
	}
	if err := seedBuiltinSkills(db); err != nil {
		t.Fatal(err)
	}
	skill, _ = GetSkill(ctx, db, GenerativeUISkillID)
	if skill.Enabled || skill.Instructions != "custom" {
		t.Fatal("seed overwrote administrator choices")
	}
}

func TestBuiltinSkillSeedUpgradesOnlyUntouchedLegacyFields(t *testing.T) {
	// Synthetic defaults exercise fingerprint migration without retaining retired prompts.
	const retiredDescription = "Retired built-in description"
	const retiredInstructions = "Retired built-in instructions"
	descriptionHashes := []string{builtinSkillFingerprint(retiredDescription)}
	instructionHashes := []string{builtinSkillFingerprint(retiredInstructions)}
	for _, tc := range []struct {
		name, description, instructions   string
		wantDescription, wantInstructions string
	}{
		{"original", retiredDescription, retiredInstructions, generativeUIDescription, generativeUIInstructions},
		{"custom description", "CUSTOM_DESCRIPTION", retiredInstructions, "CUSTOM_DESCRIPTION", generativeUIInstructions},
		{"custom instructions", retiredDescription, "CUSTOM_INSTRUCTIONS", generativeUIDescription, "CUSTOM_INSTRUCTIONS"},
		{"both customized", "CUSTOM_DESCRIPTION", "CUSTOM_INSTRUCTIONS", "CUSTOM_DESCRIPTION", "CUSTOM_INSTRUCTIONS"},
		{"current description previous instructions", generativeUIDescription, retiredInstructions, generativeUIDescription, generativeUIInstructions},
		{"previous description current instructions", retiredDescription, generativeUIInstructions, generativeUIDescription, generativeUIInstructions},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, ctx := openLibraryTestDB(t)
			if err := seedBuiltinSkills(db); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(`UPDATE skills SET name='my-visuals',description=?,instructions=?,enabled=0,icon='custom-icon' WHERE id=?`, tc.description, tc.instructions, GenerativeUISkillID); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(`INSERT INTO channels(id,name,type) VALUES('legacy-channel','Channel','openai');
				INSERT INTO models(id,channel_id,request_id,label) VALUES('legacy-model','legacy-channel','model','Model');
				INSERT INTO model_skills(model_id,skill_id) VALUES('legacy-model','sk_generative_ui')`); err != nil {
				t.Fatal(err)
			}
			if err := refreshBuiltinSkillDefaults(db, descriptionHashes, instructionHashes); err != nil {
				t.Fatal(err)
			}
			skill, err := GetSkill(ctx, db, GenerativeUISkillID)
			if err != nil {
				t.Fatal(err)
			}
			if skill.Description != tc.wantDescription || skill.Instructions != tc.wantInstructions || skill.Enabled || skill.Name != "my-visuals" || skill.Icon != "custom-icon" {
				t.Fatalf("seed failed to preserve customized fields: %+v", skill)
			}
			ids, err := SkillsForModel(ctx, db, "legacy-model")
			if err != nil || len(ids) != 1 || ids[0] != GenerativeUISkillID {
				t.Fatalf("bindings=%v err=%v", ids, err)
			}
			if _, err := db.Exec(`UPDATE skills SET updated_at=123 WHERE id=?`, GenerativeUISkillID); err != nil {
				t.Fatal(err)
			}
			if err := refreshBuiltinSkillDefaults(db, descriptionHashes, instructionHashes); err != nil {
				t.Fatal(err)
			}
			skill, _ = GetSkill(ctx, db, GenerativeUISkillID)
			if skill.UpdatedAt != 123 {
				t.Fatal("repeated seed changed an already migrated skill")
			}
		})
	}
}

func TestCatalogCommandsResolveWithoutLibraryCopyAndDeduplicate(t *testing.T) {
	db, ctx := openLibraryTestDB(t)
	if err := seedBuiltinSkills(db); err != nil {
		t.Fatal(err)
	}
	id := CatalogSkillCommandPrefix + GenerativeUISkillID
	selected, ids, err := ResolveUserSkillSelectionScoped(ctx, db, "u1", "", []string{id, id}, true)
	if err != nil || len(selected) != 1 || len(ids) != 1 || selected[0].SourceSkillID != GenerativeUISkillID {
		t.Fatalf("selection=%+v ids=%v err=%v", selected, ids, err)
	}
	copy, err := CreateUserSkill(ctx, db, UserSkill{UserID: "u1", Name: "my-visuals", Instructions: "EDITED", SourceSkillID: GenerativeUISkillID})
	if err != nil {
		t.Fatal(err)
	}
	selected, ids, err = ResolveUserSkillSelectionScoped(ctx, db, "u1", "", []string{id, copy.ID}, true)
	if err != nil || len(selected) != 1 || selected[0].Instructions != "EDITED" || ids[0] != copy.ID {
		t.Fatalf("selection=%+v ids=%v err=%v", selected, ids, err)
	}
	if _, err := db.Exec(`UPDATE skills SET enabled=0 WHERE id=?`, GenerativeUISkillID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ResolveUserSkillSelectionScoped(ctx, db, "u1", "", []string{id}, true); !errors.Is(err, ErrInvalidUserSkillSelection) {
		t.Fatalf("disabled selection err=%v", err)
	}
	selected, _, err = ResolveUserSkillSelectionScoped(ctx, db, "u1", "", []string{id}, false)
	if err != nil || len(selected) != 0 {
		t.Fatal("regeneration retained disabled direct reference")
	}
}
