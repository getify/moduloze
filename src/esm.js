"use strict";

var T = require("@babel/types");
var { default: template, } = require("@babel/template");
var { default: generate, } = require("@babel/generator");

var {
	expandHomeDir,
	addRelativeCurrentDir,
	splitPath,
	generateName,
} = require("./helpers.js");
var {
	identifyRequiresAndExports,
	analyzeRequires,
	analyzeExports,
} = require("./analysis.js");

module.exports = build;
module.exports.build = build;
module.exports.index = index;


// ******************************

function build(config,pathStr,code,depMap) {
	var {
		programAST,
		programPath,
		convertRequires,
		convertExports,
	} = identifyRequiresAndExports(pathStr,code);

	// find any combo statements that have both a require and an export in it
	var stmts = new Map();
	var convertCombos = new Map();
	for (let [ idx, req, ] of convertRequires.entries()) {
		if (!stmts.has(req.context.statement)) {
			stmts.set(req.context.statement,{ reqIdxs: [], reqs: [], });
		}
		let entry = stmts.get(req.context.statement);
		entry.reqIdxs.push(idx);
		entry.reqs.push(req);
	}
	for (let [ idx, expt, ] of convertExports.entries()) {
		// found a combo statement?
		if (stmts.has(expt.context.statement)) {
			let { reqIdxs, reqs, } = stmts.get(expt.context.statement);

			// remove original export entry
			convertExports.splice(idx,1);

			// remove original require entry/entries
			convertRequires = convertRequires.filter((entry,idx) => !reqIdxs.includes(idx));

			if (!convertCombos.has(expt.context.statement)) {
				convertCombos.set(expt.context.statement,{
					requires: [ ...reqs, ],
					exports: [],
				});
			}
			convertCombos.get(expt.context.statement).exports.push(expt);
		}
	}

	// convert all combo require/export statements
	for (let [ stmt, combo, ] of convertCombos.entries()) {
		let req = combo.requires[0];
		// normalize dependency path
		let [ , origSpecifierPath, ] = splitPath(config.from,req.specifier);
		let specifierPath = addRelativeCurrentDir(origSpecifierPath);
		if (!(specifierPath in depMap)) {
			specifierPath = origSpecifierPath;
		}
		if (config[".mjs"]) {
			specifierPath = specifierPath.replace(/\.c?js$/,".mjs");
		}

		let expt = combo.exports[0];

		// combined form? export { x [as y] } from ".."
		if (
			(
				req.esmType == "default-import-indirect" ||
				req.esmType == "named-import-indirect"
			) &&
			(
				expt.esmType == "named-declaration-export" ||
				expt.esmType == "destructured-declaration-export"
			)
		) {
			stmt.replaceWith(
				T.ExportNamedDeclaration(
					null,
					[
						T.ExportSpecifier(
							T.Identifier(req.binding.source),
							T.Identifier(expt.binding.target)
						),
					],
					T.StringLiteral(specifierPath)
				)
			);
		}
		// default indirect? import * as x + export default x
		else if (
			req.esmType == "default-import-indirect" &&
			expt.esmType == "default-export"
		) {
			let importTarget = T.Identifier(req.binding.uniqueTarget);

			stmt.replaceWithMultiple([
				T.ImportDeclaration(
					[
						// import * as x from .. ?
						(config.namespaceImport ?
							T.ImportNamespaceSpecifier(importTarget) :
							// otherwise, import x from ..
							T.ImportDefaultSpecifier(importTarget)
						),
					],
					T.StringLiteral(specifierPath)
				),
				T.ExportDefaultDeclaration(importTarget)
			]);
		}
		// otherwise, named indirect: import { x [as y] } + export { y }
		else {
			let importTarget = T.Identifier(req.binding.uniqueTarget);

			stmt.replaceWithMultiple([
				T.ImportDeclaration(
					[
						T.ImportSpecifier(
							importTarget,
							T.Identifier(req.binding.source)
						),
					],
					T.StringLiteral(specifierPath)
				),
				T.ExportDefaultDeclaration(importTarget),
			]);
		}
	}

	// convert all requires to ESM imports
	for (let req of convertRequires) {
		// normalize dependency path
		let [ , origSpecifierPath, ] = splitPath(config.from,req.specifier);
		let specifierPath = addRelativeCurrentDir(origSpecifierPath);
		if (!(specifierPath in depMap)) {
			specifierPath = origSpecifierPath;
		}
		if (config[".mjs"]) {
			specifierPath = specifierPath.replace(/\.c?js$/,".mjs");
		}

		if (req.esmType == "bare-import") {
			// replace with bare-import statement
			req.context.statement.replaceWith(
				T.ImportDeclaration([],T.StringLiteral(specifierPath))
			);
		}
		else if (req.esmType == "default-import") {
			// replace with default-import statement
			req.context.statement.replaceWith(
				T.ImportDeclaration(
					[
						// import * as x from .. ?
						(config.namespaceImport ?
							T.ImportNamespaceSpecifier(T.Identifier(req.binding.target)) :
							// otherwise, import x from ..
							T.ImportDefaultSpecifier(T.Identifier(req.binding.target))
						),
					],
					T.StringLiteral(specifierPath)
				)
			);
		}
		else if (req.esmType == "named-import") {
			// collect named bindings
			let importBindings = [];
			for (let binding of (Array.isArray(req.binding) ? req.binding : [ req.binding, ])) {
				importBindings.push(
					(binding.source == "default") ?
						T.ImportDefaultSpecifier(T.Identifier(binding.target)) :
						T.ImportSpecifier(
							T.Identifier(binding.target),
							T.Identifier(binding.source)
						)
				);
			}

			// replace with named-import statement
			req.context.statement.replaceWith(
				T.ImportDeclaration(importBindings,T.StringLiteral(specifierPath))
			);
		}
		else if (req.esmType == "default-import-indirect") {
			// replace with...
			req.context.statement.replaceWithMultiple([
				// ...default-import statement
				T.ImportDeclaration(
					[
						(config.namespaceImport ?
							T.ImportNamespaceSpecifier(T.Identifier(req.binding.uniqueTarget)) :
							T.ImportDefaultSpecifier(T.Identifier(req.binding.uniqueTarget))
						),
					],
					T.StringLiteral(specifierPath)
				),
				// ...and indirect target assignment
				T.ExpressionStatement(
					T.AssignmentExpression(
						"=",
						T.Identifier(req.binding.target),
						T.Identifier(req.binding.uniqueTarget)
					)
				),
			]);
		}
		else if (req.esmType == "named-import-indirect") {
			// collect named bindings and indirect target assignments
			let importBindings = [];
			let assignments = [];
			for (let binding of (Array.isArray(req.binding) ? req.binding : [ req.binding, ])) {
				importBindings.push(
					(binding.source == "default") ?
						T.ImportDefaultSpecifier(T.Identifier(binding.uniqueTarget)) :
						T.ImportSpecifier(
							T.Identifier(binding.uniqueTarget),
							T.Identifier(binding.source)
						)
				);
				assignments.push(
					T.ExpressionStatement(
						T.AssignmentExpression(
							"=",
							T.Identifier(binding.target),
							T.Identifier(binding.uniqueTarget)
						)
					)
				);
			}

			// replace with named-import statement and assignments
			req.context.statement.replaceWithMultiple([
				T.ImportDeclaration(importBindings,T.StringLiteral(specifierPath)),
				...assignments,
			]);
		}
	}

	// convert all exports
	for (let expt of convertExports) {
		if (expt.esmType == "default-export") {
			expt.context.statement.replaceWith(
				T.ExportDefaultDeclaration(expt.binding.source)
			);
		}
		else if (expt.esmType == "destructured-declaration-export") {
			expt.context.statement.replaceWith(
				T.ExportNamedDeclaration(
					T.VariableDeclaration(
						"let",
						[
							T.VariableDeclarator(
								T.ObjectPattern([
									T.ObjectProperty(
										T.Identifier(expt.binding.sourceName),
										T.Identifier(expt.binding.target),
										/*computed=*/false,
										/*shorthand=*/(expt.binding.sourceName == expt.binding.target)
									)
								]),
								expt.binding.source
							),
						]
					)
				)
			);
		}
		else if (expt.esmType == "named-declaration-export") {
			expt.context.statement.replaceWithMultiple([
				T.VariableDeclaration(
					"let",
					[
						T.VariableDeclarator(
							T.Identifier(expt.binding.uniqueTarget),
							expt.binding.source
						),
					]
				),
				(
					(expt.binding.target == "default") ?
						T.ExportDefaultDeclaration(T.Identifier(expt.binding.uniqueTarget)) :
						T.ExportNamedDeclaration(
							null,
							[
								T.ExportSpecifier(
									T.Identifier(expt.binding.uniqueTarget),
									T.Identifier(expt.binding.target)
								),
							]
						)
				),
			]);
		}
		else if (expt.esmType == "named-export") {
			expt.context.statement.replaceWith(
				(expt.binding.target == "default") ?
					T.ExportDefaultDeclaration(expt.binding.source) :
					T.ExportNamedDeclaration(
						null,
						[
							T.ExportSpecifier(
								T.Identifier(expt.binding.source),
								T.Identifier(expt.binding.target)
							),
						]
					)
			);
		}
	}

	// remove any strict-mode directive (since ESM is automatically strict-mode)
	programAST.program.directives.length = 0;

	return generate(programAST);
}

