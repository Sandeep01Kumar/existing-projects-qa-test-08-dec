/**
 * Express.js Server Implementation
 *
 * Serves two plain-text HTTP endpoints on 127.0.0.1:3000:
 * - GET /        sends "Hello, World!\n" - 14 bytes, trailing newline included
 * - GET /evening sends "Good evening" - 12 bytes, no trailing newline
 *
 * The listening socket is bound to the loopback address only, so the server
 * accepts connections from this host and from no other network interface.
 *
 * @requires express - Web application framework for HTTP server and routing
 */

const express = require('express'); // Load Express, the project's only declared direct dependency, to provide HTTP routing and response helpers

const app = express(); // Create the Express application instance that owns the route table, the framework settings and the request pipeline
app.disable('x-powered-by'); // Turn off Express's default "X-Powered-By" header so the framework is not advertised to clients

const host = '127.0.0.1'; // Bind only to loopback so connections are accepted from this host, not from non-loopback interfaces
const port = 3000; // Serve on the fixed tutorial port 3000 that the README and the startup log below advertise; configuration stays hardcoded rather than read from the environment

/**
 * GET / - Hello World endpoint
 * Sends a plain-text greeting whose body is 14 bytes and ends in a newline.
 *
 * @route GET /
 * @returns {void} Sends HTTP 200 with Content-Type: text/plain; charset=utf-8 and body "Hello, World!\n".
 */
app.get('/', (req, res) => { // Register GET / so root-path requests are dispatched to the greeting handler
  res.type('text/plain').send('Hello, World!\n'); // Set Content-Type to text/plain and send the exact 14-byte greeting, trailing newline included
}); // Close the root route handler, completing its registration on the router; the single response above completes the request

/**
 * GET /evening - Good Evening endpoint
 * Sends a plain-text evening greeting whose body is 12 bytes and has no newline.
 *
 * @route GET /evening
 * @returns {void} Sends HTTP 200 with Content-Type: text/plain; charset=utf-8 and body "Good evening".
 */
app.get('/evening', (req, res) => { // Register GET /evening so that path is dispatched to the evening-greeting handler
  res.type('text/plain').send('Good evening'); // Set Content-Type to text/plain and send the exact 12-byte greeting, deliberately with no trailing newline
}); // Close the /evening route handler, completing its registration on the router; the single response above completes the request

/**
 * Start the Express server
 * Binds and listens for connections on the configured host and port. The host
 * is passed as the second argument so that Express forwards it to Node's
 * http.Server#listen while still treating the final argument as the callback.
 * The server will be accessible at http://127.0.0.1:3000/ and, because the
 * socket is bound to the loopback address, nowhere else.
 *
 * Express installs the callback given here as the listening socket's 'error'
 * handler as well as its ready notification, so a bind failure such as
 * EADDRINUSE is handed to this callback as an Error instead of being thrown.
 * The callback therefore inspects that argument before anything else: readiness
 * is announced only once the socket is genuinely bound, and a failed bind is
 * reported on stderr with a non-zero exit status rather than a success line the
 * server cannot honour.
 */
app.listen(port, host, (error) => { // Bind the listening socket to the loopback host and port, keeping the callback last as Express requires; Express also installs this callback as the socket's error handler, so it receives any bind failure here
  if (error) { // A bind error such as EADDRINUSE means this server has no listening socket, so readiness must not be reported
    console.error(`Failed to start server at http://${host}:${port}/: ${error.message}`); // Report the real cause on stderr, leaving stdout free of the readiness line that operators and automated checks treat as the startup signal
    process.exitCode = 1; // Exit non-zero so callers, npm scripts and automation see a failed start instead of a silent success
    return; // Stop here so the readiness log below can never follow a bind that did not succeed
  } // Close the failure branch; everything below it runs only when the socket is genuinely bound
  console.log(`Server running at http://${host}:${port}/`); // Announce readiness on stdout with the exact address the server is reachable at; automated checks match this exact line as their startup signal
}); // Close the listen call; the process now stays alive serving requests
