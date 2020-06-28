"use strict";

var path = require("path");
var fs = require("fs");

var dotenv = require("dotenv");
var micromatch = require("micromatch");
var minimist = require("minimist");
var mkdirp = require("mkdirp");
var recursiveReadDir = require("recursive-readdir-sync");

var build = require("./index.js");
var { bundleUMD, } = require("./index.js");
var { defaultLibConfig, } = require("./index.js");
var {
	expandHomeDir,
	addRelativeCurrentDir,
	splitPath,
	isDirectory,
	checkPath,
	generateName,
} = require("./helpers.js");

dotenv.config();

var params = minimist(process.argv.slice(2),{
	boolean: [ "help","build-esm","build-umd","recursive", ],
	string: [ "config","from","to", ],
	alias: {
		"recursive": "r",
		"build-esm": "e",
		"build-umd": "u",
		"dep-map": "m",
	},
	default: {
		help: false,
		recursive: false,
		"build-esm": false,
		"build-umd": false,
		"config": process.env.RCPATH,
		"from": process.env.FROMPATH,
		"to": process.env.TOPATH,
	},
});
var RCPATH = resolvePath(params.config || "./.mzrc");
var FROMPATH = resolvePath(params.from || "./");
var TOPATH = resolvePath(params.to || "./.mz-build");
var UMDMAPPATH = resolvePath(params["dep-map"] || "./package.json");

// initial CLI-config before reading from rc
var config = defaultCLIConfig();

module.exports = CLI;


// ******************************

function CLI() {
	if (!loadConfig()) {
		return;
	}

	// populate known-dependencies map from configuration (if any)
	var knownDeps = {};
	if (config.depMap) {
		for (let [ depPath, depName, ] of Object.entries(config.depMap)) {
			let [ , relativePath, ] = splitPath(config.from,depPath);
			relativePath = addRelativeCurrentDir(relativePath);
			knownDeps[relativePath] =
				(typeof depName == "string" && depName != "") ? depName : generateName();
		}
	}

	// add discovered input files to known-depenedencies map
	var inputFiles = getInputFiles();
	for (let [ , relativePath, ] of inputFiles) {
		if (!(relativePath in knownDeps)) {
			knownDeps[relativePath] = generateName();
		}
	}

	var umdBuilds = [];

	// build each file (for each format)
	for (let [ basePath, relativePath, ] of inputFiles) {
		let code = fs.readFileSync(path.join(basePath,relativePath),"utf-8");
		let res = build(config,relativePath,code,knownDeps);

		// save UMD build so we can later bundle all UMDs together
		if (res.umd) {
			umdBuilds.push(res.umd);
		}

		// process each output format
		for (let format of [ "esm", "umd", ]) {
			if (res[format]) {
				let outputPath = path.join(config.to,format,relativePath);
				if (format == "esm" && config[".mjs"]) {
					outputPath = outputPath.replace(/\.js$/,".mjs");
				}
				let outputDir = path.dirname(outputPath);
				if (!checkPath(outputDir)) {
					mkdirp.sync(outputDir);
					if (!checkPath(outputDir)) {
						return showError(`Output directory (${ outputDir }) could not be created.`);
					}
				}
				try {
					fs.writeFileSync(outputPath,res[format].code,"utf-8");
				}
				catch (err) {
					return showError(`Output file (${ outputPath }) could not be created.`);
				}
			}
		}
	}

	// need to bundle the UMDs together?
	if (umdBuilds.length > 0) {
		let res = bundleUMD(umdBuilds);
		let outputPath = path.join(config.to,"umd","bundle.js");
		try {
			fs.writeFileSync(outputPath,res.code,"utf-8");
		}
		catch (err) {
			return showError(`UMD Bundle (${ outputPath }) could not be created.`);
		}
	}
}

function loadConfig() {
	var cfg;

	try {
		cfg = fs.readFileSync(config.rc,"utf-8");
	}
	catch (err) {
		// no config found/available
		cfg = "";
	}

	try {
		cfg = JSON.parse(cfg);
	}
	catch (err) {
		// config was invalid
		if (!params.help) {
			return showError(`Invalid config: ${RCPATH}`,/*includeHelp=*/true);
		}
	}

	// merge in default configs for core and lib
	cfg = defaultCLIConfig(cfg);
	config = defaultLibConfig(cfg);

	return checkArgsAndConfig();
}

