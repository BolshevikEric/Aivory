package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type mapConfig struct {
	Provider     string
	WebKey       string
	JSKey        string
	SecurityCode string
}

func mapConfigFor(d Deps) mapConfig {
	return mapConfig{
		Provider:     settingString(d, "map_provider", "osm"),
		WebKey:       settingString(d, "map_amap_web_api_key", ""),
		JSKey:        settingString(d, "map_amap_js_api_key", ""),
		SecurityCode: settingString(d, "map_amap_security_secret", ""),
	}
}

func (c mapConfig) configured() bool {
	return c.Provider == "osm" || c.Provider == "amap" && c.WebKey != "" && c.JSKey != "" && c.SecurityCode != ""
}

func publicMapConfig(d Deps, w http.ResponseWriter, _ *http.Request) {
	cfg := mapConfigFor(d)
	w.Header().Set("Cache-Control", "no-store")
	out := map[string]any{"provider": cfg.Provider, "configured": cfg.configured()}
	if cfg.Provider == "amap" && cfg.configured() {
		// The browser key is public by design; the Web Service key and jscode stay server-side.
		out["js_api_key"] = cfg.JSKey
	}
	writeJSON(w, http.StatusOK, out)
}

type mapService struct {
	photon   *mapGeocoder
	client   *http.Client
	endpoint string
	mu       sync.Mutex
	amap     *mapGeocoder
}

func newMapService(photonEndpoint string) *mapService {
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	return &mapService{photon: newMapGeocoder(photonEndpoint, client), client: client, endpoint: "https://restapi.amap.com"}
}

func (s *mapService) geocode(d Deps, w http.ResponseWriter, r *http.Request) {
	cfg := mapConfigFor(d)
	w.Header().Set("Cache-Control", "no-store")
	if expected := r.URL.Query().Get("provider"); expected != "" && expected != cfg.Provider {
		writeError(w, http.StatusConflict, errors.New("map provider changed; reload the map"))
		return
	}
	if !cfg.configured() {
		writeError(w, http.StatusServiceUnavailable, errors.New("map service is not configured"))
		return
	}
	if cfg.Provider == "osm" {
		s.photon.serveHTTP(w, r)
		return
	}
	s.mu.Lock()
	if s.amap == nil || s.amap.apiKey != cfg.WebKey {
		s.amap = newMapGeocoder(s.endpoint, s.client)
		s.amap.provider, s.amap.apiKey = "amap", cfg.WebKey
	}
	g := s.amap
	s.mu.Unlock()
	g.serveHTTP(w, r)
}

// AMap sometimes returns [] instead of an empty string for optional fields.
func amapText(raw json.RawMessage) string {
	var value string
	_ = json.Unmarshal(raw, &value)
	return value
}

func amapLocation(value, label string) *mapLocation {
	parts := strings.Split(value, ",")
	if len(parts) != 2 {
		return nil
	}
	lng, errLng := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64)
	lat, errLat := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
	if errLng != nil || errLat != nil || math.IsNaN(lng) || math.IsNaN(lat) || math.Abs(lng) > 180 || math.Abs(lat) > 90 {
		return nil
	}
	return &mapLocation{Lat: lat, Lng: lng, Label: label, CoordinateSystem: "gcj02"}
}

func (g *mapGeocoder) lookupAMap(ctx context.Context, endpoint *url.URL, query string) (*mapLocation, error) {
	for _, path := range []string{"/v3/geocode/geo", "/v3/place/text"} {
		endpoint.Path = path
		params := url.Values{"key": {g.apiKey}, "output": {"JSON"}}
		if path == "/v3/geocode/geo" {
			params.Set("address", query)
		} else {
			params.Set("keywords", query)
			params.Set("offset", "1")
			params.Set("page", "1")
			params.Set("extensions", "base")
		}
		endpoint.RawQuery = params.Encode()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
		if err != nil {
			return nil, err
		}
		response, err := g.client.Do(req)
		if err != nil {
			return nil, errors.New("map geocoder unavailable")
		}
		var body struct {
			Status   string `json:"status"`
			Geocodes []struct {
				Location string `json:"location"`
				Address  string `json:"formatted_address"`
			} `json:"geocodes"`
			POIs []struct {
				Location string          `json:"location"`
				Name     string          `json:"name"`
				Province json.RawMessage `json:"pname"`
				City     json.RawMessage `json:"cityname"`
				District json.RawMessage `json:"adname"`
				Address  json.RawMessage `json:"address"`
			} `json:"pois"`
		}
		decodeErr := json.NewDecoder(io.LimitReader(response.Body, 256*1024)).Decode(&body)
		response.Body.Close()
		if response.StatusCode != http.StatusOK || decodeErr != nil || body.Status != "1" {
			return nil, errors.New("AMap address lookup failed")
		}
		for _, item := range body.Geocodes {
			if location := amapLocation(item.Location, item.Address); location != nil {
				return location, nil
			}
		}
		for _, item := range body.POIs {
			parts := []string{}
			for _, value := range []string{amapText(item.Province), amapText(item.City), amapText(item.District), amapText(item.Address), item.Name} {
				if value != "" {
					parts = append(parts, value)
				}
			}
			if location := amapLocation(item.Location, strings.Join(parts, " ")); location != nil {
				return location, nil
			}
		}
	}
	return nil, nil
}

var amapCallback = regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$`)
var amapCredential = regexp.MustCompile(`^[A-Za-z0-9_-]{1,256}$`)

// Fixed upstream hosts and paths implement AMap's documented serviceHost proxy.
func (s *mapService) proxy(d Deps, w http.ResponseWriter, r *http.Request) {
	cfg := mapConfigFor(d)
	w.Header().Set("Cache-Control", "no-store")
	if cfg.Provider != "amap" || !cfg.configured() {
		writeError(w, 503, errors.New("AMap is not configured"))
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/public/maps/_AMapService")
	host := "https://restapi.amap.com"
	if path == "/v4/map/styles" {
		host = "https://webapi.amap.com"
	} else if path != "/v4/maps" && path != "/v4/map/engine" && path != "/v3/log/init" {
		writeError(w, 404, errors.New("unsupported AMap service"))
		return
	}
	params := r.URL.Query()
	if callback := params.Get("callback"); callback != "" && !amapCallback.MatchString(callback) {
		writeError(w, 400, errInvalidInput)
		return
	}
	params.Set("key", cfg.JSKey)
	params.Set("jscode", cfg.SecurityCode)
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, host+path+"?"+params.Encode(), nil)
	if err != nil {
		writeError(w, 502, errors.New("AMap service unavailable"))
		return
	}
	response, err := s.client.Do(req)
	if err != nil {
		writeError(w, 502, errors.New("AMap service unavailable"))
		return
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024+1))
	if err != nil || len(body) > 2*1024*1024 || response.StatusCode != http.StatusOK {
		writeError(w, 502, errors.New("AMap service unavailable"))
		return
	}
	// Never reflect server credentials in a provider error response.
	text := strings.ReplaceAll(string(body), cfg.SecurityCode, "[redacted]")
	text = strings.ReplaceAll(text, cfg.WebKey, "[redacted]")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if params.Get("callback") != "" {
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, text)
}
