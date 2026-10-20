package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestMapGeocoderCoordinatesCacheAndRequest(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Query().Get("limit") != "5" || r.Header.Get("User-Agent") == "" || r.URL.Query().Get("q") != "12 Example Avenue Sampleville" {
			t.Errorf("invalid geocoder request: %s", r.URL)
		}
		_, _ = w.Write([]byte(`{"features":[{"geometry":{"type":"Point","coordinates":[2.125,48.25]},"properties":{"name":"Sample venue","housenumber":"12","street":"Example Avenue","city":"Sampleville"}}]}`))
	}))
	defer upstream.Close()
	g := newMapGeocoder(upstream.URL, upstream.Client())
	var wg sync.WaitGroup
	for range 6 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			point, err := g.lookup(context.Background(), "12 Example Avenue Sampleville")
			if err != nil || point == nil || point.Lat != 48.25 || point.Lng != 2.125 || point.Label != "Sample venue, Example Avenue, Sampleville" {
				t.Errorf("point=%+v err=%v", point, err)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("duplicate address requested %d times", calls.Load())
	}
	_, _ = g.lookup(context.Background(), "12   example avenue SAMPLEVILLE")
	if calls.Load() != 1 {
		t.Fatal("normalized address did not use cache")
	}
}

func TestMapGeocoderMissesFailuresAndValidation(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		status     int
		wantStatus int
		wantCalls  int32
	}{
		{"missing", `{"features":[]}`, 200, 200, 1},
		{"invalid coordinates", `{"features":[{"geometry":{"type":"Point","coordinates":[200,100]}}]}`, 200, 200, 1},
		{"provider failure", `provider secret`, 503, 502, 2},
		{"invalid response", `not data`, 200, 502, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				calls.Add(1)
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer upstream.Close()
			g := newMapGeocoder(upstream.URL, upstream.Client())
			g.interval = 0
			for range 2 {
				recorder := httptest.NewRecorder()
				g.serveHTTP(recorder, httptest.NewRequest("GET", "/?q=somewhere", nil))
				if recorder.Code != tc.wantStatus || strings.Contains(recorder.Body.String(), "provider secret") {
					t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body)
				}
			}
			if calls.Load() != tc.wantCalls {
				t.Fatalf("upstream calls=%d want=%d", calls.Load(), tc.wantCalls)
			}
			for _, query := range []string{"", strings.Repeat("a", 501)} {
				recorder := httptest.NewRecorder()
				g.serveHTTP(recorder, httptest.NewRequest("GET", "/?q="+query, nil))
				if recorder.Code != http.StatusBadRequest {
					t.Fatalf("invalid query status=%d", recorder.Code)
				}
			}
		})
	}
}

func TestMapGeocoderQueuedCancellation(t *testing.T) {
	g := newMapGeocoder("https://example.invalid", nil)
	g.gate <- struct{}{}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, err := g.lookup(ctx, "queued"); err != context.DeadlineExceeded {
		t.Fatalf("queued lookup error=%v", err)
	}
}

func TestMapGeocoderRejectsUnrelatedNearbyFeatures(t *testing.T) {
	if mapGeocodeMatchesQuery("Example North Station Sampleville", map[string]any{"name": "Sample supermarket", "street": "70 Example Avenue, South Station", "city": "Sampleville"}) {
		t.Fatal("nearby supermarket was accepted as a different station")
	}
	if !mapGeocodeMatchesQuery("12 Example Avenue Sampleville 12345", map[string]any{"name": "Sample venue", "housenumber": "12", "street": "Example Avenue", "city": "Sampleville", "postcode": "12345"}) {
		t.Fatal("specific street address was rejected")
	}
}
