# hao-backprop-test

A simple Node.js Hello World server built with Express.js framework.

## Description

This project demonstrates a basic HTTP server using Express.js with multiple endpoints. Originally created for backprop integration testing.

## Prerequisites

- Node.js 20.20.2 or newer on the Node 20 line (`^20.20.2`) - declared in the `engines` field of `package.json`, and pinned for version managers by `.nvmrc`, which selects `20.20.2`
- npm 10 or higher (`>=10.0.0`) - declared in the same `engines` field

`20.20.2` is the runtime this project is built and verified against, and it is the newest 20.x release. The range is written as `^20.20.2` - that is, 20.20.2 up to but not including 21.0.0 - rather than as an open `>=` bound, because `npm test` finds its suite by naming the `tests/` directory, and treating a positional argument as a directory to search is part of the Node 20 test runner's contract. Node 22 changed the same argument to mean a glob pattern, so `node --test tests/` does not locate the suite there. Bounding the range to the line the test command actually works on keeps the manifest from advertising support this project cannot honour.

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

This runs `node --test tests/`, which uses Node's built-in test runner: no additional test dependencies are installed or needed, and the project declares no `devDependencies`. Naming the `tests/` directory lets the runner discover the suite inside it, which is the single file `tests/server.test.js`; adding another `*.test.js` file to that directory is enough to include it, with no change to the command. It launches `server.js` as a child process, waits for the startup line shown above, then exercises the running server over real HTTP and checks that:

- `GET /` answers 200 with `text/plain; charset=utf-8` and a body of exactly 14 bytes
- `GET /evening` answers 200 with `text/plain; charset=utf-8` and a body of exactly 12 bytes, with no trailing newline
- neither response carries an `X-Powered-By` header
- an unregistered path answers 404

Port 3000 must be free before you run the suite, because the server binds that port directly; a process already holding it makes the run fail with an explanatory message instead of hanging. A complete run reports `# pass 4` and `# fail 0` - one result per check above - and `npm test` exits non-zero if any of those contracts drifts.

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
