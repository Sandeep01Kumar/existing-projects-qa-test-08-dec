/**
 * @fileoverview Express.js "Hello World" HTTP server exposing two plain-text GET endpoints.
 *
 * Express.js Server Implementation
 * 
 * This server provides two HTTP endpoints:
 * - GET / : Returns "Hello, World!\n" (original functionality preserved)
 * - GET /evening : Returns "Good evening" (new endpoint)
 * 
 * The server listens on port 3000 by default. The host argument is omitted from the
 * app.listen() call, so binding is not restricted to a specific interface; 127.0.0.1
 * appears only in the local URL printed by the startup log.
 * 
 * @module server
 * @requires express - Web application framework for HTTP server and routing
 */

const express = require('express');

/**
 * The Express application instance used to register routes and handle incoming HTTP requests.
 * @const {express.Application}
 */
const app = express();

/**
 * The hardcoded TCP port on which the HTTP server listens for incoming connections.
 * @const {number}
 */
const port = 3000;

/**
 * GET / - Hello World endpoint
 * Returns a plain text greeting message.
 * This preserves the original functionality from the http module implementation.
 * 
 * @route GET /
 * @param {express.Request} req - The incoming HTTP request object.
 * @param {express.Response} res - The outgoing HTTP response object.
 * @returns {void} Sends "Hello, World!\n" as plain text with Content-Type: text/plain; charset=utf-8.
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
 * @param {express.Request} req - The incoming HTTP request object.
 * @param {express.Response} res - The outgoing HTTP response object.
 * @returns {void} Sends "Good evening" as plain text with Content-Type: text/plain; charset=utf-8.
 */
app.get('/evening', (req, res) => {
  res.type('text/plain').send('Good evening');
});

/**
 * Start the Express server
 * Binds and listens for connections on the specified port (3000). No host argument
 * is passed to app.listen(), so the server is not explicitly bound to a specific
 * interface. The URL http://127.0.0.1:3000/ shown below is only the local address
 * printed by the startup log, not an enforced bind host.
 *
 * @returns {void}
 */
app.listen(port, () => {
  console.log(`Server running at http://127.0.0.1:${port}/`);
});
