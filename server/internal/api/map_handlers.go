package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

type mapLocation struct {
	Lat              float64 `json:"lat"`
	Lng              float64 `json:"lng"`
	Label            string  `json:"label"`
	CoordinateSystem string  `json:"coordinate_system,omitempty"`
}

type mapGeocodeEntry struct {
	location *mapLocation
	expires  time.Time
}

// Serialize cache misses across viewers; repeated addresses never consume the
// public provider's request budget. An operator may point this at their Photon instance.
type mapGeocoder struct {
	endpoint string
	provider string
	apiKey   string
	client   *http.Client
	gate     chan struct{}
	mu       sync.Mutex
	cache    map[string]mapGeocodeEntry
	next     time.Time
	interval time.Duration
}

func newMapGeocoder(endpoint string, client *http.Client) *mapGeocoder {
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &mapGeocoder{endpoint: endpoint, client: client, gate: make(chan struct{}, 1), cache: make(map[string]mapGeocodeEntry), interval: time.Second}
}

func (g *mapGeocoder) cached(query string) (*mapLocation, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	entry, ok := g.cache[query]
	if ok && time.Now().Before(entry.expires) {
		return entry.location, true
	}
	return nil, false
}

// Photon can return a nearby feature with only part of the requested address.
// Keep short queries provider-ranked, but reject clear mismatches in specific addresses.
func mapGeocodeMatchesQuery(query string, properties map[string]any) bool {
	normalize := func(value string) []string {
		return strings.FieldsFunc(strings.ToLower(value), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
	}
	words := normalize(query)
	if len(words) < 3 {
		return true
	}
	values := []string{}
	for _, key := range []string{"name", "housenumber", "street", "locality", "district", "city", "county", "state", "country", "postcode"} {
		if value, ok := properties[key].(string); ok {
			values = append(values, value)
		}
	}
	address := strings.Join(normalize(strings.Join(values, " ")), " ")
	matched := 0
	for _, word := range words {
		if strings.Contains(address, word) {
			matched++
		}
	}
	return float64(matched)/float64(len(words)) >= 0.85
}

func (g *mapGeocoder) lookup(ctx context.Context, query string) (*mapLocation, error) {
	key := strings.ToLower(strings.Join(strings.Fields(query), " "))
	if location, ok := g.cached(key); ok {
		return location, nil
	}
	select {
	case g.gate <- struct{}{}:
		defer func() { <-g.gate }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if location, ok := g.cached(key); ok {
		return location, nil
	}
	if delay := time.Until(g.next); delay > 0 {
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	endpoint, err := url.Parse(g.endpoint)
	if err != nil || endpoint.Host == "" || (endpoint.Scheme != "http" && endpoint.Scheme != "https") {
		return nil, errors.New("invalid map geocoder endpoint")
	}
	if g.provider == "amap" {
		g.next = time.Now().Add(g.interval)
		location, err := g.lookupAMap(ctx, endpoint, query)
		if err != nil {
			return nil, errors.New("map geocoder unavailable")
		}
		g.remember(key, location)
		return location, nil
	}
	params := endpoint.Query()
	params.Set("q", query)
	params.Set("limit", "5")
	endpoint.RawQuery = params.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Aivory-Maps/1.0")
	req.Header.Set("Accept", "application/json")
	g.next = time.Now().Add(g.interval)
	response, err := g.client.Do(req)
	if err != nil {
		return nil, errors.New("map geocoder unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("map geocoder unavailable")
	}
	var result struct {
		Features []struct {
			Geometry struct {
				Type        string    `json:"type"`
				Coordinates []float64 `json:"coordinates"`
			} `json:"geometry"`
			Properties map[string]any `json:"properties"`
		} `json:"features"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 256*1024)).Decode(&result); err != nil {
		return nil, err
	}
	var location *mapLocation
	for _, feature := range result.Features {
		coords := feature.Geometry.Coordinates
		if feature.Geometry.Type != "Point" || len(coords) < 2 || math.IsNaN(coords[0]) || math.IsNaN(coords[1]) || math.Abs(coords[0]) > 180 || math.Abs(coords[1]) > 90 {
			continue
		}
		if !mapGeocodeMatchesQuery(query, feature.Properties) {
			continue
		}
		labels := []string{}
		for _, field := range []string{"name", "street", "city", "state", "country"} {
			if value, ok := feature.Properties[field].(string); ok && value != "" && len(value) <= 300 {
				labels = append(labels, value)
			}
		}
		location = &mapLocation{Lat: coords[1], Lng: coords[0], Label: strings.Join(labels, ", ")}
		break
	}
	g.remember(key, location)
	return location, nil
}

func (g *mapGeocoder) remember(key string, location *mapLocation) {
	ttl := 7 * 24 * time.Hour
	if location == nil {
		ttl = 15 * time.Minute
	}
	g.mu.Lock()
	if len(g.cache) >= 2048 {
		oldestKey := ""
		oldest := time.Now().Add(8 * 24 * time.Hour)
		for key, entry := range g.cache {
			if entry.expires.Before(oldest) {
				oldestKey, oldest = key, entry.expires
			}
		}
		delete(g.cache, oldestKey)
	}
	g.cache[key] = mapGeocodeEntry{location: location, expires: time.Now().Add(ttl)}
	g.mu.Unlock()
}

func (g *mapGeocoder) serveHTTP(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" || len(query) > 2000 || utf8.RuneCountInString(query) > 500 || !utf8.ValidString(query) {
		writeError(w, http.StatusBadRequest, errors.New("map address must contain 1 to 500 characters"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	location, err := g.lookup(ctx, query)
	w.Header().Set("Cache-Control", "no-store")
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"location": location})
}
