# hao-backprop-test

A simple Node.js Hello World server built with Express.js framework.

## Description

This project demonstrates a basic HTTP server using Express.js with multiple endpoints. Originally created for backprop integration testing.

## Prerequisites

- Node.js `^20.20.2 || >=22.12.0` - that is, 20.20.2 or newer on the Node 20 line, or 22.12.0 and anything newer (22, 24, 26) - declared in the `engines` field of `package.json`
- npm 10 or higher (`>=10.0.0`) - declared in the same `engines` field

`.nvmrc` selects `20.20.2`, which is the runtime this project was built and verified against. Be aware that **the Node 20 line reached end-of-life on 30 April 2026 and receives no further security patches**; the lines still supported upstream are 22 (maintenance LTS), 24 (active LTS) and 26 (current). The declared range therefore accepts every supported line as well as 20.20.2, so nothing here holds you on 20 - if you have a choice, run 22.12.0 or newer, and change `.nvmrc` to match if you pin with a version manager. The suite is verified on 20.20.2 and 22.23.2.

Both bounds are lower bounds and the range deliberately admits newer majors, which it can do because the suite is always named as a file rather than as the `tests/` directory. An earlier version of this project passed the directory. Passing a directory is part of the Node 20 test runner's contract, but Node 22 reads the same argument as a glob pattern and finds nothing there, so that command worked on one line only - and the range had been narrowed to the Node 20 line to match it, which pinned the project to a runtime that is now out of support. Naming the file works identically on every supported line, so the runtime no longer has to be narrowed to keep `npm test` working.

npm checks `engines` on every install: a runtime outside the declared range is reported as an `npm warn EBADENGINE` line naming both the required and the current version, and the install is refused outright when `engine-strict` is enabled. This project ships no `.npmrc`, so an unsupported runtime warns rather than blocks.

## Installation

1. Clone the repository
2. Install dependencies:

```bash
npm install
```

## Usage

Start the server:

```bash
npm start
```

The server will run at `http://127.0.0.1:3000/`

It binds only to the loopback interface (`127.0.0.1`), so it is reachable from this machine and is not reachable from other hosts. On startup the server logs exactly:

```text
Server running at http://127.0.0.1:3000/
```

Loopback-only binding is deliberate: it keeps network exposure to a minimum. The host and port are hardcoded constants in `server.js`.

## Testing

Run the endpoint verification suite:

```bash
npm test
```

This runs `node tests/server.test.js`, which uses Node's built-in test runner: no additional test dependencies are installed or needed, and the project declares no `devDependencies`. The run launches `server.js` as a child process, waits for the startup line shown above, then exercises the running server over real HTTP.

Four tests report, and they check five things:

- **`GET / returns the greeting byte for byte from a loopback-only socket`** - answers 200 with `text/plain; charset=utf-8` and a body of exactly 14 bytes; and, while that request is being answered on `127.0.0.1:3000`, a connection to this host's own non-loopback address on the same port is refused
- **`GET /evening returns the evening greeting with no trailing newline`** - answers 200 with `text/plain; charset=utf-8` and a body of exactly 12 bytes, with no trailing newline
- **`neither endpoint advertises the framework via x-powered-by`** - neither response carries that header
- **`GET /nonexistent falls through to the default 404 handler`** - an unregistered path answers 404

The binding check rides in the first test rather than standing on its own, because it needs exactly what that test has already established. A request to `127.0.0.1` cannot settle the binding on its own - loopback answers whether the socket is bound to `127.0.0.1` or to every interface - so the binding is settled by the inverse claim: the addresses outside the binding must all refuse the port. A server that has died refuses every address too, so those refusals only mean something while the socket is known to be up and serving, and the greeting assertions above them are that proof.

A complete run reports `# tests 4`, `# pass 4` and `# fail 0`, and `npm test` exits non-zero if any of those contracts drifts.

Port 3000 must be free before you run the suite, because the server binds that port directly; a process already holding it makes the run fail with an explanatory message instead of hanging.

### Why `npm test` does not call `node --test` directly

`node tests/server.test.js` runs the suite in a child `node --test` process and copies that runner's report out through a redaction filter. The runner labels every failure with the absolute path of the test file and a full stack trace; both describe the filesystem of whoever ran the suite rather than the failure itself, and both end up in whatever log collects CI output. So a failure reads like this instead - an excerpt from a run that found port 3000 already taken:

```text
  location: '<repo>/tests/server.test.js:1338:3'
  stack: |-
    <5 stack frames omitted>
```

The file is named relative to the repository, which is as actionable as a full path and discloses nothing; runs of stack frames are replaced by a count of what was dropped. Nothing else about the report changes - it is the runner's own TAP output, including the summary counts above - and the runner's exit status is passed straight through, so redaction decides how a failure reads and never whether the run failed. To see the frames, run the suite under the runner directly with `node --test tests/server.test.js`; to see the redacted form, start the server with `npm start` in one shell and run `npm test` in another, which fails the pre-flight because port 3000 is taken.

Interrupting `npm test` stops the whole tree - the runner, the suite and the server it started - so an abandoned run does not leave port 3000 occupied for the next one.

## API Endpoints

| Endpoint | Method | Status | Content Type | Response |
|----------|--------|--------|--------------|----------|
| `/` | GET | 200 | `text/plain; charset=utf-8` | `Hello, World!\n` - 14 bytes, ending in one trailing newline byte |
| `/evening` | GET | 200 | `text/plain; charset=utf-8` | `Good evening` - 12 bytes, with no trailing newline |

In the Response column, `\n` is notation for a single newline byte (LF, `0x0A`) at the end of the body - not for the two characters `\` and `n`, which the response never contains. The trailing newline on `/` belongs to that endpoint's original contract and is preserved deliberately, while `/evening` deliberately omits it; that one-byte difference is why both lengths are stated. No `X-Powered-By` header is sent on either route, because `server.js` disables it. Any path matching neither route is handled by Express's default handler, which answers 404.

### Examples

**Hello World Endpoint:**
```bash
curl http://127.0.0.1:3000/
```
Response: HTTP 200, `Content-Type: text/plain; charset=utf-8`, body `Hello, World!\n` - 14 bytes, whose final byte is the newline the response itself sends.

**Good Evening Endpoint:**
```bash
curl http://127.0.0.1:3000/evening
```
Response: HTTP 200, `Content-Type: text/plain; charset=utf-8`, body `Good evening` - 12 bytes, with no trailing newline. Because the body does not end in a newline, your shell prints its next prompt on the same line; that prompt is terminal formatting, not part of the response.

To see the status line and headers, or to confirm the byte counts yourself:

```bash
curl -i http://127.0.0.1:3000/
curl -s http://127.0.0.1:3000/ | wc -c         # 14
curl -s http://127.0.0.1:3000/evening | wc -c  # 12
```

## License

MIT
