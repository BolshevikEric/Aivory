package store

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestMissingStorageReferencesKeepHealthyGroupedArtifactsAndAttachments(t *testing.T) {
	refs := missingStorageRefs{artifacts: map[string]bool{"gone": true}, files: map[string]bool{"lost-upload": true}, documents: map[string]bool{"lost-doc": true}}
	input := `[
		{"kind":"text","text":"Keep [label](/api/artifacts/gone) and [healthy](/api/artifacts/gone_elsewhere)","future_field":9007199254740993},
		{"kind":"artifact","artifacts":[{"id":"gone","url":"/api/artifacts/gone"}]},
		{"kind":"artifact","file_ref":"gone","url":"/api/artifacts/gone","artifacts":[{"id":"gone","url":"/api/artifacts/gone"},{"id":"healthy","filename":"healthy.txt","url":"/api/artifacts/healthy","mime_type":"text/plain"}]},
		{"kind":"tool_call","tool_id":"call","input":{"custom":"preserve"}},
		{"kind":"tool_output","tool_id":"call","text":"Keep output"}
	]`
	got, err := refs.cleanJSON(input, "blocks")
	if err != nil {
		t.Fatal(err)
	}
	var blocks []map[string]any
	if err := json.Unmarshal([]byte(got), &blocks); err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 5 || blocks[2]["file_ref"] != "healthy" || blocks[2]["url"] != "/api/artifacts/healthy" || !strings.Contains(got, "9007199254740993") || strings.Contains(got, `"id":"gone"`) || blocks[3]["tool_id"] != blocks[4]["tool_id"] || !strings.Contains(got, "Keep label and [healthy]") {
		t.Fatalf("damaged mixed message: %s", got)
	}
	attachments := `[{"id":"healthy-upload","document_id":"lost-doc","filename":"keep.pdf","url":"/api/files/healthy-upload"},{"id":"lost-upload","filename":"lost.pdf","url":"/api/files/lost-upload"}]`
	got, err = refs.cleanJSON(attachments, "attachments")
	if err != nil {
		t.Fatal(err)
	}
	var atts []map[string]any
	if err := json.Unmarshal([]byte(got), &atts); err != nil {
		t.Fatal(err)
	}
	if atts[0]["url"] != "/api/files/healthy-upload" || atts[0]["deleted"] == true || atts[0]["document_id"] != nil || atts[1]["deleted"] != true || atts[1]["url"] != nil {
		t.Fatalf("healthy upload or missing tombstone damaged: %s", got)
	}
	if again, err := refs.cleanJSON(got, "attachments"); err != nil || again != got {
		t.Fatalf("repair is not idempotent: %s %v", again, err)
	}
}

func TestMissingArtifactOnlyMessageRetainsReadableContent(t *testing.T) {
	refs := missingStorageRefs{map[string]bool{"gone": true}, map[string]bool{}, map[string]bool{}}
	for _, raw := range []string{
		`[{"kind":"artifact","file_ref":"gone","title":"report.txt","url":"/api/artifacts/gone"}]`,
		`[{"kind":"artifact","artifacts":[{"id":"gone","url":"/api/artifacts/gone"}]}]`,
	} {
		got, err := refs.cleanJSON(raw, "blocks")
		if err != nil || strings.Contains(got, "gone") || !strings.Contains(got, `"kind":"text"`) || searchTextFromBlocks(json.RawMessage(got)) == "" {
			t.Fatalf("empty or broken assistant turn: %s %v", got, err)
		}
	}
}

func TestStorageRepairPreservesUnrelatedHistoricalMetadata(t *testing.T) {
	refs := missingStorageRefs{map[string]bool{"gone": true}, map[string]bool{}, map[string]bool{}}
	for _, raw := range []string{`[{"kind":"text","text":"Untouched"}]`, `historical invalid json`, `[{"kind":"text"}] trailing garbage`} {
		got, err := refs.cleanJSON(raw, "blocks")
		if err != nil || got != raw {
			t.Fatalf("changed unrelated history: got=%q err=%v", got, err)
		}
	}
}
