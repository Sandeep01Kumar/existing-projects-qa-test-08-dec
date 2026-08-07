/**
 * Express.js Server Implementation
 * 
 * This server provides two HTTP endpoints:
 * - GET / : Returns "Hello, World!\n" (original functionality preserved)
 * - GET /evening : Returns "Good evening" (new endpoint)
 * 
 * The server listens on port 3000 and binds to the loopback interface
 * (127.0.0.1) only, so it is reachable from this machine and is not exposed
 * on any other network interface.
 * 
 * @requires express - Web application framework for HTTP server and routing
 */

const express = require('express'); // Load the Express framework, which supplies the routing and response helpers this server is built on

const app = express(); // Create the Express application instance that owns the route table and framework settings
app.disable('x-powered-by'); // Turn off Express's default "X-Powered-By" header so the framework is not advertised

const host = '127.0.0.1'; // Bind to the loopback interface only, keeping the tutorial server off the network
const port = 3000; // Serve on the fixed tutorial port 3000; configuration stays hardcoded rather than read from the environment

/**
 * GET / - Hello World endpoint
 * Returns a plain text greeting message.
 * This preserves the original functionality from the http module implementation.
 * 
 * @route GET /
 * @returns {string} "Hello, World!\n" with Content-Type: text/plain
 */
app.get('/', (req, res) => { // Register the original greeting route on the root path so existing clients keep working unchanged
  res.type('text/plain').send('Hello, World!\n'); // Set Content-Type to text/plain and send the original 14-byte greeting, newline included
}); // Close the root route handler; the single response above completes the request

/**
 * GET /evening - Good Evening endpoint
 * Returns a plain text evening greeting message.
 * This is a new endpoint added as part of the Express.js migration.
 * 
 * @route GET /evening
 * @returns {string} "Good evening" with Content-Type: text/plain
 */
app.get('/evening', (req, res) => { // Register the second GET route this feature adds, served at the /evening path
  res.type('text/plain').send('Good evening'); // Set Content-Type to text/plain and send the exact 12-byte greeting, deliberately with no trailing newline
}); // Close the /evening route handler; the single response above completes the request

/**
 * Start the Express server
 * Binds and listens for connections on the configured host and port. The host
 * is passed as the second argument so that Express forwards it to Node's
 * http.Server#listen while still treating the final argument as the callback.
 * The server will be accessible at http://127.0.0.1:3000/ and, because the
 * socket is bound to the loopback address, nowhere else.
 */
app.listen(port, host, () => { // Bind the listening socket to the loopback host and port, then run the ready callback
  console.log(`Server running at http://${host}:${port}/`); // Announce readiness on stdout; automated checks match this exact line as their startup signal
}); // Close the listen callback; the process now stays alive serving requests
