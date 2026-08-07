/**
 * Endpoint verification suite for the Express.js tutorial server.
 *
 * Both endpoint contracts are verified over real HTTP against the server as it
 * is deployed: the suite spawns `server.js` as a child process and drives it
 * with `fetch`, so nothing about the application is adapted for the tests. It
 * uses Node built-ins only, which keeps express the sole entry in
 * `npm ls --depth=0` and `package.json` free of a devDependencies block.
 *
 * The server binds a FIXED port, so "something answered on port 3000" is not the
 * same claim as "the code under test answered". Three layers close that gap: the
 * port is proven free BEFORE the child is spawned, readiness is read from that
 * child's own stdout by matching the exact startup line rather than sleeping,
 * and every request afterwards is bracketed by a liveness check and raced
 * against the child's death. Teardown is bounded at every step for the
 * mirror-image reason: a suite that cannot stop its own server leaves the port
 * occupied for whatever runs next.
 *
 * One published contract cannot be proven by a request at all. The server must
 * bind the loopback address and nothing else, and a request to 127.0.0.1
 * succeeds identically whether the socket is bound to 127.0.0.1, to 0.0.0.0 or
 * to `::`. That contract is settled instead by dialling the addresses OUTSIDE
 * the intended binding and requiring every one of them to refuse.
 *
 * @requires node:test - Node's built-in test runner
 * @requires node:assert/strict - strict assertions, so any drift fails loudly
 * @requires node:child_process - to spawn the real server process
 * @requires node:path - to resolve server.js independently of the cwd
 * @requires node:net - to ask at the TCP layer which addresses accept a connection
 * @requires node:os - to enumerate this host's addresses outside the binding
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');

/**
 * Base URL for every request. The server hardcodes host 127.0.0.1 and port
 * 3000 as literal constants and reads no environment variables, so the suite
 * must target that exact address rather than making it configurable.
 */
const baseUrl = 'http://127.0.0.1:3000';

/**
 * The host and port `baseUrl` already names, parsed out of it once, because the
 * loopback-binding check works at the TCP layer and needs the port as a number.
 * Parsing keeps one source of truth: a second literal 3000 could drift away from
 * the URL every request in this suite uses.
 */
const serverOrigin = new URL(baseUrl);
const loopbackHost = serverOrigin.hostname;
const serverPort = Number(serverOrigin.port);

/**
 * Repository root, one level above this file. It anchors both the entrypoint
 * resolved below and the redaction in `redactPaths`, which strips this prefix
 * out of anything quoted in a failure message.
 */
const repoRoot = path.join(__dirname, '..');

/**
 * Absolute path to the server entrypoint, resolved from this file's own
 * directory. It must NOT be derived from `process.cwd()`: the npm script runs
 * the runner from the repository root, so the cwd is one level above this file.
 * Resolving from `__dirname` is correct no matter where the runner is invoked.
 */
const serverPath = path.join(repoRoot, 'server.js');

/**
 * How the entrypoint is NAMED in diagnostics - relative to the repository root,
 * never as the absolute path used to spawn it.
 *
 * Failure messages from this suite land in CI output and shared logs, and the
 * absolute path describes the filesystem layout of whoever happened to run the
 * suite without helping anybody fix the failure: `server.js` is exactly as
 * actionable as a full path through somebody's home directory, and discloses
 * nothing.
 */
const serverLabel = path.relative(repoRoot, serverPath);

/**
 * The exact line the server logs once its listening socket is bound. Waiting
 * for this string is the readiness signal - see `before` below - which is far
 * more reliable than sleeping for a fixed delay, and it simultaneously proves
 * the documented startup-log requirement. The server builds this line by
 * interpolating its host and port constants, and it renders character for
 * character as written here.
 */
const readyLog = 'Server running at http://127.0.0.1:3000/';

/**
 * Upper bound on how long the server may take to report readiness. Exceeding
 * it is a hard failure rather than a hang: the tutorial server binds a
 * hardcoded port, so a stale process already holding port 3000 is a real
 * failure mode that must surface with a readable message.
 */
const startupTimeoutMs = 10000;

/**
 * Upper bound on a single HTTP request. Guards against a request hanging
 * forever if the child is alive but wedged, so a stuck run fails instead of
 * blocking the whole test process.
 */
const requestTimeoutMs = 5000;

/**
 * Upper bound on the pre-spawn port probe - see `requirePortIsFree`. It is
 * deliberately short because on loopback a free port refuses the connection
 * immediately: ECONNREFUSED proves the port is free; a response, timeout, or
 * different transport error is treated conservatively as unavailable.
 */
const preflightTimeoutMs = 2000;

/**
 * Upper bound on a single loopback-binding probe - see `probePortAt`. A local
 * address settles a connection attempt almost immediately, either by accepting
 * it or by refusing it, so this is a deadlock guard rather than a tuning knob:
 * an address that does neither within the window is reported as inconclusive
 * instead of being silently counted as a refusal.
 */
const bindingProbeTimeoutMs = 2000;

/**
 * How long to let the child's stdout and stderr finish arriving after the child
 * itself has gone. Node emits `exit` when the process ends but `close` only
 * once its stdio streams are done, and the two are not simultaneous: reading
 * the buffered stderr at `exit` can truncate the very message that explains the
 * failure. Waiting for `close` under this bound gives complete diagnostics
 * without ever waiting indefinitely for a stream that will not close.
 */
const stdioDrainTimeoutMs = 1000;

/**
 * Upper bound on how much of the child's output a single failure message may
 * quote. A healthy child prints one readiness line, but a crashing runtime can
 * print a great deal, and a message that reproduces all of it buries the
 * actionable part and copies the whole lot into whatever log collects it. The
 * TAIL is what is kept: the end of the output is where the cause is.
 */
const maxQuotedOutputChars = 600;

/**
 * How long the child is given to honour SIGTERM before teardown escalates to
 * SIGKILL, and how long SIGKILL itself is given afterwards. Both are bounded so
 * that a child which cannot be signalled fails the run with a diagnostic
 * instead of leaving the `after` hook pending - and therefore `npm test`
 * hanging - forever.
 */
const gracefulStopTimeoutMs = 2000;
const forcedStopTimeoutMs = 3000;

/**
 * Explicit hook deadlines. Node's test runner leaves hook timeouts unbounded by
 * default, so a hook that never settles would hang the whole run rather than
 * report. Each value sits comfortably above the sum of the deadlines its hook
 * can legitimately wait on - startup: probe + readiness + one ownership
 * request; teardown: SIGTERM grace + SIGKILL grace + stdio drain - so it only
 * ever fires when something has genuinely gone wrong inside the hook itself.
 */
