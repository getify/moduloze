"use strict";

var path = require("path");

var {
	expandHomeDir,
	qualifyDepPaths,
	isDirectory,
} = require("./helpers.js");

var buildUMD = require("./umd.js");
var { bundle: bundleUMD, index: umdIndex, } = require("./umd.js");
var buildESM = require("./esm.js");
var { index: esmIndex, } = require("./esm.js");

module.exports = build;
module.exports.build = build;
module.exports.defaultLibConfig = defaultLibConfig;
module.exports.bundleUMD = bundleUMD;
module.exports.umdIndex = umdIndex;
module.exports.esmIndex = esmIndex;

function build(config,pathStr,code,depMap = {}) {
	config = defaultLibConfig(config);

	var absoluteFromPathStr = path.resolve(expandHomeDir(config.from));
	var absoluteFromDirStr = (
		isDirectory(absoluteFromPathStr) ?
			absoluteFromPathStr :
			path.dirname(absoluteFromPathStr)
	);
	config.from = absoluteFromDirStr;

	depMap = qualifyDepPaths(depMap,absoluteFromDirStr);

	var output = {};

	if (config.buildUMD) {
		output.umd = buildUMD(config,pathStr,code,depMap);
		// save updated depMap
		depMap = output.umd.depMap;
	}
	if (config.buildESM) {
		output.esm = buildESM(config,pathStr,code,depMap);
		// save updated depMap
		depMap = output.esm.depMap;
	}

	return output;
}

function defaultLibConfig({
	ignoreUnknownDependency = false,
	ignoreCircularDependency = false,
	".mjs": renameMJS = false,
	".cjs": renameCJS = false,
	namespaceImport = false,
	namespaceExport = false,
	exportDefaultFrom = false,
	from = "",
	...otherConfig
} = {}) {
	return {
		ignoreUnknownDependency,
		ignoreCircularDependency,
		".mjs": renameMJS,
		".cjs": renameCJS,
		namespaceImport,
		namespaceExport,
		exportDefaultFrom,
		from,
		...otherConfig,
	};
}
