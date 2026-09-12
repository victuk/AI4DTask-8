const fs = require('fs');
module.exports = { log: (event, data) => fs.appendFileSync('audit.log', JSON.stringify({ event, data, ts: Date.now() }) + '\n') };
