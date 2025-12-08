# Hello World - Node.js Express Server

A simple Node.js HTTP server built with Express.js framework providing two endpoints.

## Description

This is a tutorial-level project demonstrating Express.js server implementation with multiple routes.

## Prerequisites

- Node.js v18 or higher (recommended: v20.x)
- npm package manager

## Installation

```bash
npm install
```

## Usage

Start the server:

```bash
npm start
```

Or directly:

```bash
node server.js
```

The server will start at `http://127.0.0.1:3000/`

## API Endpoints

### GET /

Returns a "Hello, World!" greeting message.

**Response:**
- Status: 200 OK
- Content-Type: text/plain
- Body: `Hello, World!`

### GET /evening

Returns a "Good evening" greeting message.

**Response:**
- Status: 200 OK
- Content-Type: text/plain
- Body: `Good evening`

## Dependencies

- [Express.js](https://expressjs.com/) v5.2.1 - Web application framework

## Author

hxu

## License

MIT
