"use strict";

var T = require("@babel/types");
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


// ******************************

function build(config,pathStr,code,depMap) {
	var {
		programAST,
		programPath,
		convertRequires,
		convertExports,
	} = identifyRequiresAndExports(pathStr,code);

	// convert all requires to ESM imports
	for (let req of convertRequires) {
		// normalize dependency path
		let [ , origSpecifierPath, ] = splitPath(config.from,req.specifier);
		let specifierPath = addRelativeCurrentDir(origSpecifierPath);
		if (!(specifierPath in depMap)) {
			specifierPath = origSpecifierPath;
		}
		if (config[".mjs"]) {
			specifierPath = specifierPath.replace(/\.js$/,".mjs");
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
						T.ImportDefaultSpecifier(T.Identifier(req.binding.target)),
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
						T.ImportDefaultSpecifier(T.Identifier(req.binding.uniqueTarget)),
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
				...assignments
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
