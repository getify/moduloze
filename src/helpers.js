"use strict";

var path = require("path");
var fs = require("fs");
var os = require("os");

var T = require("@babel/types");

module.exports.findParentStatement = findParentStatement;
module.exports.isFunction = isFunction;
module.exports.isAssignmentTarget = isAssignmentTarget;
module.exports.expandHomeDir = expandHomeDir;
module.exports.addRelativeCurrentDir = addRelativeCurrentDir;
module.exports.rootRelativePath = rootRelativePath;
module.exports.qualifyDepPaths = qualifyDepPaths;
module.exports.isPathBasedSpecifier = isPathBasedSpecifier;
module.exports.isDirectory = isDirectory;
module.exports.checkPath = checkPath;
module.exports.generateName = generateName;


// ******************************

var HOMEPATH = os.homedir();
var generatedNames = {};

function findParentStatement(path) {
	if (T.isProgram(path.node)) {
		return null;
	}
	else if (T.isStatement(path.node)) {
		return path;
	}
	else {
		return findParentStatement(path.parentPath);
	}
}

function isFunction(path) {
	return T.isFunctionDeclaration(path.node) || T.isFunctionExpression(path.node);
}

function isAssignmentTarget(path) {
	if (
		T.isProgram(path.node) ||
		T.isStatement(path.node) ||
		isFunction(path) ||
		T.isAssignmentPattern(path.node)
	) {
		return false;
	}
	else if (T.isAssignmentExpression(path.parent)) {
		return (path.parent.left == path.node);
	}
	else {
		return isAssignmentTarget(path.parentPath);
	}
}

function expandHomeDir(pathStr) {
	if (pathStr[0] == "~" && (pathStr.length == 1 || pathStr[1] == "/")) {
		pathStr = pathStr.replace(/^~/,HOMEPATH);
	}
	return pathStr;
}

function addRelativeCurrentDir(pathStr) {
	return (
		(
			!path.isAbsolute(pathStr) &&
			!/^(?:(?:\.+[/\\]+)|(?:~(?:[/\\].*)$))/.test(pathStr)
		) ?
			`./${ pathStr }` :
			pathStr
	);
}

function rootRelativePath(rootFromPathStr,pathStr) {
	var absolutePathStr = path.resolve(rootFromPathStr,pathStr);
	return path.relative(rootFromPathStr,absolutePathStr);
}

function qualifyDepPaths(depMap,rootFromPathStr) {
	var depNames = new Set();
	var retMap = {};
	for (let [depPathStr,depName] of Object.entries(depMap)) {
		if (!depNames.has(depName)) {
			depNames.add(depName);
			let absoluteDepPathStr = path.resolve(rootFromPathStr,expandHomeDir(depPathStr));
			let relativeDepPathStr = rootRelativePath(rootFromPathStr,absoluteDepPathStr);
			retMap[relativeDepPathStr] = depName;
		}
		else {
			throw new Error(`Dependency-map name conflict: ${depName}`);
		}
	}
	return retMap;
}

function isPathBasedSpecifier(specifier) {
	return (
		/^(\.{0,2}|([a-z]+:)|~)[\/\\]/i.test(specifier) &&
		/\.[a-z]+$/.test(specifier)
	);
}

function isDirectory(pathStr) {
	return checkPath(pathStr) && fs.lstatSync(pathStr).isDirectory();
}

function checkPath(pathStr) {
	return fs.existsSync(pathStr);
}

function generateName() {
	do {
		var name = `Mz_${ Math.round(Math.random() * 1E9) }`;
	}
	while (name in generatedNames);
	generatedNames[name] = true;
	return name;
}
