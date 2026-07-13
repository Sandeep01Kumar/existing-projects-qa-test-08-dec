/**
 * Express.js Server Implementation
 * 
 * This server provides two HTTP endpoints:
 * - GET / : Returns "Hello, World!\n" (original functionality preserved)
 * - GET /evening : Returns "Good evening" (new endpoint)
 * 
 * The server listens on port 3000 by default.
 * 
 * @requires express - Web application framework for HTTP server and routing
 */

const express = require('express');

// Create Express application instance
const app = express();

// Server configuration
const port = 3000;

/**
 * GET / - Hello World endpoint
 * Returns a plain text greeting message.
 * This preserves the original functionality from the http module implementation.
 * 
 * @route GET /
 * @returns {string} "Hello, World!\n" with Content-Type: text/plain
 */
app.get('/', (req, res) => {
  res.type('text/plain').send('Hello, World!\n');
});

/**
 * GET /evening - Good Evening endpoint
 * Returns a plain text evening greeting message.
 * This is a new endpoint added as part of the Express.js migration.
 * 
 * @route GET /evening
 * @returns {string} "Good evening" with Content-Type: text/plain
 */
app.get('/evening', (req, res) => {
  res.type('text/plain').send('Good evening');
});

/**
 * Start the Express server
 * Binds and listens for connections on the specified port, restricted to the
 * 127.0.0.1 loopback interface. The explicit host argument preserves the
 * original server's loopback-only network surface (AAP IR-4) and must not be
 * removed: omitting it makes Express bind all interfaces (the IPv6 wildcard
 * "::"), which would expose the service beyond the loopback boundary.
 * The server will be accessible at http://127.0.0.1:3000/
 *
 * The listener reference is retained so its lifecycle events can be handled
 * explicitly. The startup confirmation is logged from the 'listening' event
 * (which fires only after the socket has successfully bound) rather than from
 * the listen() callback, because Express 5 still invokes that callback even
 * when the underlying bind fails - logging there would print a misleading
 * "Server running" line on a failed start.
 */
const server = app.listen(port, '127.0.0.1');

/**
 * Startup confirmation.
 * Emitted only on a genuinely successful bind, preserving the exact startup log
 * text `Server running at http://127.0.0.1:3000/` (AAP IR-4 / AC-2).
 */
server.on('listening', () => {
  console.log(`Server running at http://127.0.0.1:${port}/`);
});

/**
 * Listener error handler.
 * Without this handler an unhealthy startup - most notably a port collision -
 * would be silently swallowed: the process would exit 0 while the port is
 * actually held by another instance, masking the failure from operators and
 * scripts. Handling the 'error' event restores loud, non-zero failure semantics
 * (matching the original native-http baseline). A port-already-in-use condition
 * (EADDRINUSE) prints a clear message and exits with a non-zero status code;
 * any other listener error is re-thrown so it is never hidden. This never
 * displaces an already-running instance - the OS rejects the duplicate bind -
 * so the running service's integrity is always preserved.
 *
 * @param {NodeJS.ErrnoException} err - The error emitted by the HTTP listener.
 */
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use.`);
    process.exit(1);
  }
  throw err;
});
