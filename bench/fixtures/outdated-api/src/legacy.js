const fs = require("fs");

function encode(text) {
  return new Buffer(text).toString("base64");
}

function readConfig(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

module.exports = { encode, readConfig };