const startupHookTimeoutMs = 30000;
const teardownHookTimeoutMs = 15000;

/**
 * Content type both endpoints are contractually required to produce. The
 * server calls `res.type('text/plain')`, and Express appends the charset, so
 * the observed header is the full value below - asserting against a bare
 * `text/plain` would fail against correct behaviour.
 */
const expectedContentType = 'text/plain; charset=utf-8';

/**
 * Handle to the spawned server. `let` is unavoidable here: the handle does not
 * exist until the `before` hook runs, and both the tests and the `after` hook
 * need to reach it.
 */
let serverProcess = null;

let serverStdout = '';
let serverStderr = '';

/**
 * The child's exit, recorded as `{ code, signal }` the moment it happens and
 * kept for the rest of the run.
 *
 * This record is the heart of the lifecycle. The child's `exit` event fires
 * exactly once, and it may fire at any point: before readiness (a bind failure),
 * in the middle of the tests (a crash), or during teardown (the expected case).
 * Keeping the outcome in state rather than only reacting to it in the moment is
 * what lets every later phase - each request, and the teardown hook - ask "is
 * the child still there?" and get a truthful answer instead of a stale one.
 */
let childExit = null;

let childStdioClosed = false;

/**
 * The first `error` event the child ever emitted. Node emits it when a process
 * could not be spawned AND when a signal could not be delivered to it, so this
 * one field covers both a failed launch and a failed kill.
 */
let childError = null;

/**
 * An `error` that arrived while teardown was in progress, i.e. a kill that could
 * not be delivered. It is tracked separately from `childError` because it must
 * fail the `after` hook loudly: a shutdown error that goes unreported is exactly
 * how an orphaned process ends up holding port 3000 for the next run.
 */
let teardownError = null;

/**
 * True from the moment the `after` hook asks the child to stop. It is what tells
 * an EXPECTED exit (teardown) apart from an UNEXPECTED one (crash mid-suite);
 * without the distinction, either every run would fail at teardown or no run
 * would ever notice a mid-suite death.
 */
let teardownRequested = false;

let startupSettled = false;

/**
 * Resolve-only promises the phases hand to each other:
 *   exitObserved - resolves when the child exits (teardown waits on this)
 *   stdioClosed  - resolves when the child's output is final (diagnostics wait)
 *   childFailure - resolves ONLY on an unexpected death, never on teardown
 * They are assigned by `resetChildState` below.
 */
let exitObserved = null;
let stdioClosed = null;
let childFailure = null;

/**
 * References to the listeners this suite attached to the child and its pipes,
 * published by `awaitStartupLog` so that teardown can detach exactly those and
 * nothing else. Removing listeners by reference rather than wholesale keeps the
 * cleanup honest: it cannot accidentally strip a listener the runtime installed
 * for its own bookkeeping.
 */
let installedListeners = null;

/**
 * A promise plus its resolver.
 *
 * These deferreds deliberately never REJECT, only resolve with a description of
 * what happened. A rejected promise that nobody happens to await becomes an
 * unhandled rejection and can take the whole runner down with it, and
 * `childFailure` is awaited only when a request happens to be in flight. Every
 * caller therefore inspects the resolved value and decides for itself whether
 * that value is a failure.
 */
const createDeferred = () => {
  let resolve = null;
  const promise = new Promise((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
};

/**
 * Wait for a deferred, but never longer than `timeoutMs`.
 *
 * Returns true if it settled in time and false if the deadline won, so callers
 * can branch on the outcome instead of racing promises by hand. The timer is
 * always cleared on the settled path, and on the timeout path it has already
 * fired, so nothing is left holding the event loop open either way.
 *
 * @param {Promise<unknown>} promise - the deferred promise to wait on
 * @param {number} timeoutMs - upper bound in milliseconds
 * @returns {Promise<boolean>} true if the promise settled before the deadline
 */
const settledWithin = (promise, timeoutMs) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), timeoutMs);

  promise.then(() => {
    clearTimeout(timer);
    resolve(true);
  });
});

/**
 * Initialize child-process state and deferreds immediately before the suite's
 * server spawn.
 */
const resetChildState = () => {
  serverStdout = '';
  serverStderr = '';
  childExit = null;
  childStdioClosed = false;
  childError = null;
  teardownError = null;
  teardownRequested = false;
  startupSettled = false;
  installedListeners = null;
  exitObserved = createDeferred();
  stdioClosed = createDeferred();
  childFailure = createDeferred();
};

/**
 * Detach every listener this suite attached, and release any pipe still open.
 *
 * Run at the very end of teardown, when nothing is left to observe. Until that
 * point the listeners must stay attached: a `ChildProcess` with no `error`
 * listener turns the next error into an uncaught exception.
 *
 * The three releases matter for three different reasons. Detaching the listeners
 * stops this suite reacting to a process it no longer owns. Destroying a pipe
 * that never closed frees the handle that pipe holds. And `unref` is the one that
 * guarantees a RESULT: a live child handle keeps its parent's event loop alive,
 * so a child that refused both signals would otherwise stop the runner from ever
 * exiting, replacing the loud teardown failure raised just above with a silent
 * hang.
 *
 * Those three releases must therefore happen on EVERY path that got as far as a
 * child handle - including the one where the spawn came back without usable
 * pipes and startup failed immediately. That is why the child-level handlers are
 * published as soon as they are attached rather than at the end of a successful
 * setup: this function is reached with whatever was installed at the time, and
 * it detaches exactly that.
 */
const releaseChildResources = () => {
  if (serverProcess === null || installedListeners === null) {
    return;
  }

  serverProcess.removeListener('error', installedListeners.error);
  serverProcess.removeListener('exit', installedListeners.exit);
  serverProcess.removeListener('close', installedListeners.close);
  serverProcess.unref();

  // A pipe is destroyed on the evidence that it exists, but a listener is
  // detached only on the evidence that it was attached: the stdio handlers are
  // published as they are installed, and a child that came back without usable
  // pipes never gets that far. Handing `undefined` to `removeListener` would
  // throw and abandon the rest of this cleanup.
  if (serverProcess.stdout !== null && serverProcess.stdout !== undefined) {
    if (installedListeners.stdoutData !== undefined) {
      serverProcess.stdout.removeListener('data', installedListeners.stdoutData);
      serverProcess.stdout.removeListener('data', installedListeners.stdoutReady);
    }

    if (!childStdioClosed) {
      serverProcess.stdout.destroy();
    }
  }

  if (serverProcess.stderr !== null && serverProcess.stderr !== undefined) {
    if (installedListeners.stderrData !== undefined) {
      serverProcess.stderr.removeListener('data', installedListeners.stderrData);
    }

    if (!childStdioClosed) {
      serverProcess.stderr.destroy();
    }
  }

  installedListeners = null;
};

