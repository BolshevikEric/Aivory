package tools

import (
	"context"
	"fmt"
	"strings"

	"aivory/server/internal/llm"
)

const defaultWebSearchResults = 10

type webSearchResultItem struct {
	citation llm.Citation
	content  string
	date     string
}

type webSearchResults struct {
	items  []webSearchResultItem
	notice string
}

// Structured results preserve bodies and dates when batch citations are renumbered.
type searcherWithResults interface {
	search(context.Context, string, int, webSearchOptions) (webSearchResults, error)
}

func (r webSearchResults) output() (string, []llm.Citation) {
	var out strings.Builder
	citations := make([]llm.Citation, 0, len(r.items))
	for i, item := range r.items {
		item.citation.Index = i + 1
		item.citation.ID = fmt.Sprintf("w_%d", i+1)
		citations = append(citations, item.citation)
		writeWebSearchResult(&out, i+1, item)
	}
	if r.notice != "" {
		out.WriteString(r.notice)
	}
	return out.String(), citations
}

func writeWebSearchResult(out *strings.Builder, index int, item webSearchResultItem) {
	fmt.Fprintf(out, "[%d] %s\n%s\n", index, item.citation.Title, item.citation.URL)
	content := strings.TrimSpace(item.content)
	if content == "" || normalizeSnippet(content) != item.citation.Snippet {
		fmt.Fprintln(out, item.citation.Snippet)
	}
	if content != "" {
		fmt.Fprintf(out, "Content:\n%s\n", content)
	}
	writeSearchImageURLs(out, item.citation.ImageURL, item.citation.ThumbnailURL)
	if item.date != "" {
		fmt.Fprintf(out, "(date: %s)\n", item.date)
	}
	out.WriteString("\n")
}

func searchWithResults(ctx context.Context, searcher Searcher, query string, topK int, options webSearchOptions) (webSearchResults, error) {
	if detailed, ok := searcher.(searcherWithResults); ok {
		return detailed.search(ctx, query, topK, options)
	}
	var text string
	var citations []llm.Citation
	var err error
	if searcher == nil {
		text, citations, err = (&webSearchTool{}).searchOne(ctx, query, topK, options)
	} else {
		text, citations, err = searchWithOptions(ctx, searcher, query, topK, options)
	}
	results := webSearchResults{items: make([]webSearchResultItem, 0, len(citations))}
	for _, citation := range citations {
		results.items = append(results.items, webSearchResultItem{citation: citation})
	}
	if len(citations) == 0 {
		results.notice = text
	}
	return results, err
}
