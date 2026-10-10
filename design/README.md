# Design source

`figma-brand-board.js` builds the Domi Hearing foundations in Figma: colour variables (Light and Dark as
two matching collections, because Starter plans allow one mode per collection), the type scale as text
styles, the logo as components, and a brand board.

It was written for the Figma MCP `use_figma` tool and is ready to run against
`https://www.figma.com/design/wiTX5ptZ11FaQR8B9JT9IS` once the account's MCP call limit resets or the plan
is upgraded (Starter / View seats get 20 calls a month; Dev or Full seats on Professional get 200 a day).

The app in `public/` already uses these exact tokens, so Figma and code match. `/brand` on the running app
shows the same board in the browser.
