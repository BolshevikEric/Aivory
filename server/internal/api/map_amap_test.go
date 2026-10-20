package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"aivory/server/internal/store"
)

func TestAMapGeocodingAndPlaceFallback(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Query().Get("key") != "web-test-key" || r.URL.Query().Get("output") != "JSON" {
			t.Errorf("missing AMap credentials/format")
		}
		if r.URL.Path == "/v3/geocode/geo" {
			if r.URL.Query().Get("address") == "Example Avenue" {
				io.WriteString(w, `{"status":"1","geocodes":[{"location":"100,30","formatted_address":"Example Avenue"}]}`)
			} else {
				io.WriteString(w, `{"status":"1","geocodes":[]}`)
			}
		} else if r.URL.Path == "/v3/place/text" {
			if r.URL.Query().Get("keywords") != "Example Plaza" || r.URL.Query().Get("offset") != "1" {
				t.Errorf("incorrect place lookup")
			}
			io.WriteString(w, `{"status":"1","pois":[{"location":"100.01,30.02","name":"Example Plaza","pname":[],"cityname":"Example City","address":[]}]}`)
		} else {
			t.Errorf("unexpected upstream path: %s", r.URL.Path)
		}
	}))
	defer upstream.Close()
	g := newMapGeocoder(upstream.URL, upstream.Client())
	g.provider, g.apiKey, g.interval = "amap", "web-test-key", 0
	location, err := g.lookup(context.Background(), "Example Avenue")
	if err != nil || location == nil || location.Lat != 30 || location.Lng != 100 || location.CoordinateSystem != "gcj02" {
		t.Fatalf("location=%+v error=%v", location, err)
	}
	_, _ = g.lookup(context.Background(), "Example Avenue")
	if calls.Load() != 1 {
		t.Fatal("AMap cache was not used")
	}
	location, err = g.lookup(context.Background(), "Example Plaza")
	if err != nil || location == nil || location.Label != "Example City Example Plaza" || location.Lat != 30.02 || calls.Load() != 3 {
		t.Fatalf("fallback location=%+v error=%v calls=%d", location, err, calls.Load())
	}
}

