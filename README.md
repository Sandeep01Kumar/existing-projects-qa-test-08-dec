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

## API Endpoints

| Endpoint | Method | Response |
|----------|--------|----------|
| `/` | GET | Returns "Hello, World!" |
| `/evening` | GET | Returns "Good evening" |

### Examples

**Hello World Endpoint:**
```bash
curl http://127.0.0.1:3000/
```
Response: `Hello, World!`

**Good Evening Endpoint:**
```bash
curl http://127.0.0.1:3000/evening
```
Response: `Good evening`

## License

MIT