/**
 * Absolute prefixes worth naming rather than flattening to a placeholder, sorted
 * longest first so a nested prefix cannot be shadowed by a shorter one that also
 * matches.
 *
 * Two are worth naming and no more. `repoRoot` covers every path inside this
 * checkout, so a file in the project keeps its project-relative name. The
 * interpreter's own path covers the executable this suite spawns, which is
 * exactly what a failed spawn or an undeliverable signal names. Every other
 * absolute path is somebody's machine and is flattened by the sweep below.
 */
const redactedPrefixes = [
  { prefix: repoRoot, label: '<repo>' },
  { prefix: process.execPath, label: '<node>' }
].sort((left, right) => right.prefix.length - left.prefix.length);

/**
 * Any remaining absolute filesystem path, i.e. one that survived the prefix pass
 * above and therefore names something outside both the checkout and the runtime.
 *
 * Two guards keep it from eating things that only look like paths. It requires
 * at least two segments, so a route such as `/evening` is untouched. And the
 * leading slash must not follow a word character, a colon, another slash or a
 * `>`: that spares `http://127.0.0.1:3000/` and spares the relative remainder of
 * an already-labelled path such as `<repo>/server.js`.
 */
const absolutePathPattern = /(?<![\w:/>])\/(?:[\w.@+~-]+\/)+[\w.@+~-]+/g;

/** A stack frame line, as printed by V8: leading whitespace, then `at `. */
const stackFramePattern = /^\s*at\s/;

/**
 * Strip filesystem detail out of text that is about to be quoted in a failure
 * message: label the two prefixes that are worth recognising, then reduce every
 * other absolute path to a placeholder.
 *
 * The order matters. Labelling first keeps the useful part of a path inside the
 * project - `<repo>/server.js` says which file, without saying where the
 * checkout lives - whereas sweeping first would flatten it to a placeholder that
 * says nothing at all.
 *
 * @param {string} text - raw text from the child process or the runtime
 * @returns {string} the same text with filesystem locations redacted
 */
const redactPaths = (text) => redactedPrefixes
  .reduce((carried, { prefix, label }) => carried.split(prefix).join(label), text)
  .replace(absolutePathPattern, '<path>');

/**
 * Replace runs of stack frames with a count of what was dropped.
 *
 * A stack trace from the child is the noisiest and least useful thing that can
 * appear in a failure message: it names runtime internals and absolute file
 * locations, while the line that actually explains the failure is the error
 * message above it. Recording how many frames were omitted keeps the shape of
 * the failure visible - and tells the reader to run the child directly if the
 * frames are what they need.
 *
 * @param {string} text - text that may contain stack frames
 * @returns {string} the same text with each run of frames summarised
 */
const collapseStackFrames = (text) => {
  const kept = [];
  let framesSeen = 0;

  const summariseRun = () => {
    if (framesSeen > 0) {
      kept.push(`    <${framesSeen} stack frame${framesSeen === 1 ? '' : 's'} omitted>`);
      framesSeen = 0;
    }
  };

  text.split('\n').forEach((line) => {
    if (stackFramePattern.test(line)) {
      framesSeen += 1;
      return;
    }

    summariseRun();
    kept.push(line);
  });

  summariseRun();

  return kept.join('\n');
};

/**
 * Redact a single message the runtime handed us. Spawn and signal failures name
 * the executable they could not run or reach, so these messages carry absolute
 * paths just as often as the child's own output does.
 *
 * @param {string} message - an Error message from the runtime
 * @returns {string} the message with filesystem locations redacted
 */
const redactMessage = (message) => collapseStackFrames(redactPaths(message));

/**
 * Prepare the child's accumulated output for quoting: redact it, collapse its
 * stack frames, keep only the last `maxQuotedOutputChars` characters, and JSON
 * encode the result so newlines stay on one line of the report.
 *
 * @param {string} output - everything the child has written to one stream
 * @returns {string} a bounded, redacted, JSON-encoded rendering
 */
const quoteChildOutput = (output) => {
  const redacted = redactMessage(output);
  const bounded = redacted.length <= maxQuotedOutputChars
    ? redacted
    : `[...${redacted.length - maxQuotedOutputChars} earlier characters omitted]` +
      `${redacted.slice(-maxQuotedOutputChars)}`;

  return JSON.stringify(bounded);
};

/**
 * Render what the child process has told us so far. Attached to every failure
 * message so a broken run explains itself instead of leaving the reader to
 * re-run the server by hand: a port clash, a missing express install or a syntax
 * error in the server file all show up here.
 *
 * It reports the minimum that identifies the failure and nothing that merely
 * describes the machine it happened on. The entrypoint is named relative to the
 * repository, the runtime is named by version rather than by the absolute path
 * of its executable, the child's process id is omitted because no reader can act
 * on it - an unstoppable child is reported by teardown in its own words - and
 * everything quoted from the child is redacted, stripped of stack frames and
 * capped.
 */
const describeChild = () => {
  const state = serverProcess === null
    ? 'never started'
    : serverProcess.pid === undefined
      ? 'spawn failed, so there is no process'
      : `spawned, exitCode=${serverProcess.exitCode} signalCode=${serverProcess.signalCode}`;

  const recordedExit = childExit === null
    ? 'still running (no exit observed)'
    : `code=${childExit.code} signal=${childExit.signal}`;

  return [
    `  server file : ${serverLabel}`,
    `  runtime     : ${process.version}`,
    `  child state : ${state}`,
    `  exit seen   : ${recordedExit}`,
    `  stdio closed: ${childStdioClosed}`,
    `  stopping    : ${teardownRequested}`,
    `  child error : ${childError === null ? 'none' : redactMessage(childError.message)}`,
    `  stdout seen : ${quoteChildOutput(serverStdout)}`,
    `  stderr seen : ${quoteChildOutput(serverStderr)}`
  ].join('\n');
};

