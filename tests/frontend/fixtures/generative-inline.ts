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

export const weeklyProgressControls = `<tabs label="Weekly plan">
  <tab title="Week 1"><checkbox name="w1c" label="Completed week 1"/></tab>
  <tab title="Week 2"><checkbox name="w2c" label="Completed week 2"/></tab>
  <tab title="Week 3"><checkbox name="w3c" label="Completed week 3"/></tab>
  <tab title="Week 4">
    <checkbox name="w4c" label="Completed week 4"/>
    <button prompt="Generate a research report template" variant="outline">Generate report template</button>
  </tab>
</tabs>`

export const weeklyProgressSummary = 'Progress: Week 1 {w1c ? "\u2705" : "\u25cb"} / Week 2 {w2c ? "\u2705" : "\u25cb"} / Week 3 {w3c ? "\u2705" : "\u25cb"} / Week 4 {w4c ? "\u2705" : "\u25cb"}'

export const weeklyProgress = `${weeklyProgressControls}

${weeklyProgressSummary}

## Research card

Record the weekly findings here.`
