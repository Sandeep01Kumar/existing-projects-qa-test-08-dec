/**
 * Endpoint verification suite for the Express.js tutorial server.
 *
 * WHY THIS FILE EXISTS
 * Before this suite, `npm test` was the npm placeholder that unconditionally
 * exited non-zero, so the project's "Endpoint Verification" quality gate had no
 * executable backing at all: both endpoint contracts were asserted only in
 * README prose. Nothing proved that `GET /` still returned its original 14-byte
 * greeting, or that `GET /evening` returned exactly 12 bytes. This file turns
 * that prose into durable, repeatable verification.
 *
 * WHY THERE ARE NO DEPENDENCIES
 * The project deliberately excludes third-party test frameworks (jest, mocha,
 * supertest and friends). Rather than argue around that exclusion, this suite
 * honours it literally: it uses only Node built-ins - `node:test`,
 * `node:assert/strict`, `node:child_process`, `node:path` - plus the global
 * `fetch` and `AbortController` that the runtime already provides. Installing
 * nothing keeps `npm ls --depth=0` reporting express as the sole dependency and
 * keeps `package.json` free of a devDependencies block.
 *
 * WHY IT SPAWNS THE SERVER INSTEAD OF IMPORTING IT
 * `server.js` exports nothing - it creates the Express app and immediately
 * starts listening. Adding `module.exports = app` purely to make it importable
 * would change the module's public shape and add a line to the one file whose
 * commenting is separately audited, so it is rejected. Spawning `server.js` as
 * a child process and driving it over real HTTP is strictly better anyway: it
 * exercises the deployed shape, exactly as a user does, rather than a
 * test-only variant of the application.
 *
 * WHAT IT AUTOMATES
 * The four tests below mechanise the repository's own documented manual
 * verification checklist, one for one:
 *   1. `npm start`                                -> the readiness signal below
 *   2. `curl http://127.0.0.1:3000/`              -> test 1
 *   3. `curl http://127.0.0.1:3000/evening`       -> test 2
 *   4. `curl http://127.0.0.1:3000/nonexistent`   -> test 4
 * Test 3 additionally pins the absence of the framework's advertising header,
 * which `server.js` suppresses on purpose.
 *
 * HOW IT KNOWS IT IS TESTING THE RIGHT PROCESS
 * The server binds a FIXED port, so "something answered on port 3000" is not the
 * same claim as "the code under test answered". A leftover server from an earlier
 * run, or another checkout of this same tutorial, would answer every request here
 * correctly while the child started below died of EADDRINUSE - and the suite would
 * report a green that proved nothing. Three layers rule that out: the port is
 * proven free BEFORE the child is spawned, readiness is read from that child's own
 * stdout, and every request afterwards is bracketed by a liveness check and raced
 * against the child's death. Teardown is bounded at every step for the mirror-image
 * reason: a suite that cannot stop its own server leaves the port occupied for
 * whatever runs next.
 *
 * @requires node:test - Node's built-in test runner (no external framework)
 * @requires node:assert/strict - strict assertions, so any drift fails loudly
 * @requires node:child_process - to spawn the real server process
 * @requires node:path - to resolve server.js independently of the cwd
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

/**
 * Base URL for every request. The server hardcodes host 127.0.0.1 and port
 * 3000 as literal constants and reads no environment variables, so the suite
 * must target that exact address rather than making it configurable.
 */
const baseUrl = 'http://127.0.0.1:3000';

/**
 * Absolute path to the server entrypoint, resolved from this file's own
 * directory. It must NOT be derived from `process.cwd()`: the npm script runs
 * `node --test tests/` from the repository root, so the cwd is one level above
 * this file. Resolving from `__dirname` is correct no matter where the runner
 * is invoked.
 */
const serverPath = path.join(__dirname, '..', 'server.js');

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
 * deliberately short: the probe talks to loopback only, where a free port
 * refuses the connection immediately, so anything slower than this already
 * means something is sitting on the port.
 */
const preflightTimeoutMs = 2000;

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

/** Everything the child has written to stdout, used for the readiness signal. */
let serverStdout = '';

/** Everything the child has written to stderr, kept purely for diagnostics. */
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

/** True once the child's stdio streams have closed, i.e. its output is final. */
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

/** True once the startup promise has settled, either way. */
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
 * Return the child-process state to its pre-spawn condition.
 *
 * Called immediately before each spawn so that no observation from an earlier
 * attempt can leak into the next one - a stale `childExit` would make a healthy
 * child look dead, which is the sort of bug a test harness must never have.
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
 * point the listeners must stay: a `ChildProcess` with no `error` listener turns
 * the next error into an uncaught exception, so they are replaced by state-aware
 * handlers during the run rather than removed early.
 *
 * The three releases matter for three different reasons. Detaching the listeners
 * stops this suite reacting to a process it no longer owns. Destroying a pipe
 * that never closed frees the handle that pipe holds. And `unref` is the one that
 * guarantees a RESULT: a live child handle keeps its parent's event loop alive,
 * so a child that refused both signals would otherwise stop the runner from ever
 * exiting - turning the loud teardown failure raised just above into the silent
 * hang this whole rewrite exists to prevent.
 */
