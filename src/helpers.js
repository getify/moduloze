"use strict";

var path = require("path");
var fs = require("fs");
var os = require("os");

var T = require("@babel/types");

module.exports.findParentStatement = findParentStatement;
module.exports.isAssignmentTarget = isAssignmentTarget;
module.exports.expandHomeDir = expandHomeDir;
module.exports.addRelativeCurrentDir = addRelativeCurrentDir;
module.exports.splitPath = splitPath;
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

function isAssignmentTarget(path) {
	if (
		T.isProgram(path.node) ||
		T.isStatement(path.node) ||
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

function splitPath(fromPathStr,pathStr) {
	var fromDir = path.resolve(fromPathStr);
	if (!isDirectory(fromDir)) {
		fromDir = path.dirname(fromDir);
	}
	var fullPathStr = path.resolve(fromDir,pathStr);
	var basePath = fullPathStr.substr(0,fromDir.length);
	var relativePath = fullPathStr.substr(fromDir.length + 1);
	return [ basePath, relativePath, ];
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
