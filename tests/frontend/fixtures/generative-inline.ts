export const interleavedComponents = `## Plan comparison <badge tone="success">Available</badge>

Start with **Basic** <badge>12 USD / month</badge> for occasional use. Keep the estimate $x<y$ and the source \`<button>Example</button>\` as text.

3. Compare the options <button href="https://example.test/plans" variant="outline">View plans</button> before deciding.
4. Keep the expected usage in mind.

> The price is illustrative. <badge tone="info">Example</badge> Check the current offer.

| Plan | Monthly cost | Status |
| --- | ---: | --- |
| Basic | 12 USD | <badge>Available</badge> |
| Pro | 24 USD | <badge tone="info">More capacity</badge> |

Choose <select name="plan" label="Plan" value="Basic"><option value="Basic">Basic</option><option value="Pro">Pro</option></select> then <button prompt="Compare the {{plan}} plan for my usage" variant="outline">Compare for me</button>.

A complete layout can follow the explanation:

\`\`\`aivory-ui
<box gap={3}>
  <slider name="quantity" label="Quantity" min={1} max={20} value={3}/>
  <text>Total: {quantity * 12} USD</text>
</box>
\`\`\`

The recommendation can also include <card title="Suggested next step"><text>Use your expected monthly usage to compare the plans.</text><button href="https://example.test/details" variant="outline">View details</button></card> before the final decision.`
