# @pipeworx/delaware-code

Delaware Code — state statutes by citation, full-text search, and
amendment history. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1784+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `de_statute(citation)` — full text of a Delaware Code section by
  citation ("11-636" is murder in the first degree; "6-2734" is contracts
  with automatic renewal provisions). Resolves the citation to its one
  chapter/subchapter page via a baked index, fetches that page live, and
  slices out the section's text plus its amendment history.
- `de_search(query, limit?)` — real full-text search over Delaware Code
  statutory text, via the Delaware General Assembly's own live search API
  (not a baked catchline index — see below).

## Auth

Keyless.

## The survey trap was half right

The recorded trap for Delaware was "indexes name chapters but publish no
section ranges" — true: a citation like "11 Del. C. 636" does not say which
of Delaware's ~2,200 chapter/subchapter HTML pages holds it, and unlike
North Dakota there is no single combined index page to bake from. But every
one of those ~2,200 pages is small, plain, keyless HTML (no PDF, no login,
no JS rendering required), and the whole tree is walkable:

```
https://delcode.delaware.gov/index.html                     -> 31 titles
https://delcode.delaware.gov/title11/index.html               -> chapters
https://delcode.delaware.gov/title11/c005/index.html           -> either
    section content directly, or a list of subchapter links
https://delcode.delaware.gov/title11/c005/sc02/index.html    -> section
    content, when the chapter has subchapters
```

So the fix is the same *shape* as `mcps/north-dakota-code` (crawl once,
bake a citation index, fetch live per call) even though the underlying page
layout is completely different — see `scripts/bake-index.mjs` for the
crawl and `src/de-index-data.ts` (generated) for the baked table. The
table stores citation + official catchline + chapter/subchapter/title
context + the ONE content-page URL for that citation — never the
statutory text itself, which `de_statute` fetches live on every call.

### Refresh path

Re-run the bake script whenever Delaware's General Assembly recodifies
(adds, renumbers, or splits a chapter/subchapter):

```
node mcps/delaware-code/scripts/bake-index.mjs > mcps/delaware-code/src/de-index-data.ts
```

It fails loudly if the root index parses to fewer than 25 titles, or the
whole crawl yields suspiciously few content pages or sections — both would
mean delcode.delaware.gov changed its markup rather than that the Code got
smaller. It also prints one `WARNING:` line per chapter/subchapter it found
with no section content (reserved placeholder chapters, or a chapter
transferred elsewhere whose old page carries nothing) — these are skipped,
not treated as failures, because the on-site index itself still lists them.

## de_search calls a REAL full-text search API, not a baked catchline index

Unlike the ND/IA/KY sibling packs, Delaware's Legislature runs a genuine
full-text search behind its on-site search box — found only by reading the
search page's own Kendo grid configuration (there is no documented public
endpoint):

```
POST https://legis.delaware.gov/json/DelCodeSearch/GetDelCodeSearchResults?searchTerm=<q>
```

Verified live: calling it cold, with no prior page load, no cookie, and no
anti-forgery token, still returns results — it is stateless. A search for
"landlord" returns 308 total matches across the whole Code, including
sections whose own title never contains the word "landlord" (it matches
statutory TEXT, not just section captions). `de_search` therefore calls
this endpoint directly instead of falling back to a baked catchline index —
the baked table in this pack exists only to resolve a citation to its one
content page for `de_statute`, not to support search.

## Slicing a section and its history

A leaf page's markup wraps each section as:

```html
<div class="Section">
  <div class="SectionHead" id="636">§ 636. Murder in the first degree; class A felony.</div>
  <p class="subsection">(a) A person is guilty of murder in the first degree when:</p>
  ...
  11 Del. C. 1953, § 636; <a href="...">58 Del. Laws, c. 497, § 1</a>; ...
</div><br><div class="Section">
  ... next section ...
```

The statutory **text** is every `<p>` between one `SectionHead` and the
next. The **amendment history** is the plain-text + `<a>` citation chain
that follows the last `</p>`, up to the `</div><br>` that closes the
`Section` wrapper — that closing pair is the one reliable boundary,
verified to hold both for a middle section (`</div><br><div class="Section">`
follows) and the page's last section (`</div><br></div>` follows, into the
page's own closing tags). Reserved placeholder sections (e.g.
"637-640. [Reserved.]") have no `<p>` at all, so text and history both come
back empty — correctly, not as a parse failure.

## Four capabilities — three available, one is not

- **Section by citation** — available (`de_statute`).
- **Topic/keyword search** — available (`de_search`), and it is REAL
  full-text search (see above), not caption-only.
- **Amendments/history** — available, inside `de_statute`'s response
  (`history` field): the session-law citation chain Delaware prints at the
  end of every section, whether or not it is still in force.
- **Historical version** (a section's text as it read before a specific
  amendment) — **not available**. delcode.delaware.gov publishes only the
  current online edition; there is no per-year archive the way Iowa or
  Indiana publish. A small number of sections carry a forward-looking
  `[Effective until <date>]` / `[Effective <date>]` label pair when a
  future amendment is already scheduled (both current and prospective text
  are then both "current," just not yet both in force) — that is the
  live page's own labeling, not a historical archive, and `de_search`
  passes those labels through verbatim when present.

## Citations

Delaware cites by title-section, e.g. "11-636" (Title 11, Section 636:
murder in the first degree) or "6-2734" (Title 6, Section 2734:
automatic-renewal contracts). `de_statute` also accepts "11 Del. C. § 636",
"11 Del. C. 636", and "Title 11 § 636". A small number of sections carry a
letter suffix ("11-607A") or are indexed under a shared id for a reserved
range ("637-640") — `de_statute` expands ranges and lets a letter-suffixed
citation be looked up directly against the baked index, matching however
delcode.delaware.gov itself prints the section id.

## Data sources

- `https://delcode.delaware.gov/index.html` and its title/chapter/
  subchapter index pages — crawled once into `src/de-index-data.ts`
  (citation, catchline, chapter/subchapter/title context, and the one
  content-page URL per citation); never fetched per call.
- `https://delcode.delaware.gov/title<N>/.../index.html` — the one
  chapter or subchapter page holding a given section's full text.
  `de_statute` fetches this live on every call.
- `https://legis.delaware.gov/json/DelCodeSearch/GetDelCodeSearchResults`
  — the Delaware General Assembly's own full-text search API.
  `de_search` calls this live on every call.

All three are plain, keyless, public — no login, no API key, no rate limit
observed during development.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "delaware-code": {
      "url": "https://gateway.pipeworx.io/delaware-code/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/delaware-code/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1784+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/de_statute \
  -H 'Content-Type: application/json' \
  -d '{"citation":"11-636"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/de_statute`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "delaware-code": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-delaware-code"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-delaware-code
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Delaware Code data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
