# hao-backprop-test

A simple Node.js Hello World server built with Express.js framework.

## Description

This project demonstrates a basic HTTP server using Express.js with multiple endpoints. Originally created for backprop integration testing.

## Prerequisites

- Node.js `^20.20.2 || >=22.12.0` (20.20.2 or later on the 20.x line, or 22.12.0 or later) - enforced by the `engines` field in `package.json` and pinned for version managers in `.nvmrc`
- npm 10 or higher (`>=10.0.0`)

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

The listening socket is bound to the loopback interface (`127.0.0.1`) only, so
the server answers requests from this machine and from nowhere else - a
request sent to any of the machine's other addresses is refused. That is
deliberate: loopback-only binding keeps network exposure to a minimum. The
host and port are hardcoded constants in `server.js`.

## Testing

Run the test suite:

```bash
npm test
```

The suite lives in `tests/server.test.js` and runs on Node's built-in test
runner (`node --test`), so it needs no additional dependencies - this project
declares no `devDependencies` and `express` remains its only dependency. It
starts the server as a child process and drives it over real HTTP, checking
both endpoint contracts below, the absence of the framework's `X-Powered-By`
header, and the 404 fallback. It reports 4 passing tests and 0 failures.

## API Endpoints

| Endpoint | Method | Response |
|----------|--------|----------|
| `/` | GET | `Hello, World!\n` - 14 bytes, trailing newline included |
| `/evening` | GET | `Good evening` - 12 bytes, no trailing newline |

Both endpoints answer with HTTP status `200` and
`Content-Type: text/plain; charset=utf-8`. The two bodies differ by exactly
one byte that terminal output hides: `/` ends with a newline, `/evening` does
not. No `X-Powered-By` header is sent, because `server.js` disables it. Any
other path falls through to Express's default handler and returns `404`.

### Examples

**Hello World Endpoint:**
```bash
curl http://127.0.0.1:3000/
```
Response: `Hello, World!\n` (14 bytes, trailing newline included)

**Good Evening Endpoint:**
```bash
curl http://127.0.0.1:3000/evening
```
Response: `Good evening` (12 bytes, no trailing newline)

## License

MIT
