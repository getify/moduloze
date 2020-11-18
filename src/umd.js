"use strict";

var fs = require("fs");
var path = require("path");

var { default: traverse, } = require("@babel/traverse");
var T = require("@babel/types");
var { default: generate, } = require("@babel/generator");
var { parse, } = require("@babel/parser");
var toposort = require("toposort");

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
module.exports.bundle = bundle;
module.exports.index = index;
module.exports.sortDependencies = sortDependencies;


// ******************************

var UMDTemplate = fs.readFileSync(path.join(__dirname,"umd-template.js"),"utf-8");
var UMDBundleTemplate = fs.readFileSync(path.join(__dirname,"umd-bundle-template.js"),"utf-8");


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

	// rename source file .cjs extension (per config)
	modulePathStr = renameCJS(config,modulePathStr);

	// unknown module?
	if (!moduleName) {
		modulePathStr = origModulePathStr;

		if (config.ignoreUnknownDependency) {
			moduleName = generateName();
			depMap[modulePathStr] = moduleName;
		}
		else {
			throw new Error(`Unknown module: ${ modulePathStr }`);
		}
	}
	var refDeps = {};
	var defaultExportSet = false;

	// convert all requires to UMD dependencies
	for (let req of convertRequires) {
		// normalize dependency path
		let [ , origSpecifierPath, ] = splitPath(config.from,expandHomeDir(req.specifier));
		let specifierPath = addRelativeCurrentDir(origSpecifierPath);
		let depName = depMap[specifierPath];

		// rename source file .cjs extension (per config)
		specifierPath = renameCJS(config,specifierPath);

		// unknown/unnamed dependency?
		if (!depName) {
			specifierPath = req.specifier;

			if (
				req.umdType == "remove-require-unique" ||
				config.ignoreUnknownDependency
			) {
				depName = generateName();
				depMap[specifierPath] = depName;
			}
			else {
				throw new Error(`Unknown dependency: ${ req.specifier }`);
			}
		}

		// track which dependencies from the map we've actually referenced
		refDeps[specifierPath] = depName;

		// process require() statements/expressions
		if (req.umdType == "remove-require-unique") {
			req.context.statement.remove();
		}
		else if (req.umdType == "default-require") {
			// variable declaration different name than registered dependency-name?
			if (depName != req.binding.target) {
				// replace require(..) call with registered dependency-name
				req.context.requireCall.replaceWith(
					T.Identifier(depName)
				);
			}
			else {
				// remove whole declarator/statement
				req.context.declarator.remove();
			}
		}
		else {
			// replace require(..) call with registered dependency-name
			req.context.requireCall.replaceWith(
				T.Identifier(depName)
			);
		}
	}

	if (convertExports.length > 0) {
		// setup substitute module-exports target
		let $module$exports = T.Identifier(programPath.scope.generateUidIdentifier("exp").name);
		convertExports[0].context.statement.insertBefore(
			T.VariableDeclaration(
				"let",
				[
					T.VariableDeclarator($module$exports,T.ObjectExpression([])),
				]
			)
		);
		// note: appending to end of body so that we don't `return` too early
		programPath.pushContainer(
			"body",
			T.ReturnStatement($module$exports)
		);

		// convert all exports
		for (let expt of convertExports) {
			// default export?
			if (expt.umdType == "default-assignment") {
				// only one module.exports assignment allowed per module
				registerDefaultExport(expt.context.exportsExpression);
			}

			expt.context.exportsExpression.replaceWith($module$exports);
		}
	}

	// construct UMD from template
	var umdAST = parse(UMDTemplate);
	traverse(umdAST,{
		Program: {
			exit(path) {
				var callExprPath = path.get("body.0.expression");

				// set module-name
				callExprPath.get("arguments.0").replaceWith(T.StringLiteral(moduleName));

				// set dependencies and named parameters
				var dependencies = Object.entries(refDeps);
				var defFuncPath = callExprPath.get("arguments.3");
				if (dependencies.length > 0) {
					let dependenciesPath = callExprPath.get("arguments.2");
					for (let [ depPath, depName, ] of dependencies) {
						// add dependency entry
						dependenciesPath.node.properties.push(
							T.ObjectProperty(
								T.StringLiteral(depPath),
								T.StringLiteral(depName)
							)
						);

						// add named parameter
						defFuncPath.node.params.push(T.Identifier(depName));
					}
				}
			},
		}
	});

	// add UMD wrapper to program
	var umdWrapper = T.clone(umdAST.program.body[0],/*deep=*/true,/*withoutLoc=*/true);
	programPath.unshiftContainer("body",umdWrapper);

	// get reference to UMD definition function
	var defFuncBodyPath = programPath.get("body.0.expression.arguments.3.body");

	// add strict-mode directive to UMD definition function?
	if (
		programAST.program.directives.length > 0 &&
		programAST.program.directives[0].value.value == "use strict"
	) {
		defFuncBodyPath.node.directives.push(
			T.Directive(T.DirectiveLiteral("use strict"))
		);
		programAST.program.directives.shift();
	}

	// move all the program's top-level statements into the UMD definition function
	while (programAST.program.body.length > 1) {
		let stmt = programPath.get(`body.1`);
		let newStmt = T.cloneDeep(stmt.node);
		defFuncBodyPath.pushContainer("body",newStmt);
		stmt.remove();
	}

	return { ...generate(programAST), ast: programAST, refDeps, pathStr: modulePathStr, name: moduleName, };


	// *****************************

	function registerDefaultExport(context) {
		// TODO: include `context` in error reporting

		// already assigned to module-exports? only one assignment allowed per module
		if (defaultExportSet) {
			throw new Error("Multiple replacements of exports not allowed in the same module");
		}
		defaultExportSet = true;
	}

}

