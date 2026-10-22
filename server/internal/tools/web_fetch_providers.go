package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"unicode/utf8"

	"aivory/server/internal/llm"
	"aivory/server/internal/store"
)

const anySearchExtractEndpoint = "https://api.anysearch.com/v1/extract"

type webFetchConfig struct {
	provider string
	apiKey   string
	jinaBase string
	jinaMode string
}

func (t *webFetchTool) settingString(key, fallback string) string {
	if t.db != nil {
		if raw, err := store.GetSetting(t.db, key); err == nil {
			var value string
			if json.Unmarshal(raw, &value) == nil {
				return strings.TrimSpace(value)
			}
		}
	}
	return strings.TrimSpace(fallback)
}

func (t *webFetchTool) resolveConfig() webFetchConfig {
	provider := strings.ToLower(t.settingString("fetch_provider", t.cfg.FetchProvider))
	if provider == "" {
		provider = "builtin"
	}
	base := t.settingString("fetch_jina_base_url", "")
	if base == "" {
		base = strings.TrimSpace(webFetchJinaBase())
	}
	mode := t.settingString("fetch_jina_url_mode", "")
	if mode == "" {
		mode = webFetchJinaURLMode()
	}
	return webFetchConfig{provider: provider, apiKey: t.settingString("fetch_api_key", t.cfg.FetchAPIKey), jinaBase: base, jinaMode: mode}
}

func (t *webFetchTool) config() webFetchConfig {
	if t.resolved != nil {
		return *t.resolved
	}
	return t.resolveConfig()
}

func (t *webFetchTool) fetchWithProvider(ctx context.Context, target *url.URL) (fetchedPage, error) {
	cfg := t.config()
	if cfg.provider != "deepseek" && cfg.provider != "anysearch" {
		return fetchedPage{}, errors.New("unsupported web fetch provider; ask the administrator to check web reading settings")
	}
	if !jinaTargetAllowed(target) {
		return fetchedPage{}, &llm.ToolUserError{Message: "only public web URLs can be read"}
	}
	if cfg.provider == "deepseek" && cfg.apiKey == "" {
		return fetchedPage{}, errors.New("DeepSeek web reading requires an API key in administrator tool settings")
	}
	body, _ := json.Marshal(struct {
		URL string `json:"url"`
	}{target.String()})
	// AnySearch accepts only a single url field in a UTF-8 JSON body <=16 KiB.
	if cfg.provider == "anysearch" && len(body) > 16*1024 {
		return fetchedPage{}, &llm.ToolUserError{Message: "encoded URL exceeds AnySearch's 16 KiB request limit"}
	}
	endpoint := deepSeekFetchEndpoint
	if cfg.provider == "anysearch" {
		endpoint = anySearchExtractEndpoint
	}
	req, err := newWebProviderRequest(ctx, endpoint, cfg.apiKey, body)
	if err != nil {
		return fetchedPage{}, err
	}
	raw, err := readWebProviderJSON(t.readerClient(), req, cfg.provider)
	if err != nil {
		return fetchedPage{}, err
	}
	var title, content string
	if cfg.provider == "deepseek" {
		var result struct {
			Title   string  `json:"title"`
			Content *string `json:"content"`
		}
		if json.Unmarshal(raw, &result) != nil || result.Content == nil {
			return fetchedPage{}, errors.New("deepseek: invalid fetch response: missing content")
		}
		title, content = result.Title, *result.Content
	} else {
		var result struct {
			Code *int `json:"code"`
			Data *struct {
				URL     string  `json:"url"`
				Title   string  `json:"title"`
				Content *string `json:"content"`
			} `json:"data"`
		}
		if json.Unmarshal(raw, &result) != nil || result.Code == nil {
			return fetchedPage{}, errors.New("anysearch: invalid extract response")
		}
		if *result.Code != 0 {
			return fetchedPage{}, fmt.Errorf("anysearch: extract failed (business code %d)", *result.Code)
		}
		if result.Data == nil || result.Data.Content == nil {
			return fetchedPage{}, errors.New("anysearch: invalid extract response: missing data.content")
		}
		title, content = result.Data.Title, *result.Data.Content
	}
	content = strings.TrimSpace(content)
	if content == "" || !utf8.ValidString(content) {
		return fetchedPage{}, fmt.Errorf("%s: page returned no readable content", cfg.provider)
	}
	return fetchedPage{Title: strings.TrimSpace(title), Text: capExtractedText(content), Images: markdownPageImages(content, target.String())}, nil
}
