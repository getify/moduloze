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
	generateName,
	rootRelativePath,
	qualifyDepPaths,
	isPathBasedSpecifier,
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
	depMap = { ...depMap, };

	var {
		programAST,
		programPath,
		convertRequires,
		convertExports,
	} = identifyRequiresAndExports(pathStr,code);

	var absoluteFromDirStr = config.from;
	var absoluteBuildPathStr =
		path.resolve(
			absoluteFromDirStr,
			expandHomeDir(pathStr)
		);
	var rootRelativeBuildPathStr =
		rootRelativePath(
			absoluteFromDirStr,
			absoluteBuildPathStr
		);
	var moduleName = depMap[rootRelativeBuildPathStr];

	// unknown module?
	if (!moduleName) {
		if (config.ignoreUnknownDependency) {
			moduleName = generateName();
			depMap[pathStr] = moduleName;
		}
		else {
			throw new Error(`Unknown module: ${ pathStr }`);
		}

		rootRelativeBuildPathStr = pathStr;
	}
	var refDeps = {};
	var defaultExportSet = false;

	// convert all requires to UMD dependencies
	for (let req of convertRequires) {
		let depName;

		// path-based specifier?
		if (isPathBasedSpecifier(req.specifier)) {
			let absoluteDepPathStr = path.resolve(
				path.dirname(absoluteBuildPathStr),
				expandHomeDir(req.specifier)
			);
			let rootRelativeDepPathStr =
				rootRelativePath(
					absoluteFromDirStr,
					absoluteDepPathStr
				);

			// dependency self-reference? (not allowed)
			if (rootRelativeDepPathStr == rootRelativeBuildPathStr) {
				throw new Error(`Module dependency is an illegal self-reference: ${ req.specifier }`);
			}

			depName = depMap[rootRelativeDepPathStr];
			let buildRelativeDepPathStr =
				rootRelativePath(
					path.dirname(absoluteBuildPathStr),
					expandHomeDir(req.specifier)
				);

			// unknown/unnamed dependency?
			if (!depName) {
				if (
					req.umdType == "remove-require-unique" ||
					config.ignoreUnknownDependency
				) {
					depName = generateName();
					depMap[rootRelativeDepPathStr] = depName;
				}
				else {
					throw new Error(`Unknown dependency: ${ req.specifier }`);
				}
			}

			// track which known dependencies from the map we've
			// actually referenced
			refDeps[rootRelativeDepPathStr] = buildRelativeDepPathStr;
		}
		// otherwise, assume name-based specifier
		else {
			let specifierKey = `:::${req.specifier}`;
			depName = depMap[specifierKey];

			// unknown/unnamed dependency?
			if (!depName) {
				if (
					req.umdType == "remove-require-unique" ||
					config.ignoreUnknownDependency
				) {
					depName = generateName();
					depMap[specifierKey] = depName;
				}
				else {
					throw new Error(`Unknown dependency: ${ req.specifier }`);
				}
			}

			// track which known dependencies from the map we've
			// actually referenced
			refDeps[specifierKey] = specifierKey;
		}

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
					for (let [ depKey, depVal, ] of dependencies) {
						let depName = depMap[depKey];
						let depPathStr;

						// name-based dependency specifier?
						if (depKey.startsWith(":::")) {
							depPathStr = depKey.slice(3);
						}
						// otherwise, assume path-based dependency specifier
						else {
							// NOTE: depVal here is a build-relative path
							depPathStr = depVal;
							depPathStr = addRelativeCurrentDir(depPathStr);
							// rename source file .cjs extension (per config)
							depPathStr = renameCJS(config,depPathStr);
						}

						// add dependency entry
						dependenciesPath.node.properties.push(
							T.ObjectProperty(
								T.StringLiteral(depPathStr),
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

	return {
		...generate(programAST),
		ast: programAST,
		depMap,
		refDeps,
		// rename source file .cjs extension (per config)
		pathStr: renameCJS(config,rootRelativeBuildPathStr),
		origPathStr: rootRelativeBuildPathStr,
		name: moduleName,
	};


	// *****************************

	function registerDefaultExport(context) {
		// TODO: include `context` in error reporting

		// already assigned to module-exports? only one assignment allowed per module
		if (defaultExportSet) {
			throw new Error("Multiple re-assignments of 'module.exports' not allowed in the same module");
		}
		defaultExportSet = true;
	}

}

function bundle(config,umdBuilds) {
	try {
		// make sure dependencies are ordered correctly
		umdBuilds = sortDependencies(config,umdBuilds);
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
		// skip an auto-generated (index) build?
		if (umd.autoGenerated) {
			continue;
		}
		let umdNode = T.clone(umd.ast.program.body[0],/*deep=*/true,/*withoutLoc=*/true);

		let props = umdNode.expression.arguments[2].properties;
		if (props.length > 0) {
			let absoluteBuildDirStr = path.dirname(
				path.resolve(config.from,umd.pathStr)
			);

			// check all dep paths to see if they need to be
			// rewritten to be root-relative instead of
			// build-relative
			for (let prop of props) {
				// path-based dependency specifier?
				if (isPathBasedSpecifier(prop.key.value)) {
					let buildRelativeDepPathStr = prop.key.value;
					let absoluteDepPathStr = path.resolve(
						absoluteBuildDirStr,
						buildRelativeDepPathStr
					);
					let rootRelativeDepPathStr = addRelativeCurrentDir(
						rootRelativePath(config.from,absoluteDepPathStr)
					);
					prop.key.value = rootRelativeDepPathStr;
				}
			}
		}

		// temporarily append UMD to program body
		programPath.pushContainer("body",umdNode);

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

		// remove previously inserted UMD
		programPath.get("body.1").remove();
	}

	return generate(umdBundleAST);
}

function index(config,umdBuilds,depMap) {
	try {
		// make sure dependencies are ordered correctly
		umdBuilds = sortDependencies(config,umdBuilds);
	}
	catch (err) {
		if (!config.ignoreCircularDependency) {
			throw new Error("Circular dependency not supported in UMD builds/bundles");
		}
	}

	var indexExt = (
		// any of the dependencies use ".cjs" file extension?
		Object.keys(depMap).find(pathStr => /\.cjs$/.test(pathStr)) ?
			"cjs" :
			"js"
	);
	var indexPathStr = `./index.${indexExt}`;
	var altModulePathStr = (indexExt == "cjs") ? "index.js" : "index.cjs";
	var indexName = depMap[indexPathStr || altModulePathStr] || "Index";

	// build list of indexable resources
	var indexResources = (
		Object.entries(depMap).filter(([ rPath, ]) => (
			// make sure we're not indexing name-based resources
			!rPath.startsWith(":::") &&

			// make sure we're only indexing known builds
			umdBuilds.find(build => build.origPathStr == rPath) &&

			// prevent index self-reference (if any)
			![indexPathStr,altModulePathStr].includes(rPath)
		))
	);

	// handle any file extension renaming, per config
	indexPathStr = renameCJS(config,indexPathStr);

	var refDeps = {};

	// construct UMD from template
	var umdAST = parse(UMDTemplate);
	traverse(umdAST,{
		Program: {
			exit(path) {
				var callExprPath = path.get("body.0.expression");

				// set module-name
				callExprPath.get("arguments.0").replaceWith(T.StringLiteral(indexName));

				// set dependencies and named parameters
				var defFuncPath = callExprPath.get("arguments.3");
				var defFuncBodyPath = defFuncPath.get("body");

				var returnObjectContents = [];

				var dependenciesPath = callExprPath.get("arguments.2");
				for (let [ resKey, resVal, ] of indexResources) {
					let depName = resVal;
					let depPathStr;

					// name-based dependency specifier?
					if (resKey.startsWith(":::")) {
						depPathStr = resKey.slice(3);
					}
					// otherwise, assume path-based dependency specifier
					else {
						// NOTE: resKey here is a root-relative path
						depPathStr = resKey;
						depPathStr = addRelativeCurrentDir(depPathStr);
						// rename source file .cjs extension (per config)
						depPathStr = renameCJS(config,depPathStr);
					}

					// track which known dependencies from the map we've
					// actually referenced
					refDeps[depPathStr] = depPathStr;

					// add dependency entry
					dependenciesPath.node.properties.push(
						T.ObjectProperty(
							T.StringLiteral(depPathStr),
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

	return {
		autoGenerated: true,
		...generate(umdAST),
		ast: umdAST,
		depMap,
		refDeps,
		pathStr: indexPathStr,
		origPathStr: indexPathStr,
		name: indexName,
	};
}

function sortDependencies(config,umdBuilds) {
	// filter out auto-generated builds (like index)
	umdBuilds = umdBuilds.filter(umd => !umd.autoGenerated);

	// map of module paths to the builds
	var buildMap = {};
	for (let umd of umdBuilds) {
		buildMap[umd.pathStr] = umd;
	}

	// construct graph edges (dependency relationships)
	var depsGraph = [];
	for (let umd of umdBuilds) {
		for (let refDepPath of Object.keys(umd.refDeps)) {
			refDepPath = renameCJS(config,refDepPath);
			if (refDepPath in buildMap) {
				depsGraph.push([ umd, buildMap[refDepPath], ]);
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
