interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * Delaware Code — state statutes by citation, full-text search, and
 * amendment history. Fleet #2749.
 *
 * SOURCE AND SHAPE. The survey trap recorded for Delaware was "indexes name
 * chapters but publish no section ranges": delcode.delaware.gov publishes
 * every title and chapter as plain HTML, but a citation like "11 Del. C.
 * 636" does not say which of ~2,200 chapter/subchapter pages holds it, and
 * there is no single combined index page the way North Dakota's is. The
 * fix is the same shape as mcps/north-dakota-code: crawl the whole
 * title/chapter/subchapter tree ONCE and bake citation -> content-page-URL
 * + official catchline + chapter/subchapter/title context into
 * `de-index-data.ts` (`scripts/bake-index.mjs`; see its own header for the
 * refresh path). de_statute uses that baked table only to resolve a
 * citation to its one content page, then fetches and slices that page
 * LIVE — the statutory text itself is never baked.
 *
 * A chapter page is a LEAF (carries section content directly) the moment
 * it has any `<div class="SectionHead">`; otherwise it lists subchapter
 * links and the subchapter pages are the leaves. Both shapes verified live
 * (e.g. title11/c005 lists 7 subchapters; title16/c025 holds 30 sections
 * directly). No deeper nesting observed anywhere in the tree.
 *
 * FULL-TEXT SEARCH IS LIVE, NOT BAKED. Unlike the ND/IA/KY sibling packs,
 * Delaware's Legislature runs a real full-text search API behind the
 * on-site search box (confirmed live 2026-10, found only by reading the
 * search page's own Kendo grid config — there is no documented public
 * endpoint):
 *
 *   POST https://legis.delaware.gov/json/DelCodeSearch/GetDelCodeSearchResults?searchTerm=<q>
 *
 * It is stateless and keyless — no cookie, session, or anti-forgery token
 * needed, verified by calling it cold with no prior GET. It searches
 * statutory TEXT, not just catchlines (searching "landlord" returns 308
 * hits including sections whose catchline never says "landlord"), so
 * de_search calls it directly rather than falling back to the baked
 * catchline index other state packs use when their state publishes no
 * search. The baked index therefore exists ONLY for de_statute's citation
 * resolution, not for search.
 *
 * SLICING A SECTION. Each piece of content on a leaf page is
 * `<div class="Section"><div class="SectionHead" id="636">§ 636. Murder in
 * the first degree; class A felony.</div><p>...body...</p>11 Del. C. 1953,
 * § 636; <a ...>58 Del. Laws, c. 497, § 1</a>; ...</div>`. The statutory
 * TEXT is every `<p>` between one `SectionHead` and the next; the AMENDMENT
 * HISTORY is the plain-text + `<a>` citation chain that follows the last
 * `</p>`, before the `</div><br>` that closes the `Section` wrapper (the
 * wrapper's own close is the one reliable boundary — verified across both a
 * normal section and the page's last section, where the closing tags
 * differ: `</div><br><div class="Section">` [next section follows] vs
 * `</div><br></div>` [page ends] both start with the same `</div><br>`
 * prefix). Reserved placeholder sections (e.g. "637-640. [Reserved.]") have
 * no `<p>` at all and correctly produce empty text and history.
 *
 * FOUR CAPABILITIES -- three available, one is not:
 *   - section by citation              -> de_statute
 *   - topic/keyword search             -> de_search (REAL full-text, not
 *     caption-only -- see above)
 *   - amendments/history               -> AVAILABLE, as part of de_statute's
 *     response (`history`): the session-law citation chain Delaware prints
 *     at the end of every section, in force or not.
 *   - historical version (a section's text as it read before an amendment)
 *     -> NOT AVAILABLE. delcode.delaware.gov publishes only the current
 *     online edition; there is no per-year archive the way Iowa or Indiana
 *     publish one, and no "effective until"/"effective as of" API for
 *     superseded text (only the two edge cases the search API itself
 *     surfaces inline, e.g. "[Effective until Oct. 21, 2026]" labels on a
 *     section with a scheduled future amendment -- that is the CURRENT
 *     page's own forward-looking label, not a historical archive).
 *
 * Keyless, no signup.
 */
import type { DeChapterRow, DeSectionRow } from './de-index-data.js';

// fleet #2754 (LIVE INCIDENT 2026-10-07): this index used to be a STATIC
// import, so every gateway isolate evaluated it at startup whether or not it
// ever served a delaware-code call — ~48MB of retained heap for the six baked state
// codes together, ~13.4MB of the bundle, and about one gateway call in four
// died as Cloudflare 1102 on cold isolates. The data module is now uploaded
// to KV at deploy (workers/gateway/src/pack-baked-indexes.json registers it;
// scripts/sync-gateway-static-json.mjs uploads it) and the gateway injects
// the parsed object as `args._bakedIndex` on every call into this pack.
// It is adopted once and kept for the isolate's life.
//
// NEVER value-import ./de-index-data.js here again — a type-only import is
// erased, a value import puts the whole table back into every isolate. The
// deploy workflow's bundle-size ceiling fails the deploy if that happens.
let DE_CHAPTERS: DeChapterRow[] = [];
let DE_SECTIONS: DeSectionRow[] = [];
let DE_INDEX_CAPTURED_AT = '';
function ensureIndex(args: Record<string, unknown>): void {
  if (DE_SECTIONS.length) return;
  const idx = args._bakedIndex as Record<string, unknown> | null | undefined;
  const chapters = idx?.DE_CHAPTERS;
  const sections = idx?.DE_SECTIONS;
  const capturedAt = idx?.DE_INDEX_CAPTURED_AT;
  if (!Array.isArray(chapters) || !Array.isArray(sections) || sections.length === 0 || typeof capturedAt !== 'string') {
    // Loud on purpose: answering from an empty table would read as "no such
    // section" / "no match", a silent wrong answer.
    throw new Error(
      `delaware-code: the baked section index is unavailable (${idx == null ? 'not injected' : 'malformed'}). ` +
        'The gateway loads it from KV on the first call into this pack; this is a server-side fault, not a bad citation or query — retry shortly.',
    );
  }
  DE_CHAPTERS = chapters as DeChapterRow[];
  DE_SECTIONS = sections as DeSectionRow[];
  DE_INDEX_CAPTURED_AT = capturedAt;
}

const UA = 'pipeworx-mcp-delaware-code/1.0 (+https://pipeworx.io)';
const UPSTREAM = 'Delaware General Assembly / Delaware Code Online (delcode.delaware.gov, legis.delaware.gov)';
const BASE = 'https://delcode.delaware.gov/';
const SEARCH_URL = 'https://legis.delaware.gov/json/DelCodeSearch/GetDelCodeSearchResults';

async function pwFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, UPSTREAM);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&#xA;/g, ' ');
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Parse a user-supplied citation into { title, section }. Accepts "11-636",
 * "11-607A", "11 Del. C. 636", "11 Del. C. § 636", "Title 11 § 636".
 */
const SECTION_RE = '[0-9]+[A-Za-z]?(?:-[0-9]+[A-Za-z]?)?';
function parseCitation(raw: string): { title: string; section: string } | null {
  const s = raw.trim();
  // "11-636", "11-607A"
  let m = s.match(new RegExp(`^(\\d+)\\s*[-\\s]\\s*§?\\s*(${SECTION_RE})$`));
  if (m) return { title: m[1]!, section: m[2]! };
  // "11 Del. C. 636", "11 Del.C. § 636", "11 Del. Code 636"
  m = s.match(new RegExp(`(\\d+)\\s*Del\\.?\\s*C(?:ode|\\.)?\\s*,?\\s*§*\\s*(${SECTION_RE})`, 'i'));
  if (m) return { title: m[1]!, section: m[2]! };
  // "Title 11 § 636", "Title 11, Section 636"
  m = s.match(new RegExp(`Title\\s*(\\d+)\\s*,?\\s*(?:§+|[Ss]ection)\\s*(${SECTION_RE})`, 'i'));
  if (m) return { title: m[1]!, section: m[2]! };
  return null;
}

/** Expand a section's raw id (e.g. "608-610", "623, 624", "607A") into the
 *  individual lookup keys a caller might type for it. */
function expandSectionKeys(id: string): string[] {
  const keys: string[] = [];
  for (const piece of id.split(',')) {
    const p = piece.trim();
    const range = p.match(/^(\d+)-(\d+)$/);
    if (range) {
      const lo = parseInt(range[1]!, 10);
      const hi = parseInt(range[2]!, 10);
      if (hi - lo <= 500) {
        for (let n = lo; n <= hi; n++) keys.push(String(n));
      } else {
        keys.push(p);
      }
    } else if (p) {
      keys.push(p);
    }
  }
  return keys;
}

/** title -> (section key -> index into DE_SECTIONS), built once per cold start. */
let titleIndex: Map<string, Map<string, number>> | null = null;
function sectionIndex(): Map<string, Map<string, number>> {
  if (titleIndex) return titleIndex;
  const idx = new Map<string, Map<string, number>>();
  DE_SECTIONS.forEach((row, i) => {
    const [id, , chapterIdx] = row;
    const chapter = DE_CHAPTERS[chapterIdx]!;
    let m = idx.get(chapter.title);
    if (!m) {
      m = new Map();
      idx.set(chapter.title, m);
    }
    for (const key of expandSectionKeys(id)) {
      if (!m.has(key)) m.set(key, i);
    }
  });
  titleIndex = idx;
  return idx;
}

/**
 * Cut one section's text and history out of a whole content-page
 * extraction. The `Section` wrapper always closes with `</div><br>`
 * (followed either by the next section's opening div, or by the page's own
 * closing tags when this is the last section) -- see file header.
 */
function sliceDeSection(html: string, headEnd: number, nextHeadStart: number): { text: string; history: string } {
  let chunk = html.slice(headEnd, nextHeadStart);
  const cut = chunk.search(/<\/div>\s*<br>/);
  if (cut !== -1) chunk = chunk.slice(0, cut);
  const lastP = chunk.lastIndexOf('</p>');
  if (lastP === -1) {
    return { text: '', history: stripTags(chunk) };
  }
  return { text: stripTags(chunk.slice(0, lastP + 4)), history: stripTags(chunk.slice(lastP + 4)) };
}

function findSectionHeads(html: string): Array<{ id: string; headText: string; idx: number; end: number }> {
  const headRe = /<div class="SectionHead" id="([^"]+)">([\s\S]*?)<\/div>/g;
  const out: Array<{ id: string; headText: string; idx: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = headRe.exec(html))) {
    out.push({ id: decodeEntities(m[1]!), headText: stripTags(m[2]!), idx: m.index, end: headRe.lastIndex });
  }
  return out;
}

