# layout-lens

Eyes for a coding agent, as text.

Your agent changes some CSS and cannot see what happened. A screenshot is slow, and it still cannot
tell you the label is 3px off center, that the fixed bar is covering the heading, or that the price
is 63px past the end of its card. This opens the page in headless Chromium and prints the answers
with the arithmetic already done.

```
span.badge "Popular" 57.4x18 [renders: background] [pad: 2 8] [pos: top -6, end -10] [text: Helvetica 12/14, ink top 4.4, ink bottom 5, contrast 3.8] [!!: contrast 3.8 under 4.5, #ffffff on #ef4444, clipped top 6, clipped right 10]
```

The badge sits 6px above its card and 10px past its end, so both corners are cut off, and the white
on red fails contrast. One line, no picture, about a second.

## Add it to your agent

It is an MCP server over stdio, so it goes anywhere MCP goes.

Claude Code:

```
claude mcp add -s user layout-lens -- npx --yes --package=layout-lens@latest layout-lens-mcp
```

Codex:

```
codex mcp add layout-lens -- npx --yes --package=layout-lens@latest layout-lens-mcp
```

Cursor, Windsurf, Zed, Continue and anything else that reads the JSON form:

```json
{
  "mcpServers": {
    "layout-lens": {
      "command": "npx",
      "args": ["--yes", "--package=layout-lens@latest", "layout-lens-mcp"]
    }
  }
}
```

Codex keeps the same thing as TOML in `~/.codex/config.toml`, if you would rather write it by hand:

```toml
[mcp_servers.layout-lens]
command = "npx"
args = ["--yes", "--package=layout-lens@latest", "layout-lens-mcp"]
```

Chromium is a separate download that Playwright does once. Nothing runs without it:

```
npx playwright install chromium
```

That is the whole setup. Your agent now has three tools.

- `inspect_layout` measures the page and returns the tree. It takes a url or a file path, a viewport,
  a scroll position, a color scheme, `findings_only` when the agent wants just what looks wrong,
  `colors` for the hex of everything that is painted, and `element` to print one component instead of
  the page.
- `screenshot_layout` returns a png of the same page, whole or one element, when the agent does want
  to look.
- `layout_legend` returns the syntax. A model reads it once instead of on every run.

Tell your agent to run `inspect_layout` after it changes CSS, before it decides it is done.

## What it tells you

Everything is measured from what the browser actually rendered, never from the stylesheet. The agent
can already read the CSS. It cannot see the result.

- Where a box sits inside its parent, and what is off center by how much
- What is clipped, scrolled out of a container, or off the viewport
- What is painted on top of what, and how much of a heading or a button is hidden
- Which text is cut off, with and without an ellipsis
- Where the glyphs sit inside their line box, so a label that looks low is a number
- Contrast ratios against whatever is actually painted behind the text
- The color every box and every word came out as, as hex, with translucency already blended in. A
  screenshot cannot answer that: a glyph is antialiased and a swatch is a few pixels to guess at
- Gaps between siblings, and where one gap breaks the rhythm
- What changed since the last run, so a fix is confirmed in one line

One line per element, or only the ones carrying something when the agent asks for that, under a
summary grouped by kind. `layout_legend` explains every tag and every finding.

The same thing is a command too, `npx layout-lens <url|file>`, with `--help` for the flags. It is
there for a quick look by hand, but the tool is built for the agent.

## License

MIT. Bugs and requests: https://github.com/alabsi91/layout-lens/issues