function checkArgsAndConfig() {
	// user asking for help output?
	if (params.help) {
		printHelp();
		return;
	}

	// check for required arg(s)
	if (!(
		config.buildESM || config.buildUMD
	)) {
		return showError("Must select at least one output format (ESM or UMD).",/*includeHelp=*/true);
	}
	else if (config.buildUMD && !("depMap" in config)) {
		return showError("UMD build format requires dependency map.",/*includeHelp=*/true);
	}

	// from path invalid?
	if (!checkPath(config.from)) {
		return showError(`Input directory (${ config.from }) is missing or inaccessible.`);
	}
	// to path invalid?
	if (!checkPath(config.to)) {
		// should we create the default output target directory?
		if (/\.mz-build$/.test(config.to)) {
			mkdirp.sync(config.to);
			// double-check the path was created?
			if (!checkPath(config.to)) {
				return showError(`Default output directory (${ config.to }) could not be created.`);
			}
		}
		else {
			return showError(`Output directory (${ config.to }) is missing or inaccessible.`);
		}

		if (config.buildESM) {
			let esmPath = path.join(config.to,"esm");
			if (!checkPath(esmPath)) {
				mkdirp.sync(esmPath);
				if (!checkPath(esmPath)) {
					return showError(`Output directory (${ esmPath }) could not be created.`);
				}
			}
		}
		if (config.buildUMD) {
			let umdPath = path.join(config.to,"umd");
			if (!checkPath(umdPath)) {
				mkdirp.sync(umdPath);
				if (!checkPath(umdPath)) {
					return showError(`Output directory (${ umdPath }) could not be created.`);
				}
			}
		}
	}
	if (
		// targeting UMD build format?
		config.buildUMD &&
		// path specified to UMD dependency map?
		typeof config.depMap == "string"
	) {
		// path is invalid?
		if (!checkPath(config.depMap)) {
			return showError(`Dependency map (${ config.depMap }) is missing or inaccessible.`);
		}

		// load UMD dependency map
		let json;
		try {
			json = JSON.parse(fs.readFileSync(config.depMap,"utf-8"));
			// need to find config in a package.json?
			if (/package\.json$/.test(config.depMap)) {
				json = json["mz-dependencies"];
				// "mz-config" key is missing or not an object?
				if (!json || typeof json != "object") {
					throw true;
				}
			}
		}
		catch (err) {
			return showError(`Invalid dependency map (${ config.depMap }).`);
		}
		config.depMap = json;
	}

	return true;
}

function getInputFiles() {
	var files;

	// scan the directory for input files?
	if (isDirectory(config.from)) {
		if (config.recursive) {
			try {
				files = recursiveReadDir(config.from);
			}
			catch (err) {
				return showError(`Failed scanning for input files (${ config.from })`);
				return;
			}
		}
		else {
			files =
				fs.readdirSync(config.from)
				.filter(function skipDirs(pathStr){
					return !isDirectory(pathStr);
				})
		}
	}
	// otherwise, assume only a single input file
	else {
		files = [ config.from, ];
	}

	// any skip patterns to remove?
	if (config.skip && Array.isArray(config.skip)) {
		files = files.filter(function skipFiles(pathStr){
			return micromatch(pathStr,config.skip).length == 0;
		});
	}

	// split all paths into base and relative
	files = files.map(function fixPaths(pathStr){
		var [ basePath, relativePath, ] = splitPath(config.from,pathStr);
		return [ basePath, addRelativeCurrentDir(relativePath), ];
	});

	return files;
}

function printHelp() {
	console.log("moduloze usage:");
	console.log("  mz {OPTIONS}");
	console.log("");
	console.log("--help                   print this help");
	console.log("--config={PATH}          path to load config");
	console.log(`                         [${ config.rc }]`);
	console.log("--from={PATH}            scan directory for input file(s)");
	console.log(`                         [${ config.from }]`);
	console.log("--to={PATH}              target directory for output file(s)");
	console.log(`                         [${ config.to }]`);
	console.log("--dep-map={PATH}, -m     dependency map file");
	console.log(`                         [${ config.depMap }]`);
	console.log("--recursive, -r          scan recursively for input files");
	console.log("                         [false]");
	console.log("--build-esm, -e          build ES-Modules format from input file(s)");
	console.log("                         [false]");
	console.log("--build-umd, -u          build UMD format from input file(s)");
	console.log("                         [false]");
	console.log("");
}

function showError(err,includeHelp = false) {
	console.error(err.toString());
	if (includeHelp) {
		console.log("");
		printHelp();
	}
	process.exit(1);
}

function defaultCLIConfig({
	rc = RCPATH,
	from = FROMPATH,
	to = TOPATH,
	depMap = UMDMAPPATH,
	recursive,
	buildESM,
	buildUMD,
	...other
} = {}) {
	// params override configs
	rc = (rc !== "") ? resolvePath(params.config || rc) : RCPATH;
	from = (from !== "") ? resolvePath(params.from || from) : FROMPATH;
	to = (to !== "") ? resolvePath(params.to || to) : TOPATH;
	depMap = ("dep-map" in params || typeof depMap == "string") ? resolvePath(params["dep-map"] || depMap) : depMap;
	recursive = params.recursive || recursive;
	buildESM = params["build-esm"] || buildESM;
	buildUMD = params["build-umd"] || buildUMD;

	return { rc, from, to, recursive, buildESM, buildUMD, depMap, ...other, };
}

function resolvePath(pathStr) {
	pathStr = expandHomeDir(pathStr);
	return path.resolve(process.cwd(),pathStr);
}