function bundle(config,umdBuilds) {
	try {
		// make sure dependencies are ordered correctly
		umdBuilds = sortDependencies(umdBuilds);
	}
	catch (err) {
		if (!config.ignoreCircularDependency) {
			throw new Error("Circular dependency not supported in UMD builds/bundles");
		}
	}

	// construct UMD bundle from template
	var programPath;
	var umdBundleAST = parse(UMDBundleTemplate);
	traverse(umdBundleAST,{
		Program: {
			exit(path) {
				programPath = path;
			},
		}
	});

	// get reference to UMD definition function
	var defListPath = programPath.get("body.0.expression.arguments.1");

	// insert all UMDs
	for (let umd of umdBuilds) {
		// append UMD to program body
		programPath.pushContainer("body",
			T.clone(umd.ast.program.body[0],/*deep=*/true,/*withoutLoc=*/true)
		);

		// reference inserted UMD's call expression
		let callExprPath = programPath.get("body.1.expression");

		// move UMD definition parts into bundle wrapper array
		let name = T.clone(callExprPath.get("arguments.0").node,/*deep=*/true,/*withoutLoc=*/true);
		let deps = T.clone(callExprPath.get("arguments.2").node,/*deep=*/true,/*withoutLoc=*/true);
		let def = T.clone(callExprPath.get("arguments.3").node,/*deep=*/true,/*withoutLoc=*/true);
		defListPath.pushContainer("elements",T.ArrayExpression(
			[
				name,
				deps,
				def,
			]
		));

		// remove inserted UMD
		programPath.get("body.1").remove();
	}

	return generate(umdBundleAST);
}

function index(config,umdBuilds,depMap) {
	try {
		// make sure dependencies are ordered correctly
		umdBuilds = sortDependencies(umdBuilds);
	}
	catch (err) {
		if (!config.ignoreCircularDependency) {
			throw new Error("Circular dependency not supported in UMD builds/bundles");
		}
	}

	var modulePathStr = "./index.js";
	var altModulePathStr = modulePathStr.replace(/\.js$/,".cjs");
	var moduleName = depMap[modulePathStr || altModulePathStr] || "Index";

	// remove a dependency self-reference (if any)
	depMap = Object.fromEntries(
		Object.entries(depMap).filter(([ dPath, dName ]) => (dPath != modulePathStr && dPath != altModulePathStr))
	);

	// handle any file extension renaming, per config
	modulePathStr = renameCJS(config,modulePathStr);

	// construct UMD from template
	var umdAST = parse(UMDTemplate);
	traverse(umdAST,{
		Program: {
			exit(path) {
				var callExprPath = path.get("body.0.expression");

				// set module-name
				callExprPath.get("arguments.0").replaceWith(T.StringLiteral(moduleName));

				// set dependencies and named parameters
				var dependencies = Object.entries(depMap);
				var defFuncPath = callExprPath.get("arguments.3");
				var defFuncBodyPath = defFuncPath.get("body");

				var returnObjectContents = [];

				if (dependencies.length > 0) {
					let dependenciesPath = callExprPath.get("arguments.2");
					for (let [ depPath, depName, ] of dependencies) {
						// rename source file .cjs extension (per config)
						depPath = renameCJS(config,depPath);

						// add dependency entry
						dependenciesPath.node.properties.push(
							T.ObjectProperty(
								T.StringLiteral(depPath),
								T.StringLiteral(depName)
							)
						);

						// add named parameter
						defFuncPath.node.params.push(T.Identifier(depName));

						// add re-export assignment statement to function body
						returnObjectContents.push(
							T.ObjectProperty(
								T.Identifier(depName),
								T.Identifier(depName),
								/*computed=*/false,
								/*shorthand=*/true
							)
						);
					}
				}

				// return substitute module-exports target
				defFuncBodyPath.pushContainer("body",
					T.ReturnStatement(T.ObjectExpression(returnObjectContents))
				);

				// add strict mode directive
				defFuncBodyPath.node.directives.push(
					T.Directive(T.DirectiveLiteral("use strict"))
				);
			},
		}
	});

	return { ...generate(umdAST), ast: umdAST, refDeps: depMap, pathStr: modulePathStr, name: moduleName, };
}

function sortDependencies(umdBuilds) {
	// map of module paths to the builds
	var depMap = {};
	for (let umd of umdBuilds) {
		depMap[umd.pathStr] = umd;
	}

	// construct graph edges (dependency relationships)
	var depsGraph = [];
	for (let umd of umdBuilds) {
		for (let refDepPath of Object.keys(umd.refDeps)) {
			if (refDepPath in depMap) {
				depsGraph.push([ umd, depMap[refDepPath], ]);
			}
		}
	}

	// perform topological sort
	return toposort.array(umdBuilds,depsGraph).reverse();
}

function renameCJS(config,pathStr) {
	if (config[".cjs"]) {
		return pathStr.replace(/\.cjs$/,".js");
	}
	return pathStr;
}
