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

	var [ , origModulePathStr, ] = splitPath(config.from,pathStr);
	var modulePathStr = addRelativeCurrentDir(origModulePathStr);
	var moduleName = depMap[modulePathStr] || depMap[origModulePathStr];

	// handle any file extension renaming, per config
	modulePathStr = renameFileExtension(config,modulePathStr);

	// unknown module?
	if (!moduleName) {
		modulePathStr = origModulePathStr;

		moduleName = generateName();
		depMap[modulePathStr] = moduleName;
	}
	var refDeps = {};
	var $module$exports;
	var defaultExportSet = false;

	// find any combo statements that have both a require and an export in it
	var reqStmts = new Map();
	var convertCombos = new Map();
	for (let [ idx, req, ] of convertRequires.entries()) {
		// substitution requires? can't be part of a combo statement
		if (
			req.esmType == "substitute-named-import-indirect" ||
			req.esmType == "substitute-default-import-indirect"
		) {
			continue;
		}

		if (!reqStmts.has(req.context.statement)) {
			reqStmts.set(req.context.statement,{ reqIdxs: [], reqs: [], });
		}
		let entry = reqStmts.get(req.context.statement);
		entry.reqIdxs.push(idx);
		entry.reqs.push(req);
	}
	for (let [ idx, expt, ] of convertExports.entries()) {
		// found a combo statement?
		if (reqStmts.has(expt.context.statement)) {
			let { reqIdxs, reqs, } = reqStmts.get(expt.context.statement);

			// unsert original require entries
			for (let reqIdx of reqIdxs) {
				convertRequires[reqIdx] = false;
			}

			// unset original export entry
			convertExports[idx] = false;

			if (!convertCombos.has(expt.context.statement)) {
				convertCombos.set(expt.context.statement,{
					requires: [ ...reqs, ],
					exports: [],
				});
			}
			convertCombos.get(expt.context.statement).exports.push(expt);
		}
	}
	// remove unset require/export entries (from combos)
	convertRequires = convertRequires.filter(Boolean);
	convertExports = convertExports.filter(Boolean);

	// convert all combo require/export statements
	for (let [ stmt, combo, ] of convertCombos.entries()) {
		let req = combo.requires[0];
		// normalize dependency path
		let [ , origSpecifierPath, ] = splitPath(config.from,expandHomeDir(req.specifier));
		let specifierPath = addRelativeCurrentDir(origSpecifierPath);
		if (!(specifierPath in depMap)) {
			specifierPath = origSpecifierPath;
		}
		let depName = depMap[specifierPath];

		// handle any file extension renaming, per config
		specifierPath = renameFileExtension(config,specifierPath);

		// unknown/unnamed dependency?
		if (!depName) {
			specifierPath = req.specifier;

			depName = generateName();
			depMap[specifierPath] = depName;
		}

		// track which dependencies from the map we've actually referenced
		refDeps[specifierPath] = depName;

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
			// default export?
			if (expt.binding.target == "default") {
				// only one default export allowed per module
				registerDefaultExport(expt.context.exportsExpression);
			}

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
			// only one default export allowed per module
			registerDefaultExport(expt.context.exportsExpression);

			let uniqTarget = T.Identifier(req.binding.uniqueTarget);

			stmt.replaceWithMultiple([
				T.ImportDeclaration(
					[
						// import * as x from .. ?
						(config.namespaceImport ?
							T.ImportNamespaceSpecifier(uniqTarget) :
							// otherwise, import x from ..
							T.ImportDefaultSpecifier(uniqTarget)
						),
					],
					T.StringLiteral(specifierPath)
				),
				T.ExportDefaultDeclaration(uniqTarget)
			]);
		}
		// indirect with module-exports replacement? import .. + $module$exports
		else if (expt.esmType == "substitute-module-exports-reference") {
			// only one default export allowed per module
			registerDefaultExport(expt.context.exportsExpression);

			// handle require(..) call replacement first
			if (req.esmType == "substitute-default-import-indirect") {
				let uniqTarget = T.Identifier(req.binding.uniqueTarget);

				// insert default-import statement
				req.context.statement.insertBefore(
					T.ImportDeclaration(
						[
							(config.namespaceImport ?
								T.ImportNamespaceSpecifier(uniqTarget) :
								T.ImportDefaultSpecifier(uniqTarget)
							),
						],
						T.StringLiteral(specifierPath)
					)
				);

				// replace require(..) call
				req.context.requireCall.replaceWith(uniqTarget);
			}
			else if (req.esmType == "substitute-named-import-indirect") {
				let uniqTarget = T.Identifier(req.binding.uniqueTarget);

				// insert named-import statement
				req.context.statement.insertBefore(
					T.ImportDeclaration(
						[
							(
								req.binding.source == "default" ?
									T.ImportDefaultSpecifier(uniqTarget) :
									T.ImportSpecifier(
										uniqTarget,
										T.Identifier(req.binding.source)
									)
							),
						],
						T.StringLiteral(specifierPath)
					)
				);

				// replace require(..).x call
				req.context.expression.replaceWith(uniqTarget);
			}

			// now handle module.exports replacement
			if (!$module$exports) {
				$module$exports = createModuleExports(
					programPath,
					stmt,
					convertExports[convertExports.length-1].context.statement
				);
			}

			expt.context.exportsExpression.replaceWith($module$exports);
		}
		// should not get here
		else {
			throw new Error("Unsupported: combined import/export form not ESM compatible");
		}
	}

	// convert all requires to ESM imports
	for (let req of convertRequires) {
		// normalize dependency path
		let [ , origSpecifierPath, ] = splitPath(config.from,expandHomeDir(req.specifier));
		let specifierPath = addRelativeCurrentDir(origSpecifierPath);
		if (!(specifierPath in depMap)) {
			specifierPath = origSpecifierPath;
		}
		let depName = depMap[specifierPath];

		// handle any file extension renaming, per config
		specifierPath = renameFileExtension(config,specifierPath);

		// unknown/unnamed dependency?
		if (!depName) {
			specifierPath = req.specifier;

			depName = generateName();
			depMap[specifierPath] = depName;
		}

		// track which dependencies from the map we've actually referenced
		refDeps[specifierPath] = depName;

		// process require() statements/expressions
		if (req.esmType == "bare-import") {
			// replace with bare-import statement
			req.context.statement.replaceWith(
				T.ImportDeclaration([],T.StringLiteral(specifierPath))
			);
		}
		else if (req.esmType == "default-import") {
			// replace with default-import statement
			req.context.statement.insertBefore(
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
			req.context.declarator.remove();
		}
		else if (req.esmType == "named-import") {
			// collect named bindings
			let importBindings = [];
			for (let binding of (Array.isArray(req.binding) ? req.binding : [ req.binding, ])) {
				let target = T.Identifier(binding.target);

				importBindings.push(
					(binding.source == "default") ?
						T.ImportDefaultSpecifier(target) :
						T.ImportSpecifier(
							target,
							T.Identifier(binding.source)
						)
				);
			}

			// replace with named-import statement
			req.context.statement.insertBefore(
				T.ImportDeclaration(importBindings,T.StringLiteral(specifierPath))
			);
			req.context.declarator.remove();
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
				let uniqTarget = T.Identifier(binding.uniqueTarget);

				importBindings.push(
					(binding.source == "default") ?
						T.ImportDefaultSpecifier(uniqTarget) :
						T.ImportSpecifier(
							uniqTarget,
							T.Identifier(binding.source)
						)
				);
				assignments.push(
					T.ExpressionStatement(
						T.AssignmentExpression(
							"=",
							T.Identifier(binding.target),
							uniqTarget
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
		else if (req.esmType == "substitute-default-import-indirect") {
			let uniqTarget = T.Identifier(req.binding.uniqueTarget);

			// insert default-import statement
			req.context.statement.insertBefore(
				T.ImportDeclaration(
					[
						(config.namespaceImport ?
							T.ImportNamespaceSpecifier(uniqTarget) :
							T.ImportDefaultSpecifier(uniqTarget)
						),
					],
					T.StringLiteral(specifierPath)
				)
			);

			// replace require(..) call
			req.context.requireCall.replaceWith(uniqTarget);
		}
		else if (req.esmType == "substitute-named-import-indirect") {
			let uniqTarget = T.Identifier(req.binding.uniqueTarget);

			// insert named-import statement
			req.context.statement.insertBefore(
				T.ImportDeclaration(
					[
						(
							req.binding.source == "default" ?
								T.ImportDefaultSpecifier(uniqTarget) :
								T.ImportSpecifier(
									uniqTarget,
									T.Identifier(req.binding.source)
								)
						),
					],
					T.StringLiteral(specifierPath)
				)
			);

			// replace require(..).x call
			req.context.expression.replaceWith(uniqTarget);
		}
	}

	// convert all exports
	for (let expt of convertExports) {
		if (expt.esmType == "default-export") {
			// only one default export allowed per module
			registerDefaultExport(expt.context.exportsExpression);

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
			// default export?
			if (expt.binding.target == "default") {
				// only one default export allowed per module
				registerDefaultExport(expt.context.exportsExpression);
			}

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
			// default export?
			if (expt.binding.target == "default") {
				// only one default export allowed per module
				registerDefaultExport(expt.context.exportsExpression);
			}

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
		else if (expt.esmType == "substitute-module-exports-reference") {
			// only one default export allowed per module
			registerDefaultExport(expt.context.exportsExpression);

			if (!$module$exports) {
				$module$exports = createModuleExports(
					programPath,
					expt.context.statement,
					convertExports[convertExports.length-1].context.statement
				);
			}
			expt.context.exportsExpression.replaceWith($module$exports);
		}
	}

	// remove any strict-mode directive (since ESM is automatically strict-mode)
	programAST.program.directives.length = 0;

	return { ...generate(programAST), ast: programAST, refDeps: depMap, pathStr: modulePathStr, name: moduleName, };


	// *****************************

	function registerDefaultExport(context) {
		// TODO: include `context` in error reporting

		// already set a default-export? only one allowed per module
		if (defaultExportSet) {
			throw new Error("Multiple default exports not allowed in the same module");
		}
		defaultExportSet = true;
	}

}

function index(config,esmBuilds,depMap) {
	var modulePathStr = "./index.js";
	var altModulePathStr = modulePathStr.replace(/\.js$/,".cjs");
	var moduleName = depMap[modulePathStr || altModulePathStr] || "Index";

	// remove a dependency self-reference (if any)
	depMap = Object.fromEntries(
		Object.entries(depMap).filter(([ dPath, dName ]) => (dPath != modulePathStr && dPath != altModulePathStr))
	);

	// handle any file extension renaming, per config
	modulePathStr = renameFileExtension(config,modulePathStr);

	// start with empty program
	var esmAST = T.File(template.program("")());

	var dependencies = Object.entries(depMap);
	for (let [ depPath, depName, ] of dependencies) {
		// handle any file extension renaming, per config
		depPath = renameFileExtension(config,depPath);

		let target = T.Identifier(depName);

		esmAST.program.body.push(
			T.ExportNamedDeclaration(
				null,
				[
					(
						// export x from .. ?
						config.exportDefaultFrom ? T.ExportDefaultSpecifier(target) :

						// export * as x from .. ?
						config.namespaceExport ? T.ExportNamespaceSpecifier(target) :

						// otherwise, export { default as x } from ..
						T.ExportSpecifier(T.Identifier("default"),target)
					),
				],
				T.StringLiteral(depPath)
			)
		);
	}

	return { ...generate(esmAST), ast: esmAST, refDeps: depMap, pathStr: modulePathStr, name: moduleName, };
}

function renameFileExtension(config,pathStr) {
	// handle any file extension renaming, per config
	if (config[".cjs"]) {
		return pathStr.replace(/\.cjs$/,".js");
	}
	else if (config[".mjs"]) {
		return pathStr.replace(/\.c?js$/,".mjs");
	}
	return pathStr;
}

function createModuleExports(programPath,firstExportNode,lastExportNode) {
	// setup substitute module-exports target
	var moduleExports = T.Identifier(programPath.scope.generateUidIdentifier("exp").name);
	firstExportNode.insertBefore(
		T.VariableDeclaration(
			"let",
			[
				T.VariableDeclarator(moduleExports,T.ObjectExpression([])),
			]
		)
	);
	lastExportNode.insertAfter(
		T.ExportDefaultDeclaration(moduleExports)
	);
	return moduleExports;
}