func TestAMapFailuresAreNotCachedOrExposed(t *testing.T) {
	for _, body := range []string{`{"status":"0","info":"web-test-secret"}`, `not json`, `{"status":"1","geocodes":[{"location":"NaN,100"}]}`} {
		var calls int
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls++; io.WriteString(w, body) }))
		g := newMapGeocoder(upstream.URL, upstream.Client())
		g.provider, g.apiKey, g.interval = "amap", "web-test-secret", 0
		for range 2 {
			rec := httptest.NewRecorder()
			g.serveHTTP(rec, httptest.NewRequest("GET", "/?q=Example", nil))
			if strings.Contains(rec.Body.String(), "web-test-secret") {
				t.Fatal("provider secret leaked")
			}
			if strings.Contains(body, `"status":"0"`) || body == "not json" {
				if rec.Code != 502 {
					t.Fatalf("failure status=%d", rec.Code)
				}
			} else if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"location":null`) {
				t.Fatalf("invalid position was accepted: %s", rec.Body)
			}
		}
		if calls != 2 {
			t.Fatalf("unexpected request/cache count: %d", calls)
		}
		upstream.Close()
	}
}

func TestMapProviderSettingsAndPublicSecrets(t *testing.T) {
	store.InvalidateConfig()
	t.Cleanup(store.InvalidateConfig)
	db := openMigrated(t, filepath.Join(t.TempDir(), "maps.db"))
	defer db.Close()
	d := Deps{DB: db}
	get := func() string {
		rec := httptest.NewRecorder()
		publicMapConfig(d, rec, httptest.NewRequest("GET", "/", nil))
		return rec.Body.String()
	}
	if body := get(); !strings.Contains(body, `"provider":"osm"`) || !strings.Contains(body, `"configured":true`) {
		t.Fatalf("default config=%s", body)
	}
	patch := map[string]json.RawMessage{"map_provider": json.RawMessage(`"amap"`)}
	if _, err := applyAdminSettingsPatch(context.Background(), d, patch, true, ""); err == nil {
		t.Fatal("incomplete AMap config accepted")
	}
	patch["map_amap_web_api_key"] = json.RawMessage(`"web-test-secret"`)
	patch["map_amap_js_api_key"] = json.RawMessage(`"js-public-key"`)
	patch["map_amap_security_secret"] = json.RawMessage(`"security-test-secret"`)
	if _, err := applyAdminSettingsPatch(context.Background(), d, patch, true, ""); err != nil {
		t.Fatal(err)
	}
	if body := get(); !strings.Contains(body, "js-public-key") || strings.Contains(body, "web-test-secret") || strings.Contains(body, "security-test-secret") {
		t.Fatalf("public config leaked credentials: %s", body)
	}
	rec := httptest.NewRecorder()
	adminSettingsGet(d, rec, httptest.NewRequest("GET", "/", nil))
	for _, value := range []string{"web-test-secret", "js-public-key", "security-test-secret"} {
		if strings.Contains(rec.Body.String(), value) {
			t.Fatal("admin settings returned an unmasked credential")
		}
	}
	for key := range patch {
		if key != "map_provider" {
			patch[key] = json.RawMessage(`"••••••"`)
		}
	}
	if _, err := applyAdminSettingsPatch(context.Background(), d, patch, true, ""); err != nil {
		t.Fatalf("masked roundtrip: %v", err)
	}
	if mapConfigFor(d).WebKey != "web-test-secret" {
		t.Fatal("masked roundtrip changed saved key")
	}
	for _, value := range []string{`"invalid"`, `[]`, `42`} {
		if _, err := applyAdminSettingsPatch(context.Background(), d, map[string]json.RawMessage{"map_provider": json.RawMessage(value)}, true, ""); err == nil {
			t.Fatalf("invalid provider accepted: %s", value)
		}
	}
	if _, err := applyAdminSettingsPatch(context.Background(), d, map[string]json.RawMessage{"map_amap_web_api_key": json.RawMessage(`""`)}, true, ""); err == nil {
		t.Fatal("active AMap credentials could be cleared")
	}
}

func TestMapServiceSwitchingAndKeyRotation(t *testing.T) {
	store.InvalidateConfig()
	t.Cleanup(store.InvalidateConfig)
	db := openMigrated(t, filepath.Join(t.TempDir(), "switch.db"))
	defer db.Close()
	d := Deps{DB: db}
	var photonCalls, amapCalls int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/photon" {
			photonCalls++
			io.WriteString(w, `{"features":[{"geometry":{"type":"Point","coordinates":[2,48]}}]}`)
		} else {
			amapCalls++
			io.WriteString(w, `{"status":"1","geocodes":[{"location":"100,30","formatted_address":"Example"}]}`)
		}
	}))
	defer upstream.Close()
	s := newMapService(upstream.URL + "/photon")
	s.endpoint = upstream.URL
	request := func(provider string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		s.geocode(d, rec, httptest.NewRequest("GET", "/?q=Example&provider="+provider, nil))
		return rec
	}
	if rec := request("osm"); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"lng":2`) {
		t.Fatalf("OSM result=%s", rec.Body)
	}
	for key, value := range map[string]string{"map_provider": "amap", "map_amap_web_api_key": "web-one", "map_amap_js_api_key": "js-key", "map_amap_security_secret": "security"} {
		if err := store.SetSetting(db, key, value); err != nil {
			t.Fatal(err)
		}
	}
	if request("osm").Code != 409 {
		t.Fatal("stale provider request was not rejected")
	}
	if rec := request("amap"); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"coordinate_system":"gcj02"`) {
		t.Fatalf("AMap result=%s", rec.Body)
	}
	request("amap")
	store.SetSetting(db, "map_amap_web_api_key", "web-two")
	request("amap")
	if amapCalls != 2 || photonCalls != 1 {
		t.Fatalf("provider cache isolation/rotation failed: photon=%d amap=%d", photonCalls, amapCalls)
	}
	store.SetSetting(db, "map_amap_web_api_key", "")
	if request("amap").Code != 503 || photonCalls != 1 {
		t.Fatal("unconfigured AMap fell back to another service")
	}
}

type mapRoundTrip func(*http.Request) (*http.Response, error)

func (fn mapRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return fn(r) }

func TestAMapSDKProxy(t *testing.T) {
	store.InvalidateConfig()
	t.Cleanup(store.InvalidateConfig)
	db := openMigrated(t, filepath.Join(t.TempDir(), "proxy.db"))
	defer db.Close()
	d := Deps{DB: db}
	for key, value := range map[string]string{"map_provider": "amap", "map_amap_web_api_key": "web-private", "map_amap_js_api_key": "js-public", "map_amap_security_secret": "security-private"} {
		store.SetSetting(db, key, value)
	}
	s := newMapService("https://photon.example.test")
	var calls int
	s.client = &http.Client{Transport: mapRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Host != "webapi.amap.com" || r.URL.Path != "/v4/map/styles" || r.URL.Query().Get("jscode") != "security-private" || r.URL.Query().Get("key") != "js-public" || r.Header.Get("Cookie") != "" {
			t.Errorf("incorrect proxy request")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`callback({"info":"security-private web-private"})`))}, nil
	})}
	rec := httptest.NewRecorder()
	s.proxy(d, rec, httptest.NewRequest("GET", "/api/public/maps/_AMapService/v4/map/styles?callback=callback&key=attacker&jscode=attacker", nil))
	if rec.Code != 200 || !strings.Contains(rec.Header().Get("Content-Type"), "javascript") || strings.Contains(rec.Body.String(), "private") {
		t.Fatalf("proxy result=%d %s", rec.Code, rec.Body)
	}
	for _, path := range []string{"/v4/map/styles?callback=alert(1)", "/v3/other/secret", "/../admin/settings"} {
		rec := httptest.NewRecorder()
		s.proxy(d, rec, httptest.NewRequest("GET", "/api/public/maps/_AMapService"+path, nil))
		if rec.Code != 400 && rec.Code != 404 {
			t.Fatalf("invalid proxy path accepted: %s", path)
		}
	}
	if calls != 1 {
		t.Fatal("invalid proxy request reached upstream")
	}
}