const REPEALED_RE = /^\[?(Repealed|Reserved|Redesignated|Transferred)\b/i;

async function deStatute(args: Record<string, unknown>) {
  const raw = String(args.citation ?? '').trim();
  if (!raw) {
    return {
      found: false,
      reason: 'empty_citation',
      message: 'de_statute needs a citation, e.g. "11-636" (murder in the first degree) or "6-2734" (automatic-renewal contracts).',
    };
  }
  const parsed = parseCitation(raw);
  if (!parsed) {
    return {
      found: false,
      reason: 'unparseable_citation',
      citation: raw,
      message: `Could not parse "${raw}" as a Delaware Code citation. Expected forms: "11-636", "11 Del. C. § 636", "Title 11 § 636".`,
    };
  }
  const idx = sectionIndex();
  const titleMap = idx.get(parsed.title);
  const sectionIdx = titleMap?.get(parsed.section);

  if (sectionIdx === undefined) {
    const near = titleMap
      ? [...titleMap.keys()]
          .filter((k) => k.startsWith(parsed.section.slice(0, Math.max(1, parsed.section.length - 1))))
          .slice(0, 5)
          .map((k) => {
            const row = DE_SECTIONS[titleMap.get(k)!]!;
            return { citation: `${parsed.title}-${k}`, catchline: row[1] };
          })
      : [];
    return {
      found: false,
      reason: titleMap ? 'citation_not_found' : 'title_not_found',
      citation: raw,
      message: titleMap
        ? `No section "${parsed.section}" found in Title ${parsed.title} of the Delaware Code.`
        : `Title ${parsed.title} is not a Delaware Code title (titles run 1-31).`,
      near,
      hint: near.length ? 'Nearby matches are listed in "near".' : 'Call de_search with a topic instead if you do not have an exact citation.',
      source: `${UPSTREAM}, keyless`,
    };
  }

  const [sectionId, catchline, chapterIdx] = DE_SECTIONS[sectionIdx]!;
  const chapter: DeChapterRow = DE_CHAPTERS[chapterIdx]!;
  const pageUrl = BASE + chapter.url;

  const res = await pwFetch(pageUrl);
  if (!res.ok) throw await httpError(res, 'Delaware Code content page');
  const html = await res.text();
  if (!html.includes('class="SectionHead"')) {
    throw new Error(
      `Delaware Code content page (${pageUrl}) returned HTTP ${res.status} but carries no section markup -- ` +
      `delcode.delaware.gov's page shape may have changed since the baked index was built (${DE_INDEX_CAPTURED_AT}).`,
    );
  }

  const heads = findSectionHeads(html);
  const headPos = heads.findIndex((h) => h.id === sectionId);
  if (headPos === -1) {
    return {
      found: false,
      reason: 'section_not_found_on_page',
      citation: `${parsed.title} Del. C. § ${sectionId}`,
      chapter: chapter.chapter,
      message: `"${sectionId}" is listed in the Delaware Code's own index under Title ${chapter.title}, Chapter ${chapter.chapter}, but its heading could not be located on that page now.`,
      hint: 'The page may have changed since the baked index was last refreshed (see scripts/bake-index.mjs).',
      page_url: pageUrl,
      source: `${UPSTREAM}, keyless`,
    };
  }

  const nextStart = headPos + 1 < heads.length ? heads[headPos + 1]!.idx : html.length;
  const { text, history } = sliceDeSection(html, heads[headPos]!.end, nextStart);
  const isPlaceholder = REPEALED_RE.test(catchline.replace(/^\[|\]$/g, ''));

  return {
    found: true,
    citation: `${chapter.title} Del. C. § ${sectionId}`,
    catchline,
    title: chapter.title,
    title_name: chapter.titleName,
    chapter: chapter.chapter,
    chapter_name: chapter.chapterName,
    subchapter: chapter.subchapter,
    subchapter_name: chapter.subchapterName,
    text: text || null,
    text_chars: text.length,
    disposition: isPlaceholder ? 'reserved_repealed_or_transferred' : 'in_force',
    history: history || null,
    historical_versions: 'not available -- delcode.delaware.gov publishes only the current online edition; there is no per-year archive of superseded text.',
    page_url: pageUrl,
    index_captured_at: DE_INDEX_CAPTURED_AT,
    data_as_of: new Date().toISOString(),
    source: `${UPSTREAM}, keyless`,
    attribution: 'Delaware statutes are public record.',
  };
}

interface SearchHitRaw {
  TitleNumber: number;
  TitleDescription: string;
  ChapterNumber: number;
  ChapterDescription: string;
  SubchapterNumber: number;
  SubchapterDescription: string;
  SectionNumber: number;
  SectionDisplay: string;
  SectionDescription: string;
  SectionLink: string;
}

async function deSearch(args: Record<string, unknown>) {
  const q = String(args.query ?? '').trim();
  if (!q) {
    return {
      found: false,
      reason: 'empty_query',
      message: 'de_search needs a "query" -- a topic or a few keywords, e.g. "landlord security deposit" or "automatic renewal contract".',
      hint: 'To look up a known citation directly, use de_statute instead.',
    };
  }
  const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));

  const body = new URLSearchParams({ page: '1', pageSize: String(limit), skip: '0', take: String(limit), sort: '', filter: '' });
  const res = await pwFetch(`${SEARCH_URL}?searchTerm=${encodeURIComponent(q)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `https://legis.delaware.gov/Delcode/Search?query=${encodeURIComponent(q)}`,
    },
    body: body.toString(),
  });
  if (!res.ok) throw await httpError(res, 'Delaware Code search API');
  let json: { Data?: SearchHitRaw[]; Total?: number; Errors?: unknown };
  try {
    json = (await res.json()) as typeof json;
  } catch (err) {
    throw new Error(
      `Delaware Code search API returned HTTP ${res.status} but the body was not valid JSON ` +
      `(${(err as Error).message}) -- legis.delaware.gov may be serving a challenge or error page instead of search results.`,
    );
  }
  if (json.Errors) {
    throw new Error(`Delaware Code search API returned an error payload: ${JSON.stringify(json.Errors).slice(0, 300)}`);
  }
  const hits = json.Data ?? [];

  if (!hits.length) {
    return {
      found: false,
      query: q,
      message: `No Delaware Code section matched "${q}".`,
      hint: 'This is a real full-text search over statutory text, not just section titles -- try shorter or more literal terms.',
      total_matched: json.Total ?? 0,
      source: 'Delaware General Assembly full-text search (legis.delaware.gov), keyless',
    };
  }

  const results = hits.map((h) => ({
    citation: `${h.TitleNumber} Del. C. § ${h.SectionDisplay.replace(/^Section\s*/i, '')}`,
    title: String(h.TitleNumber),
    title_name: h.TitleDescription.trim(),
    chapter: String(h.ChapterNumber),
    chapter_name: h.ChapterDescription,
    subchapter: h.SubchapterNumber === 9999 ? null : String(h.SubchapterNumber),
    subchapter_name: h.SubchapterDescription || null,
    section: h.SectionDisplay.replace(/^Section\s*/i, ''),
    catchline: h.SectionDescription,
    page_url: BASE + h.SectionLink.split('#')[0],
  }));

  return {
    found: true,
    query: q,
    count: results.length,
    total_matched: json.Total ?? results.length,
    results,
    hint: 'Call de_statute with a citation above for the full text and amendment history.',
    match_level: 'full_text',
    source: 'Delaware General Assembly full-text search (legis.delaware.gov), keyless',
    data_as_of: new Date().toISOString(),
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'de_statute',
    description:
      'Get the FULL TEXT of a section of the Delaware Code -- Delaware state law -- by citation. "11-636" is murder in the first degree; "6-2734" is contracts with automatic renewal provisions. Accepts natural forms: "11-636", "11 Del. C. § 636", "Title 11 § 636". Returns the current statutory text, the official catchline, chapter/subchapter/title context, and the AMENDMENT HISTORY (the session-law citation chain Delaware prints at the end of every section). Delaware publishes the CURRENT text only -- no per-year historical archive; this tool says so rather than guessing. Keyless. Use for "what does 11 Del. C. 636 say" or to check a Delaware statute a case or lease relies on.',
    inputSchema: {
      type: 'object',
      properties: {
        citation: {
          type: 'string',
          description: 'Section citation, title-section, e.g. "11-636" (murder in the first degree) or "6-2734" (automatic-renewal contracts). Some sections carry a letter suffix, e.g. "11-607A".',
        },
      },
      required: ['citation'],
    },
  },
  {
    name: 'de_search',
    description:
      'Search the FULL TEXT of the Delaware Code by topic or keyword -- "landlord security deposit", "automatic renewal contract", "homicide". Calls the Delaware General Assembly\'s own live full-text search (it searches statutory TEXT, not just section titles -- a search for "landlord" matches sections whose title never says "landlord"). Returns matching citations, catchlines, and chapter/title context; call de_statute with a citation for the full text and amendment history. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Topic or keywords, e.g. "landlord security deposit".' },
        limit: { type: 'number', description: 'Max results to return, default 10, max 25.' },
      },
      required: ['query'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'de_statute':
      // Only de_statute reads the baked index; de_search is a live full-text
      // query and must keep working even if the index failed to load.
      ensureIndex(args);
      return deStatute(args);
    case 'de_search':
      return deSearch(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
