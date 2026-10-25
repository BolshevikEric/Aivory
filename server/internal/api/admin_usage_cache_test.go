package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"aivory/server/internal/store"
)

func TestAdminUsageResponseRetainsCacheTokenFields(t *testing.T) {
	d, token, _ := newAuditEvidenceFixture(t)
	for _, protocol := range []string{"openai.chat", "openai.responses", "anthropic.messages", "gemini.generateContent"} {
		if err := store.LogUsageAnalytics(t.Context(), d.DB, store.UsageLog{
			UserID: "audit-member", ModelID: protocol, Purpose: "chat", InputTokens: 100, OutputTokens: 7,
			CacheReadTokens: 40, CacheWriteTokens: 20, Currency: "USD",
		}); err != nil {
			t.Fatal(err)
		}
	}
	mx := newMux()
	mx.handle(http.MethodGet, "/api/admin/usage", requireAdmin(d, usageReportAdmin))
	response := auditEvidenceRequest(mx, http.MethodGet, "/api/admin/usage?purpose=chat&page=1&page_size=50", token, "")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	// Decode the browser's exact field names, independently of store struct tags.
	var payload struct {
		Records []struct {
			ModelID    string `json:"model_id"`
			CacheRead  *int   `json:"cache_read_tokens"`
			CacheWrite *int   `json:"cache_write_tokens"`
		} `json:"records"`
		Total int `json:"total"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Total != 4 || len(payload.Records) != 4 {
		t.Fatalf("payload = %+v, want four usage records", payload)
	}
	for _, record := range payload.Records {
		if record.CacheRead == nil || record.CacheWrite == nil || *record.CacheRead != 40 || *record.CacheWrite != 20 {
			t.Fatalf("model %s lost cache fields: %s", record.ModelID, response.Body.String())
		}
	}
}
