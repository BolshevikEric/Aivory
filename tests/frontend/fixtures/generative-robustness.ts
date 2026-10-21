export const recoveredComponents = `<div class="invented-layout" style="position:fixed" onclick="window.__UNSAFE_GUI__=true">
  <h2>Recovered answer</h2>
  <made-up-card><badge tone="success">Available</badge><text>Preserved details</text></made-up-card>
  <checkbox name="done" label="Done"/>
  <script>window.__UNSAFE_GUI__=true;<button prompt="Unsafe">Unsafe action</button></script>
  <style>body{display:none}</style>
  <iframe src="https://unsafe.example.test"><button prompt="Unsafe">Hidden action</button></iframe>
  <svg viewBox="0 0 60 30" onload="window.__UNSAFE_GUI__=true">
    <foreignObject><button prompt="Unsafe">SVG action</button></foreignObject>
    <rect width="60" height="30"/>
  </svg>
  <button prompt="Review {{done}}">Review</button>
</div>

Result: {done ? "Complete" : "Pending"}

## Next section

Ordinary content is still here.`

export const evolvingState = `<checkbox name="done" label="Done"/>

Result: {done ? "Complete" : "Pending"}. Keep \`{done}\`, $x_{done}$ and \\{done} literal. <input name="notes" label="Notes" value="Draft"/>

Notes: {notes}

## Next section

The remainder stays ordinary Markdown.`
