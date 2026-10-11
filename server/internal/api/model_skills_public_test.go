package api

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"aivory/server/internal/config"
	"aivory/server/internal/store"
	"aivory/server/internal/tools"
)

func TestModelsExposePermittedBoundSkillMetadataWithoutInstructions(t *testing.T) {
	db := openMigrated(t, filepath.Join(t.TempDir(), "public-model-skills.db"))
	defer db.Close()
	for _, query := range []string{
		`INSERT INTO users(id,email,password_hash) VALUES('u1','skills@example.test','h')`,
		`INSERT INTO channels(id,name,type) VALUES('ch_skills','Channel','openai')`,
		`INSERT INTO models(id,channel_id,request_id,label,tool_mode) VALUES('m_skills','ch_skills','model','Model','native')`,
		`INSERT INTO skills(id,name,description,display_description,instructions,enabled) VALUES('sk_default','default-analysis','TRIGGER_SECRET','Public description','BODY_SECRET',1)`,
		`INSERT INTO model_skills(model_id,skill_id) VALUES('m_skills','sk_default')`,
	} {
		if _, err := db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	d := Deps{DB: db, Tools: tools.NewRegistry(db, config.Config{}, log.New(io.Discard, "", 0))}
	model, err := store.GetModel(t.Context(), db, "m_skills")
	if err != nil {
		t.Fatal(err)
	}
	request := libraryRequest(t, http.MethodGet, "/api/models", "", "u1")
	response := modelsResponse(d, request, []store.Model{*model})
	raw, _ := json.Marshal(response)
	if strings.Contains(string(raw), "SECRET") || !strings.Contains(string(raw), `"bound_skills":[{"id":"sk_default"`) || !strings.Contains(string(raw), `"skills_default_enabled":true`) {
		t.Fatalf("public response=%s", raw)
	}
	model.BuiltinTools = json.RawMessage(`[]`)
	raw, _ = json.Marshal(modelsResponse(d, request, []store.Model{*model}))
	if !strings.Contains(string(raw), `"skills_default_enabled":false`) || !strings.Contains(string(raw), "Public description") {
		t.Fatalf("empty defaults hid manually available skills: %s", raw)
	}
	p := store.DefaultUserGroupPermissions()
	p.AllowSkills = false
	permissions, _ := json.Marshal(p)
	if _, err := db.Exec(`INSERT INTO user_groups(id,name,permissions) VALUES('g_noskills','No skills',?); UPDATE users SET group_id='g_noskills' WHERE id='u1'`, string(permissions)); err != nil {
		t.Fatal(err)
	}
	raw, _ = json.Marshal(modelsResponse(d, libraryRequest(t, http.MethodGet, "/api/models", "", "u1"), []store.Model{*model}))
	if strings.Contains(string(raw), "sk_default") || !strings.Contains(string(raw), `"bound_skills":[]`) {
		t.Fatalf("forbidden metadata exposed=%s", raw)
	}
}
