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
 * Render what the child process has told us so far. Attached to every failure
 * message so a broken run explains itself instead of leaving the reader to
 * re-run the server by hand: a port clash, a missing express install or a
 * syntax error in server.js all show up here verbatim.
 */
const describeChild = () => {
  const state = serverProcess === null
    ? 'never started'
    : `exitCode=${serverProcess.exitCode} signalCode=${serverProcess.signalCode}`;

  return [
    `  server path : ${serverPath}`,
    `  interpreter : ${process.execPath}`,
    `  child state : ${state}`,
    `  stdout seen : ${JSON.stringify(serverStdout)}`,
    `  stderr seen : ${JSON.stringify(serverStderr)}`
  ].join('\n');
};

/**
 * True once the child has exited, for any reason. Used to tell "our server is
 * serving" apart from "something else is serving" - see `confirmServerIsOurs`.
 */
const childHasExited = () =>
  serverProcess === null ||
  serverProcess.exitCode !== null ||
  serverProcess.signalCode !== null;

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(`${baseUrl}${route}`, { signal: controller.signal });
    const body = await response.text();
    return { status: response.status, headers: response.headers, body };
  } catch (error) {
    // Enrich in one place rather than in each test: a bare "operation was
    // aborted" says nothing, whereas the child's state and output usually
    // identify the cause immediately.
    throw new Error(`GET ${route} failed: ${error.message}\n${describeChild()}`);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Prove that the process answering port 3000 is the child this suite started.
 *
 * This step is NOT belt-and-braces, it closes a real hole. Express's `app.listen`
 * wraps the callback it is given and registers it as the socket's `error`
 * handler as well as its ready notification, so when the port is already taken
 * the listen error is delivered straight to that callback - the startup line is
 * printed, nothing is thrown, and the process then exits quietly with status 0.
 * The startup log therefore proves that listening was ATTEMPTED, not that it
 * succeeded. Left there, a stale server already holding port 3000 would answer
 * every request correctly and the suite would report four passes while never
 * having exercised the code under test at all.
 *
 * Two observations settle it. One real request confirms something is genuinely
 * serving - and, being a full network round trip, it also gives a dead child's
 * `exit` event ample time to be delivered. The child must then still be
 * running: if it has gone, whatever answered was somebody else's server.
 */
const confirmServerIsOurs = async () => {
  await get('/');

  if (childHasExited()) {
    throw new Error(
      'The server logged its startup line and then exited, so the process ' +
      `answering ${baseUrl} is NOT the one this suite started. Express hands a ` +
      'listen error to the very callback it uses for the ready notification, so ' +
      'a port clash still prints that line. Free port 3000 and re-run.\n' +
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
 *    stale process already holding it is a realistic failure mode. Two guards
 *    cover it: an `exit` listener fails the run the instant the child dies
 *    (this is how EADDRINUSE surfaces), and a bounded timer fails the run if
 *    readiness simply never arrives. Either way the message carries whatever
 *    the child printed.
 *
 * Note that stderr is collected for diagnostics only. Runtimes may print
 * warnings there during a perfectly healthy start, so stderr content alone is
 * never treated as an error.
 *
 * Seeing the log is necessary but not sufficient, so the hook finishes by
 * calling `confirmServerIsOurs` - read the comment on it, the reason is not
 * obvious.
 */
const awaitStartupLog = () => new Promise((resolve, reject) => {
  serverStdout = '';
  serverStderr = '';
  serverProcess = spawn(process.execPath, [serverPath], { stdio: ['ignore', 'pipe', 'pipe'] });

  // Guard so the promise settles exactly once, whichever outcome arrives first.
  let settled = false;
  let readyTimer = null;

  const finish = (error) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(readyTimer);

    if (error) {
      reject(error);
      return;
    }
    resolve();
  };

  readyTimer = setTimeout(() => {
    finish(new Error(
      `Server did not log "${readyLog}" within ${startupTimeoutMs} ms.\n${describeChild()}`
    ));
  }, startupTimeoutMs);

  serverProcess.stdout.setEncoding('utf8');
  serverProcess.stdout.on('data', (chunk) => {
    serverStdout += chunk;

    if (serverStdout.includes(readyLog)) {
      finish(null);
    }
  });

  serverProcess.stderr.setEncoding('utf8');
  serverProcess.stderr.on('data', (chunk) => {
    serverStderr += chunk;
  });

  serverProcess.on('error', (error) => {
    finish(new Error(`Could not spawn the server: ${error.message}\n${describeChild()}`));
  });

  serverProcess.on('exit', (code, signal) => {
    finish(new Error(
      `Server exited before reporting readiness (code ${code}, signal ${signal}). ` +
      `The stderr below normally names the cause - note that port 3000 is ` +
      `hardcoded, so a process already listening on it fails the child with ` +
      `EADDRINUSE.\n${describeChild()}`
    ));
  });
});

before(async () => {
  await awaitStartupLog();
  await confirmServerIsOurs();
});

/**
 * Shut the server down once every test has run.
 *
 * The kill is CONDITIONAL: if the child already exited - a crash, or a
 * readiness failure that took it down - `exitCode` or `signalCode` is set, and
 * signalling a dead process would be pointless noise. When it is still alive we
 * ask politely with SIGTERM, wait for the `exit` event so no orphan is left
 * holding port 3000 after `npm test` returns, and escalate to SIGKILL only if
 * it refuses to go, so teardown can never hang.
 */
after(async () => {
  // Covers both "never started" and "already gone" in one predicate.
  if (childHasExited()) {
    return;
  }

  const exited = new Promise((resolve) => serverProcess.once('exit', resolve));
  const forceTimer = setTimeout(() => serverProcess.kill('SIGKILL'), 2000);

  serverProcess.kill('SIGTERM');
  await exited;
  clearTimeout(forceTimer);
});

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