/**
 * Build a failure that this harness raised deliberately, as opposed to one that
 * bubbled up from `fetch` or the runtime.
 *
 * The marker matters for exactly one reason: `get` wraps unexpected errors in
 * extra context, and wrapping a message that already carries the full child
 * diagnostic would bury the useful part under a second layer. Tagging the
 * deliberate ones lets them through unchanged.
 *
 * @param {string} message - the fully-formed, self-explaining failure message
 * @returns {Error} an error carrying the `isHarnessFailure` marker
 */
const createHarnessError = (message) => {
  const error = new Error(message);
  error.isHarnessFailure = true;

  return error;
};

/**
 * Put a resolved `childFailure` description into words for a failure message.
 *
 * @param {{kind:'error', error:Error}|{kind:'exit', code:number|null, signal:string|null}} failure
 * @returns {string} a short human-readable cause
 */
const describeFailure = (failure) => (
  failure.kind === 'error'
    ? `the runtime reported "${redactMessage(failure.error.message)}"`
    : `it exited with code ${failure.code} and signal ${failure.signal}`
);

/**
 * True once the operating system actually gave us a process. Node leaves `pid`
 * undefined when a spawn fails, and in that case there is nothing alive to
 * signal, wait for or tear down.
 */
const childWasSpawned = () => serverProcess !== null && serverProcess.pid !== undefined;

/**
 * True when no live spawned child remains: it was never started or it has
 * exited.
 *
 * It consults the recorded exit as well as the handle's own fields, because the
 * two answer slightly different questions: the handle reflects what Node has
 * updated on the object, the record reflects what this suite actually observed.
 * Used to tell "our server is serving" apart from "something else is serving" -
 * see `confirmServerIsOurs` - and to keep teardown from signalling a corpse.
 */
const childHasExited = () =>
  serverProcess === null ||
  childExit !== null ||
  serverProcess.exitCode !== null ||
  serverProcess.signalCode !== null;

/**
 * Fail immediately unless the child this suite started is still running.
 *
 * Every request is bracketed by this check, and the reason is subtle but
 * important: the server binds a FIXED port, so "something answered on port
 * 3000" is not the same claim as "the code under test answered". If our child
 * has died, anything still answering belongs to somebody else, and a suite that
 * kept asserting against it would report green while exercising nothing. The
 * `context` argument names the moment the check failed so the message points at
 * the right half of the exchange.
 *
 * @param {string} context - e.g. 'before requesting /' or 'after requesting /'
 */
const assertChildIsRunning = (context) => {
  if (serverProcess === null) {
    throw createHarnessError(
      `The server was never started, so there is nothing to test (${context}).`
    );
  }

  if (childHasExited()) {
    throw createHarnessError(
      `The server process this suite started is no longer running (${context}), so ` +
      `anything answering ${baseUrl} is NOT the code under test. Treating that as a ` +
      'pass would be a false green, so the run fails here instead.\n' +
      `${describeChild()}`
    );
  }
};

/**
 * Issue a GET request against the running server and read it to completion.
 *
 * The whole exchange - response headers and body - is covered by a single
 * AbortController deadline, so a child that is alive but wedged fails the test
 * with a clear abort instead of blocking the runner indefinitely. The timer is
 * always cleared, success or failure, so nothing keeps the process alive.
 *
 * The real `Headers` object is handed back untouched so callers can use
 * `headers.get(...)`, including for headers that are expected to be absent.
 *
 * @param {string} route - path to request, e.g. '/' or '/evening'
 * @returns {Promise<{status: number, headers: Headers, body: string}>}
 */
