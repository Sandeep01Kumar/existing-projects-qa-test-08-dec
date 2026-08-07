# hao-backprop-test

A simple Node.js Hello World server built with Express.js framework.

## Description

This project demonstrates a basic HTTP server using Express.js with multiple endpoints. Originally created for backprop integration testing.

## Prerequisites

- Node.js `^20.20.2 || >=22.12.0` - that is, 20.20.2 or newer on the Node 20 line, or 22.12.0 and anything newer (22, 24, 26) - declared in the `engines` field of `package.json`
- npm 10 or higher (`>=10.0.0`) - declared in the same `engines` field

`.nvmrc` selects `20.20.2`, which is the runtime this project was built and verified against. Be aware that **the Node 20 line reached end-of-life on 30 April 2026 and receives no further security patches**; the lines still supported upstream are 22 (maintenance LTS), 24 (active LTS) and 26 (current). The declared range therefore accepts every supported line as well as 20.20.2, so nothing here holds you on 20 - if you have a choice, run 22.12.0 or newer, and change `.nvmrc` to match if you pin with a version manager. The suite is verified on 20.20.2 and 22.23.2.

Both bounds are lower bounds and the range deliberately admits newer majors, which it can do because `npm test` names its suite file outright (`node --test tests/server.test.js`). An earlier version of this project named the `tests/` directory instead. Passing a directory is part of the Node 20 test runner's contract, but Node 22 reads the same argument as a glob pattern and finds nothing there, so that command worked on one line only - and the range had been narrowed to the Node 20 line to match it, which pinned the project to a runtime that is now out of support. Naming the file works identically on every supported line, so the runtime no longer has to be narrowed to keep `npm test` working.

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

This runs `node --test tests/server.test.js`, which uses Node's built-in test runner: no additional test dependencies are installed or needed, and the project declares no `devDependencies`. The command names the suite file rather than the `tests/` directory, because a positional directory argument is read as a glob pattern from Node 22 onwards and finds nothing; naming the file behaves the same on every supported line. A second suite file would be named alongside it. The run launches `server.js` as a child process, waits for the startup line shown above, then exercises the running server over real HTTP and checks that:

- `GET /` answers 200 with `text/plain; charset=utf-8` and a body of exactly 14 bytes
- `GET /evening` answers 200 with `text/plain; charset=utf-8` and a body of exactly 12 bytes, with no trailing newline
- neither response carries an `X-Powered-By` header
- an unregistered path answers 404
- the listening socket is bound to loopback only: while `127.0.0.1:3000` is answering, a connection to this host's own non-loopback address on the same port is refused

That last check is the one a request to `127.0.0.1` cannot make, since loopback answers whether the socket is bound to `127.0.0.1` or to every interface, so it dials the addresses outside the binding and requires each to refuse.

Port 3000 must be free before you run the suite, because the server binds that port directly; a process already holding it makes the run fail with an explanatory message instead of hanging. A complete run reports `# pass 5` and `# fail 0` - one result per check above - and `npm test` exits non-zero if any of those contracts drifts.

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