const releaseChildResources = () => {
  if (serverProcess === null || installedListeners === null) {
    return;
  }

  serverProcess.removeListener('error', installedListeners.error);
  serverProcess.removeListener('exit', installedListeners.exit);
  serverProcess.removeListener('close', installedListeners.close);
  serverProcess.unref();

  if (serverProcess.stdout !== null && serverProcess.stdout !== undefined) {
    serverProcess.stdout.removeListener('data', installedListeners.stdoutData);
    serverProcess.stdout.removeListener('data', installedListeners.stdoutReady);

    if (!childStdioClosed) {
      serverProcess.stdout.destroy();
    }
  }

  if (serverProcess.stderr !== null && serverProcess.stderr !== undefined) {
    serverProcess.stderr.removeListener('data', installedListeners.stderrData);

    if (!childStdioClosed) {
      serverProcess.stderr.destroy();
    }
  }

  installedListeners = null;
};

/**
 * Render what the child process has told us so far. Attached to every failure
 * message so a broken run explains itself instead of leaving the reader to
 * re-run the server by hand: a port clash, a missing express install or a
 * syntax error in server.js all show up here verbatim.
 */
const describeChild = () => {
  const state = serverProcess === null
    ? 'never started'
    : `pid=${serverProcess.pid} exitCode=${serverProcess.exitCode} signalCode=${serverProcess.signalCode}`;

  const recordedExit = childExit === null
    ? 'still running (no exit observed)'
    : `code=${childExit.code} signal=${childExit.signal}`;

  return [
    `  server path : ${serverPath}`,
    `  interpreter : ${process.execPath}`,
    `  child state : ${state}`,
    `  exit seen   : ${recordedExit}`,
    `  stdio closed: ${childStdioClosed}`,
    `  stopping    : ${teardownRequested}`,
    `  child error : ${childError === null ? 'none' : childError.message}`,
    `  stdout seen : ${JSON.stringify(serverStdout)}`,
    `  stderr seen : ${JSON.stringify(serverStderr)}`
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
 * @param {{kind: string, code?: number, signal?: string, error?: Error}} failure
 * @returns {string} a short human-readable cause
 */
const describeFailure = (failure) => (
  failure.kind === 'error'
    ? `the runtime reported "${failure.error.message}"`
    : `it exited with code ${failure.code} and signal ${failure.signal}`
);

/**
 * True once the operating system actually gave us a process. Node leaves `pid`
 * undefined when a spawn fails, and in that case there is nothing alive to
 * signal, wait for or tear down.
 */
const childWasSpawned = () => serverProcess !== null && serverProcess.pid !== undefined;

/**
 * True once the child has exited, for any reason.
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

    // ...and the child must still be alive AFTER it answered. A response from a
    // process that has since vanished is the signature of a stale server holding
    // the port while our own child exits, which is precisely the false green
    // this bracket exists to prevent.
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

    const reason = error instanceof Error ? error.message : String(error);

    throw createHarnessError(`GET ${route} failed: ${reason}\n${describeChild()}`);
  } finally {
    clearTimeout(timer);
  }
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
 * @returns {Promise<{free: boolean, detail: string}>}
 */
const probeFixedPort = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), preflightTimeoutMs);

  try {
    const response = await fetch(`${baseUrl}/`, { signal: controller.signal });

    // Drain the body so the connection is released rather than left half-read.
    await response.text();

    return { free: false, detail: `it answered with HTTP ${response.status}` };
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

    const reason = error instanceof Error ? error.message : String(error);

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
 * Three details are load-bearing:
 *
 * 1. `process.execPath` rather than the string 'node'. This guarantees the
 *    child runs the very same interpreter as the test process, so the suite
 *    exercises the intended runtime instead of whichever `node` happens to sit
 *    first on PATH.
 *
 * 2. Readiness is OBSERVED, never guessed. The hook resolves when the child's
 *    accumulated stdout contains the startup log line - checked against the
 *    running accumulation rather than a single chunk, since a stream may split
 *    the line across chunks. A fixed sleep would be both slower and racy.
 *
 * 3. Failure is LOUD, never a hang. The server binds a hardcoded port, so a
 *    stale process already holding it is a realistic failure mode. Three guards
 *    cover it: an `exit` listener fails the run when the child dies (this is how
 *    EADDRINUSE surfaces - the server reports the bind error on stderr and exits
 *    non-zero), a spawn `error` listener fails it when there was never a process
 *    at all, and a bounded timer fails it if readiness simply never arrives.
 *    Every one of those messages carries whatever the child printed.
 *
 * 4. The listeners installed here OUTLIVE startup, and that is deliberate. The
 *    child's `exit`, `close` and `error` events can arrive at any point in the
 *    run, so each one records what happened into shared state that the requests
 *    and the teardown hook consult afterwards. Only the readiness probe is
 *    startup-specific, and it is removed the moment startup settles. Binding
 *    every listener to a one-shot settlement instead would leave them inert
 *    afterwards: a mid-suite crash would go unnoticed and a failed kill during
 *    teardown would be swallowed.
 *
 * Note that stderr is collected for diagnostics only. Runtimes may print
 * warnings there during a perfectly healthy start, so stderr content alone is
 * never treated as an error.
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
        `Could not spawn the server: ${error.message}\n${describeChild()}`
      ));
    }
  };

  /** Startup-only: resolve as soon as the accumulated stdout carries the line. */
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

  // Publish the handler references so teardown can detach precisely these
  // listeners - and only these - once the run is over.
  installedListeners = {
    error: onError,
    exit: onExit,
    close: onClose,
    stdoutData: appendStdout,
    stdoutReady: watchForReadyLog,
    stderrData: appendStderr
  };
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
  // Step 1 - from this moment an exit is expected rather than a failure.
  teardownRequested = true;

  const problems = [];

  try {
    // Step 2 - nothing to stop.
    if (!childWasSpawned() || childHasExited()) {
      return;
    }

    // Step 3 - ask politely, and verify the signal landed.
    if (!serverProcess.kill('SIGTERM') && !childHasExited()) {
      problems.push('SIGTERM could not be delivered to the child process');
    }

    // Step 4 - bounded grace, then force.
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
      problems.push(`the runtime reported "${teardownError.message}" while stopping the child`);
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
 * Test 1 - the original greeting, preserved byte for byte.
 *
 * Mechanises the documented manual step `curl http://127.0.0.1:3000/`.
 *
 * The trailing newline is the point of this test. It is not cosmetic: the
 * greeting predates the Express migration and the newline is part of its
 * published contract, so the response must stay exactly 14 bytes -
 * `Hello, World!` plus `\n`. Terminal output hides that byte, which is why the
 * length is asserted explicitly alongside the literal.
 *
 * The literal is also authoritative in its own right. It is deliberately NOT
 * "corrected" to a looser paraphrase such as 'Hello world': the code emitted
 * this exact string before this change set and must keep emitting it.
 */
test('GET / returns the original greeting byte for byte', async () => {
  const response = await get('/');

  assert.equal(response.status, 200, 'the root route must answer 200 OK');

  // Strict equality against the FULL header value. Express appends the charset
  // to `res.type('text/plain')`, so a bare 'text/plain' comparison would fail
  // against entirely correct behaviour. Pinning the whole value also catches a
  // regression to Express's `text/html` default if `res.type` were ever
  // dropped.
  assert.equal(
    response.headers.get('content-type'),
    expectedContentType,
    'the root route must serve plain text, not Express\'s text/html default'
  );

  assert.equal(response.body, 'Hello, World!\n', 'the greeting must be preserved verbatim');

  // Buffer is a runtime global, so counting bytes costs no dependency. This
  // guards the trailing newline that strict string equality already covers but
  // that a future edit could quietly drop.
  assert.equal(Buffer.byteLength(response.body), 14, 'the greeting must remain 14 bytes');
});

/**
 * Test 2 - the evening greeting, deliberately WITHOUT a trailing newline.
 *
 * Mechanises the documented manual step `curl http://127.0.0.1:3000/evening`.
 *
 * The asymmetry with test 1 is the whole reason both tests exist: the root
 * greeting ends in a newline for backward compatibility, this one does not.
 * Twelve bytes exactly, no terminator. Asserting the absence explicitly means
 * a well-meaning "let's be consistent" edit fails the build instead of
 * silently changing a published contract.
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
 * Express enables an `X-Powered-By` response header by default. It offers no
 * functional benefit, it names the stack to anyone who asks, and the server
 * predating the Express migration never sent it - so `server.js` turns the
 * setting off. This test is what keeps it off.
 *
 * Both routes are checked, because the header is written per response from an
 * application-wide setting rather than per route: if the setting were ever
 * re-enabled, every response would regain the header at once.
 *
 * Note that older project documentation lists `X-Powered-By: Express` among
 * the expected response headers. That documentation predates the header's
 * removal and is stale; absence is the current contract.
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