const get = async (route) => {
  // The child must be alive BEFORE the request. If it is already gone, whatever
  // would answer is not the code under test, and no assertion made against it
  // would mean anything.
  assertChildIsRunning(`before requesting ${route}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

  const exchange = async () => {
    const response = await fetch(`${baseUrl}${route}`, { signal: controller.signal });
    const body = await response.text();
    return { status: response.status, headers: response.headers, body };
  };

  try {
    // Race the exchange against the child's death. Without this the suite could
    // sit through a full request against a foreign listener while its own child
    // was already dying, and only notice - if ever - much later.
    const outcome = await Promise.race([
      exchange().then((value) => ({ kind: 'response', value })),
      childFailure.promise.then((failure) => ({ kind: 'died', failure }))
    ]);

    if (outcome.kind === 'died') {
      // Nothing useful can come of the in-flight request now, so release it
      // rather than leave a socket pending behind a failing test.
      controller.abort();

      throw createHarnessError(
        `The server process died while GET ${route} was in flight ` +
        `(${describeFailure(outcome.failure)}).\n${describeChild()}`
      );
    }

    // Recheck the child after the response so the suite does not continue once
    // its owned server has exited, even if the HTTP exchange completed.
    assertChildIsRunning(`after requesting ${route}`);

    return outcome.value;
  } catch (error) {
    // Enrich in one place rather than in each test: a bare "operation was
    // aborted" says nothing, whereas the child's state and output usually
    // identify the cause immediately. Failures this harness raised itself
    // already carry that context, so they pass through unwrapped.
    if (error instanceof Error && error.isHarnessFailure === true) {
      throw error;
    }

    const reason = redactMessage(error instanceof Error ? error.message : String(error));

    throw createHarnessError(`GET ${route} failed: ${reason}\n${describeChild()}`);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Release a response body without reading a single byte of it.
 *
 * Cancelling the stream discards whatever has already arrived and refuses the
 * rest, so nothing is ever materialised in memory, and the connection is
 * released rather than left half-read. That distinction is the whole point of
 * this helper: `response.text()` would buffer the entire body, and the only
 * response this is used on comes from an UNKNOWN process on the fixed port. A
 * request deadline bounds how LONG such a process may stream, never how MUCH, so
 * a local listener answering with an endless body could exhaust the test runner
 * before the deadline ever fired.
 *
 * It resolves to false rather than rejecting when the stream cannot be
 * cancelled: by that point the caller's verdict is already settled, and a body
 * that refuses to close must not turn a definite answer into an exception.
 *
 * @param {Response} response - a settled fetch response
 * @returns {Promise<boolean>} true once the body has been released
 */
const releaseResponseBody = (response) => {
  const body = response.body;

  if (body === null || body === undefined) {
    return Promise.resolve(true);
  }

  return body.cancel().then(() => true, () => false);
};

/**
 * Observe what, if anything, is already listening on the fixed port.
 *
 * On loopback a free port refuses the connection outright, and Node surfaces
 * that as a `fetch` rejection whose cause code is ECONNREFUSED. That single
 * signal is the only outcome treated as "free": a real response obviously means
 * somebody is serving, and every other outcome - a connection that is accepted
 * but never answered, or any other network error - means the port cannot be
 * claimed cleanly either. Reporting what was actually seen, rather than a bare
 * boolean, is what lets the caller write a message an operator can act on.
 *
 * The status line alone settles that question, so the body is discarded unread -
 * see `releaseResponseBody` for why this probe must never buffer it.
 *
 * @returns {Promise<{free: boolean, detail: string}>}
 */
const probeFixedPort = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), preflightTimeoutMs);

  try {
    const response = await fetch(`${baseUrl}/`, { signal: controller.signal });

    // Something answered, so the verdict is already decided by the status. Take
    // it first, then throw the body away without reading it.
    const status = response.status;
    const released = await releaseResponseBody(response);

    return {
      free: false,
      detail: released
        ? `it answered with HTTP ${status}`
        : `it answered with HTTP ${status}, and its response body could not be released cleanly`
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        free: false,
        detail: `a connection was accepted but nothing answered within ${preflightTimeoutMs} ms`
      };
    }

    // `fetch` reports transport failures as a generic error and puts the real
    // errno on `cause`, so the refusal has to be read from there.
    const cause = error instanceof Error ? error.cause : null;
    const code = cause === null || cause === undefined ? null : cause.code;

    if (code === 'ECONNREFUSED') {
      return { free: true, detail: 'the connection was refused, so nothing is listening' };
    }

    // Redacted like every other runtime message this suite quotes: `detail` is
    // interpolated into the operator-visible refusal in `requirePortIsFree`, and
    // a transport error is free to name a filesystem path or a proxy URL.
    const reason = redactMessage(error instanceof Error ? error.message : String(error));

    return { free: false, detail: `probing it failed with ${reason} (cause ${code})` };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Refuse to start unless the fixed port is genuinely unoccupied.
 *
 * This is the first line of defence against the worst failure mode a
 * fixed-port suite has: a leftover server - from an interrupted run, or another
 * checkout of this same tutorial - answering every request correctly while the
 * child spawned here dies of EADDRINUSE. Every assertion would pass, and the
 * code under test would never have been executed.
 *
 * Checking BEFORE the spawn is what makes the guarantee deterministic. Once the
 * port is known to be free and this suite is the only thing that binds it
 * afterwards, whatever answers is necessarily the child - and the liveness
 * bracket in `get` keeps that true for the rest of the run.
 *
 * The port cannot simply be made configurable instead: `server.js` hardcodes
 * host and port as literal constants and reads no environment variables, which
 * is a deliberate property of this project rather than an oversight.
 */
const requirePortIsFree = async () => {
  const { free, detail } = await probeFixedPort();

  if (!free) {
    throw createHarnessError(
      `Refusing to start: ${baseUrl} is already in use - ${detail}. The server ` +
      'under test hardcodes this port, so a foreign listener would answer every ' +
      'request in this suite while the process started here failed to bind, and ' +
      'the run would report a green that proved nothing. Stop whatever holds the ' +
      'port and run the suite again.'
    );
  }
};

/**
 * Every local address that is NOT the loopback address the server binds.
 *
 * These addresses are what make a binding assertion possible at all. A request
 * to 127.0.0.1 is answered whether the listening socket is bound to 127.0.0.1,
 * to 0.0.0.0 or to `::`, so no amount of loopback traffic can distinguish a
 * correctly bound socket from one exposed on every interface. Only an address
 * outside the intended binding separates them: a loopback-bound socket refuses
 * it, a wildcard-bound socket answers on it.
 *
 * Non-internal IPv4 addresses are the primary targets - this host's own
 * addresses, which is exactly the negative check the project documents. IPv6 is
 * deliberately left out: the non-internal IPv6 addresses a host typically has
 * are link-local, which cannot be dialled without a zone index, so including
 * them would add failures that say nothing about the binding.
 *
 * A host with no non-loopback interface at all - an isolated network namespace,
 * for instance - would leave nothing to probe and make the check vacuous, so
 * `127.0.0.2` stands in for that case. The whole of 127.0.0.0/8 reaches the
 * loopback interface, so a wildcard-bound socket answers there too while a
 * socket bound to 127.0.0.1 alone does not.
 *
 * @returns {string[]} addresses to probe - never empty
 */
const addressesOutsideTheBinding = () => {
  const found = [];

  for (const entries of Object.values(os.networkInterfaces())) {
    if (entries === undefined) {
      continue;
    }

    for (const entry of entries) {
      if (entry.family === 'IPv4' && entry.internal === false) {
        found.push(entry.address);
      }
    }
  }

  return found.length > 0 ? found : ['127.0.0.2'];
};

/**
 * Ask, at the TCP layer, whether anything accepts a connection to the fixed port
 * at `address`.
 *
 * A connection attempt is the right instrument and an HTTP request is not: the
 * question is which addresses the listening socket occupies, and the handshake
 * alone settles it. Nothing is written, and the socket is destroyed the moment
 * the verdict is in, so an address that does turn out to be answering is never
 * sent a request.
 *
 * Only a completed handshake counts as accepted. Every other outcome - a
 * refusal, an unreachable address, an expired deadline - is reported with the
 * detail that produced it, so the assertion can say what was actually observed
 * rather than that something unspecified went wrong.
 *
 * @param {string} address - the local address to dial
 * @returns {Promise<{accepted: boolean, detail: string}>}
 */
const probePortAt = (address) => new Promise((resolve) => {
  const socket = net.createConnection({ host: address, port: serverPort });
  let settled = false;
  let timer = null;

  /**
   * The single settlement point, for the same reason the startup phase has one:
   * connect, error and the deadline can all fire, and only the first of them
   * decides. Destroying the socket here is what stops a probe holding a handle
   * open past its verdict.
   */
  const settle = (outcome) => {
    if (settled) {
      return;
    }

    settled = true;
    clearTimeout(timer);
    socket.destroy();
    resolve(outcome);
  };

  timer = setTimeout(() => settle({
    accepted: false,
    detail: `the connection neither completed nor failed within ${bindingProbeTimeoutMs} ms`
  }), bindingProbeTimeoutMs);

  socket.once('connect', () => settle({
    accepted: true,
    detail: 'the connection was accepted'
  }));

  // `code` is the actionable half of a transport error (ECONNREFUSED and the
  // like); the message is only worth quoting when there is no code, and then
  // only redacted, as everywhere else in this suite.
  socket.once('error', (error) => settle({
    accepted: false,
    detail: error.code === undefined
      ? `the connection failed: ${redactMessage(error.message)}`
      : `the connection failed with ${error.code}`
  }));
});

/**
 * Prove that the process answering port 3000 is the child this suite started.
 *
 * Express's `app.listen` wraps the callback it is given and registers it as the
 * socket's `error` handler as well as its ready notification, so when the port
 * is already taken the listen error is delivered straight to that callback.
 * `server.js` inspects that error argument: on a bind failure it writes the
 * cause to stderr, never prints the startup line, and sets a non-zero exit
 * status - so the `exit` handler in `awaitStartupLog` already fails the run
 * loudly. This check is the layer behind that one.
 *
 * Ownership is established by three layers working together, and no single one
 * of them would be sufficient on its own:
 *   1. `requirePortIsFree` proves nothing was serving BEFORE the spawn, so the
 *      child is the only candidate for whatever answers afterwards.
 *   2. This function proves the readiness line came from a socket that really
 *      answers, with the child still running once it has - a full network round
 *      trip also gives a dying child's `exit` event ample time to arrive.
 *   3. `get` re-checks liveness around EVERY later request and races each one
 *      against the child's death, so ownership stays proven for the whole run
 *      rather than only at this instant.
 */
const confirmServerIsOurs = async () => {
  await get('/');

  if (childHasExited()) {
    throw createHarnessError(
      'The server logged its startup line and then exited, so the process ' +
      `answering ${baseUrl} is NOT the one this suite started. Free port 3000 ` +
      'and re-run.\n' +
      `${describeChild()}`
    );
  }
};

/**
 * Start the real server before any test runs.
 *
 * Four details are load-bearing:
 *
 * 1. `process.execPath` rather than the string 'node', so the child runs the same
 *    interpreter as the test process, not whichever `node` sits first on PATH.
 *
 * 2. Readiness is OBSERVED, never guessed: the hook resolves when the child's
 *    ACCUMULATED stdout contains the startup log line, since a stream may split
 *    that line across chunks.
 *
 * 3. Failure is LOUD, never a hang. An `exit` listener fails the run when the
 *    child dies - which is how EADDRINUSE on the hardcoded port surfaces - a
 *    spawn `error` listener fails it when no process was ever created, and a
 *    bounded timer fails it if readiness never arrives. Every such message
 *    carries whatever the child printed.
 *
 * 4. The listeners installed here OUTLIVE startup, because the child's `exit`,
 *    `close` and `error` events can arrive at any point and the requests and the
 *    teardown hook consult what they record. Only the readiness probe is
 *    startup-specific, and it is removed the moment startup settles.
 *
 * stderr is collected for diagnostics only: runtimes may print warnings there
 * during a healthy start, so stderr content alone is never treated as an error.
 */
const awaitStartupLog = () => new Promise((resolve, reject) => {
  resetChildState();
  serverProcess = spawn(process.execPath, [serverPath], { stdio: ['ignore', 'pipe', 'pipe'] });

  // The two deadlines this phase can be waiting on: one for readiness to arrive,
  // one for a dead child's output to finish arriving. Both are cleared when
  // startup settles, so neither can outlive the decision or hold the runner open.
  let readyTimer = null;
  let drainTimer = null;

  /**
   * The single settlement point for startup. Everything that can decide the
   * outcome routes through here, so the promise cannot settle twice and no timer
   * outlives the decision.
   */
  const finish = (error) => {
    if (startupSettled) {
      return;
    }
    startupSettled = true;
    clearTimeout(readyTimer);
    clearTimeout(drainTimer);

    // The readiness probe has done its job; leaving it attached would keep a
    // startup-phase concern listening for the rest of the run.
    if (serverProcess.stdout !== null && serverProcess.stdout !== undefined) {
      serverProcess.stdout.removeListener('data', watchForReadyLog);
    }

    if (error) {
      reject(error);
      return;
    }
    resolve();
  };

  /**
   * Fail startup because the child died first - but only once its output is
   * complete.
   *
   * The distinction is what makes the failure message worth reading. `exit` says
   * the process is gone; it does NOT say that everything it wrote has been
   * delivered. Building the error there can capture a half-written stderr and
   * lose the one line that names the cause, so the exit status is recorded
   * immediately and the message is assembled after `close` - or after a short
   * drain deadline, so a stream that never closes cannot stall the failure.
   */
  const failAfterOutputIsComplete = (code, signal) => {
    // Readiness can no longer arrive, so the readiness deadline must not be
    // allowed to preempt this far more specific message.
    clearTimeout(readyTimer);

    const build = () => finish(createHarnessError(
      `Server exited before reporting readiness (code ${code}, signal ${signal}). ` +
      'The stderr below normally names the cause - note that port 3000 is ' +
      'hardcoded, so a process already listening on it fails the child with ' +
      `EADDRINUSE.\n${describeChild()}`
    ));

    if (childStdioClosed) {
      build();
      return;
    }

    drainTimer = setTimeout(build, stdioDrainTimeoutMs);
    stdioClosed.promise.then(build);
  };

  /**
   * Record the child's death, then route it to whoever is entitled to react:
   * startup if it has not settled, an in-flight request otherwise. A death
   * during teardown is expected and is deliberately NOT reported as a failure.
   */
  const onExit = (code, signal) => {
    childExit = { code, signal };
    exitObserved.resolve({ code, signal });

    if (!teardownRequested) {
      childFailure.resolve({ kind: 'exit', code, signal });
    }

    if (!startupSettled) {
      failAfterOutputIsComplete(code, signal);
    }
  };

  /** The child's output is final from here on, so diagnostics are complete. */
  const onClose = () => {
    childStdioClosed = true;
    stdioClosed.resolve(true);
  };

  /**
   * Node emits `error` both when a process could not be SPAWNED and when a
   * signal could not be DELIVERED to it, so this one handler covers a failed
   * launch and a failed kill. Which of the two it is depends entirely on the
   * phase, which is why the handler consults the phase instead of assuming.
   */
  const onError = (error) => {
    if (childError === null) {
      childError = error;
    }

    if (teardownRequested) {
      // A kill that could not be delivered. The teardown hook reports it; it
      // must never be dropped, because that is how an orphan keeps the port.
      teardownError = error;
      return;
    }

    childFailure.resolve({ kind: 'error', error });

    if (!startupSettled) {
      finish(createHarnessError(
        `Could not spawn the server: ${redactMessage(error.message)}\n${describeChild()}`
      ));
    }
  };

  const watchForReadyLog = () => {
    if (serverStdout.includes(readyLog)) {
      finish(null);
    }
  };

  /**
   * Accumulate the child's output. Both handlers stay attached for the whole run
   * so that a failure at any point can quote everything the child ever printed.
   */
  const appendStdout = (chunk) => {
    serverStdout += chunk;
  };

  const appendStderr = (chunk) => {
    serverStderr += chunk;
  };

  // Attach the child-level listeners FIRST, before touching anything on the
  // handle. A spawn that fails immediately - a missing interpreter, a missing
  // entrypoint - reports itself through `error`, and if that listener is not
  // installed yet the failure escapes as an unhandled child error or as a
  // TypeError from the next line instead of the diagnostic built above.
  serverProcess.on('error', onError);
  serverProcess.on('exit', onExit);
  serverProcess.on('close', onClose);

  // Publish them immediately, before anything below can fail. Teardown detaches
  // precisely the listeners named in this record and calls `unref` on the child,
  // and it does nothing at all while the record is empty - so a startup that
  // fails at the pipe check just below would otherwise leave these three
  // attached and the child handle holding the runner's event loop open.
  installedListeners = {
    error: onError,
    exit: onExit,
    close: onClose
  };

  // Node leaves the pipes null or undefined when a child could not be spawned
  // successfully, so they are checked rather than assumed. Without stdout there
  // is no readiness signal to wait for, which makes the run unwinnable - fail it
  // here, through the same settlement path as every other outcome.
  if (
    serverProcess.stdout === null || serverProcess.stdout === undefined ||
    serverProcess.stderr === null || serverProcess.stderr === undefined
  ) {
    finish(createHarnessError(
      'The server child process has no stdout/stderr pipes, so its readiness ' +
      'log can never be observed. This normally means the process could not be ' +
      `spawned successfully.\n${describeChild()}`
    ));
    return;
  }

  readyTimer = setTimeout(() => {
    finish(createHarnessError(
      `Server did not log "${readyLog}" within ${startupTimeoutMs} ms.\n${describeChild()}`
    ));
  }, startupTimeoutMs);

  // Accumulate first, then test the accumulation: a stream may split the
  // readiness line across chunks, and only the running total is reliable.
  // Registration order guarantees that pairing, since listeners run in the order
  // they were added.
  serverProcess.stdout.setEncoding('utf8');
  serverProcess.stdout.on('data', appendStdout);
  serverProcess.stdout.on('data', watchForReadyLog);

  serverProcess.stderr.setEncoding('utf8');
  serverProcess.stderr.on('data', appendStderr);

  // Complete the record now that the stdio handlers are attached too, so
  // teardown detaches precisely these listeners - and only these - once the run
  // is over.
  installedListeners.stdoutData = appendStdout;
  installedListeners.stdoutReady = watchForReadyLog;
  installedListeners.stderrData = appendStderr;
});

/**
 * Bring the server up before any test runs, in three ordered steps whose order
 * is itself part of the guarantee: prove the port is free, start the child and
 * observe its readiness, then prove the process answering that port is the child.
 *
 * The hook carries an explicit deadline because Node leaves hook timeouts
 * unbounded by default; it is generous enough that only a genuine stall inside
 * the hook can trip it.
 */
before(async () => {
  await requirePortIsFree();
  await awaitStartupLog();
  await confirmServerIsOurs();
}, { timeout: startupHookTimeoutMs });

/**
 * Shut the server down once every test has run - completely, and within a
 * deadline it cannot exceed.
 *
 * Teardown is written as a bounded sequence of states rather than a single wait,
 * because "wait for the child to exit" is exactly the step that can never be
 * trusted to complete. Each stage has its own deadline and each outcome is
 * checked:
 *
 *   1. Announce the shutdown. From here an exit is EXPECTED, so the death is not
 *      reported as a mid-suite failure.
 *   2. Skip the whole sequence if there is nothing to stop - the child was never
 *      spawned, or it has already exited. Signalling a corpse is pointless noise.
 *   3. Ask politely with SIGTERM, and check that the signal was actually
 *      delivered instead of assuming it.
 *   4. Wait a bounded grace period for the exit; escalate to SIGKILL if the
 *      child ignores it, again checking delivery.
 *   5. Wait a second bounded period. If the child is STILL there, stop waiting
 *      and fail - a pending wait here would hang `npm test` with no result at
 *      all, and would leave port 3000 occupied for whatever runs next.
 *   6. Let the output drain briefly so the final diagnostics are complete.
 *
 * Anything that went wrong is collected and reported together, including a kill
 * the runtime could not deliver: a shutdown error that is swallowed is precisely
 * how an orphaned process survives the run. Whatever the outcome, every timer is
 * cleared and every listener detached before the hook returns, and the hook
 * itself carries an explicit deadline because Node leaves hook timeouts
 * unbounded by default.
 */
after(async () => {
  teardownRequested = true;

  const problems = [];

  try {
    if (!childWasSpawned() || childHasExited()) {
      return;
    }

    if (!serverProcess.kill('SIGTERM') && !childHasExited()) {
      problems.push('SIGTERM could not be delivered to the child process');
    }

    if (!(await settledWithin(exitObserved.promise, gracefulStopTimeoutMs))) {
      if (!serverProcess.kill('SIGKILL') && !childHasExited()) {
        problems.push('SIGKILL could not be delivered to the child process');
      }

      // Step 5 - terminal deadline. Reporting beats waiting forever. The state
      // is re-read before reporting, so an exit that lands right on the deadline
      // is treated as the success it is rather than as a phantom failure.
      if (!(await settledWithin(exitObserved.promise, forcedStopTimeoutMs)) && !childHasExited()) {
        problems.push(
          `the child was still running ${gracefulStopTimeoutMs + forcedStopTimeoutMs} ms ` +
          'after SIGTERM and SIGKILL, so it is probably still holding port 3000'
        );
      }
    }

    // Step 6 - give the pipes a bounded moment to finish, purely so that any
    // diagnostics printed on the way out are complete.
    if (!childStdioClosed) {
      await settledWithin(stdioClosed.promise, stdioDrainTimeoutMs);
    }

    if (teardownError !== null) {
      problems.push(
        `the runtime reported "${redactMessage(teardownError.message)}" while stopping the child`
      );
    }
  } finally {
    // No timer of ours survives this hook: `settledWithin` clears its own, and
    // the startup timers were cleared when startup settled. What remains are the
    // listeners and the pipes, and both are released here.
    releaseChildResources();
  }

  if (problems.length > 0) {
    throw createHarnessError(
      'The server process could not be shut down cleanly:\n' +
      `${problems.map((problem) => `  - ${problem}`).join('\n')}\n${describeChild()}`
    );
  }
}, { timeout: teardownHookTimeoutMs });

/**
 * Test 1 - the root greeting, asserted byte for byte.
 *
 * `GET /` answers 200 with Content-Type `text/plain; charset=utf-8` and a body
 * of exactly `Hello, World!\n` - 14 bytes, trailing newline included. That
 * newline is part of the published contract rather than cosmetic, and terminal
 * output hides it, so the byte length is asserted explicitly alongside the
 * literal. The literal is authoritative: it is deliberately not relaxed to a
 * looser paraphrase such as 'Hello world'.
 */
test('GET / returns the greeting byte for byte', async () => {
  const response = await get('/');

  assert.equal(response.status, 200, 'the root route must answer 200 OK');

  // Strict equality against the FULL header value. `res.type('text/plain')`
  // sets that type verbatim - an argument containing a slash is passed straight
  // through - and it is `res.send`, sending a string, that appends the charset to
  // whatever Content-Type is already set. So the header on the wire carries the
  // charset and a bare 'text/plain' comparison would fail against entirely
  // correct behaviour. Pinning the whole value also catches a regression to
  // Express's `text/html` default if `res.type` were ever dropped.
  assert.equal(
    response.headers.get('content-type'),
    expectedContentType,
    'the root route must serve plain text, not Express\'s text/html default'
  );

  assert.equal(response.body, 'Hello, World!\n', 'the greeting must be preserved verbatim');
  assert.equal(Buffer.byteLength(response.body), 14, 'the greeting must remain 14 bytes');
});

/**
 * Test 2 - the evening greeting, asserted WITHOUT a trailing newline.
 *
 * `GET /evening` answers 200 with Content-Type `text/plain; charset=utf-8` and a
 * body of exactly `Good evening` - 12 bytes, no terminator. The asymmetry with
 * test 1 is the whole reason both tests exist: the root greeting ends in a
 * newline and this one does not, so the absence is asserted explicitly rather
 * than left to the strict body comparison alone.
 */
test('GET /evening returns the evening greeting with no trailing newline', async () => {
  const response = await get('/evening');

  assert.equal(response.status, 200, 'the evening route must answer 200 OK');

  assert.equal(
    response.headers.get('content-type'),
    expectedContentType,
    'the evening route must serve plain text'
  );

  assert.equal(response.body, 'Good evening', 'the evening greeting must be exact');
  assert.equal(Buffer.byteLength(response.body), 12, 'the evening greeting must remain 12 bytes');
  assert.equal(
    response.body.endsWith('\n'),
    false,
    'the evening greeting must NOT gain a trailing newline'
  );
});

/**
 * Test 3 - the framework must not advertise itself.
 *
 * Express enables an `X-Powered-By` response header by default, and `server.js`
 * disables that setting application-wide, so neither route sends it. This test
 * is what keeps it that way.
 *
 * Both routes are checked, because the header is written per response from an
 * application-wide setting rather than per route: if the setting were ever
 * re-enabled, every response would regain the header at once.
 */
test('neither endpoint advertises the framework via x-powered-by', async () => {
  const root = await get('/');
  const evening = await get('/evening');

  // `Headers.get` yields null for a header that was never sent, which is
  // exactly the condition being asserted.
  assert.equal(
    root.headers.get('x-powered-by'),
    null,
    'the root route must not send an x-powered-by header'
  );

  assert.equal(
    evening.headers.get('x-powered-by'),
    null,
    'the evening route must not send an x-powered-by header'
  );
});

/**
 * Test 4 - anything unrouted falls through to the default 404.
 *
 * Mechanises the documented manual step `curl http://127.0.0.1:3000/nonexistent`.
 *
 * The server registers no middleware at all, so route declaration order is the
 * entire routing contract and any unmatched path reaches Express's built-in
 * final handler. Only the status is asserted: the body and content type of
 * that handler are framework internals, and pinning them would make this test
 * fail on an Express upgrade that changed nothing the project actually
 * promises.
 *
 * `fetch` resolves rather than throws on a 404, so the response is inspected
 * normally.
 */
test('GET /nonexistent falls through to the default 404 handler', async () => {
  const response = await get('/nonexistent');

  assert.equal(response.status, 404, 'an unregistered path must answer 404');
});

/**
 * Test 5 - the listening socket is bound to loopback and to nothing else.
 *
 * `server.js` passes a `host` of 127.0.0.1 to `app.listen`, so the socket accepts
 * connections from this host and from no other interface. Losing that argument is
 * not a hypothetical regression - an earlier revision of this project did exactly
 * that, and served the tutorial on its container's routable address while its own
 * startup log and README still promised loopback. Tests 1 to 4 would stay green
 * through it, which is why this one asserts the negative instead: the addresses
 * `addressesOutsideTheBinding` reports must refuse the port.
 *
 * The order is as load-bearing as the assertion. A server that has died refuses
 * every address, so the refusals mean nothing until the socket is known to be up
 * and serving - hence the positive control first, through `get`, which also
 * brackets that request with liveness checks on the child.
 *
 * One environmental caveat the failure message cannot state: a foreign process
 * bound to one of this host's non-loopback addresses on this same port would be
 * reported here too. The pre-flight in `before` rules that out for loopback but
 * cannot for every interface, so this test fails in the safe direction - it
 * reports a socket reachable where it should not be and leaves the operator to
 * see which process owns it.
 */
test('the listening socket is bound to loopback only', async () => {
  const serving = await get('/');

  assert.equal(
    serving.status,
    200,
    `the server must be answering on ${baseUrl} for the refusals below to prove anything`
  );

  const outside = addressesOutsideTheBinding();

  // An empty list would walk the loop below zero times and report a green
  // without probing anything, so the target list is asserted rather than
  // assumed.
  assert.notEqual(
    outside.length,
    0,
    'there must be at least one address outside the binding to probe'
  );

  for (const address of outside) {
    const { accepted, detail } = await probePortAt(address);

    assert.equal(
      accepted,
      false,
      `port ${serverPort} must not accept connections at ${address}: ${loopbackHost} is ` +
      `answering, so accepting there too means the listening socket is bound to a wildcard ` +
      `address (0.0.0.0 or ::) rather than to ${loopbackHost} alone - ${detail}`
    );
  }
});
