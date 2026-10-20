// Synthetic addresses are resolved only by the browser test's mock geocoder.
export const samplePlaces = Array.from({ length: 8 }, (_, index) => ({
  name: `Sample venue ${index + 1}`,
  address: `${index + 1} Example Avenue, Sample City, Test Country`,
}))
export const sampleMap = `<MapWidget points={${JSON.stringify(samplePlaces)}}/>`
export const nestedMap = `<tabs><tab title="Places"><table layout="fixed"><tbody><tr><td><map title="Selected places" height={280}>
  <map-point name="Sample venue" lat={48} lng={2}><card title="Venue details"><image src="https://images.example.test/map.png" width="64px"/><svg viewBox="0 0 32 24" width="32"><path d="M2 20L16 4L30 20" fill="none" stroke="currentColor"/></svg><button prompt="Explain the selected venue">Ask about this place</button></card></map-point>
  <map-point name="Station" lat={48.02} lng={2.03}><box><text>Station details</text><button href="https://example.test/station">Open station</button></box></map-point>
</map></td></tr></tbody></table></tab><tab title="Other"><text>Other panel</text></tab></tabs>`
