// Vercel serverless entrypoint: wraps the whole Express app from server.js
// (routes, CORS, dynamic /play|/artist|/album meta injection, proxy-audio
// streaming, and static file serving) into a single function.
module.exports = require('../server.js');
