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
 * Binds and listens for connections on the specified port.
 * The server will be accessible at http://127.0.0.1:3000/
 */
app.listen(port, () => {
  console.log(`Server running at http://127.0.0.1:${port}/`);
});
