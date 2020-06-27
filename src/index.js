"use strict";

var buildUMD = require("./umd.js");
var buildESM = require("./esm.js");

module.exports = build;
module.exports.defaultLibConfig = defaultLibConfig;

function build(config,pathStr,code,depMap = {}) {
	config = defaultLibConfig(config);

	var output = {};

	if (config.buildESM) {
		output.esm = buildESM(config,pathStr,code,depMap);
	}
	if (config.buildUMD) {
		output.umd = buildUMD(config,pathStr,code,depMap);
	}

	return output;
}

function defaultLibConfig({
	// ..
	...other
} = {}) {
	return {
		// ..
		...other,
	};
}
