
const http = require("node:http");

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8"
  });

  res.end(`
    <!doctype html>
    <html lang="en">
      <head><meta charset="utf-8"><title>OpenCode Hostinger Test</title></head>
      <body>
        <h1>Node.js is working!</h1>
        <p>This is a deployment test on Hostinger.</p>
      </body>
    </html>
  `);
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, "0.0.0.0", () => {
  console.log("Test app is running on port " + port);
});