function index(config,esmBuilds,depMap) {
	var modulePath = "./index.js";
	var moduleName = depMap[modulePath] || "Index";

	// remove a dependency self-reference (if any)
	depMap = Object.fromEntries(
		Object.entries(depMap).filter(([ dPath, dName ]) => dPath != modulePath)
	);

	if (config[".mjs"]) {
		modulePath = modulePath.replace(/\.c?js$/,".mjs");
	}

	// start with empty program
	var esmAST = T.File(template.program("")());

	var dependencies = Object.entries(depMap);
	for (let [ depPath, depName, ] of dependencies) {
		if (config[".mjs"]) {
			depPath = depPath.replace(/\.c?js$/,".mjs");
		}
		if (config.exportDefaultFrom) {
			esmAST.program.body.push(
				T.ExportNamedDeclaration(
					null,
					[
						T.ExportDefaultSpecifier(T.Identifier(depName)),
					],
					T.StringLiteral(depPath)
				)
			);
		}
		else {
			esmAST.program.body.push(
				T.ImportDeclaration(
					[
						(config.namespaceImport ?
							T.ImportNamespaceSpecifier(T.Identifier(depName)) :
							T.ImportDefaultSpecifier(T.Identifier(depName))
						),
					],
					T.StringLiteral(depPath)
				),
				T.ExportNamedDeclaration(
					null,
					[
						T.ExportSpecifier(
							T.Identifier(depName),
							T.Identifier(depName)
						),
					]
				)
			);
		}
	}

	return { ...generate(esmAST), ast: esmAST, refDeps: depMap, modulePath, moduleName, };
}
