"use strict";

var fs = require("fs");
var path = require("path");

var { default: traverse, } = require("@babel/traverse");
var T = require("@babel/types");
var { default: generate, } = require("@babel/generator");
var { parse, } = require("@babel/parser");

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

module.exports = buildUMD;


// ******************************

var UMDTemplate = fs.readFileSync(path.join(__dirname,"umd-template.js"),"utf-8");


function buildUMD(config,pathStr,code,depMap) {
	var {
		programAST,
		programPath,
		convertRequires,
		convertExports,
	} = identifyRequiresAndExports(pathStr,code);

	var [ , modulePath, ] = splitPath(config.from,pathStr);
	modulePath = addRelativeCurrentDir(modulePath);
	var moduleName = depMap[modulePath];
	var refDeps = {};

	// convert all requires to UMD dependencies
	for (let req of convertRequires) {
		// normalize dependency path
		let [ , origSpecifierPath, ] = splitPath(config.from,expandHomeDir(req.specifier));
		let specifierPath = addRelativeCurrentDir(origSpecifierPath);

		let depName = depMap[specifierPath];

		// unknown/unnamed dependency?
		if (!depName) {
			specifierPath = origSpecifierPath;

			if (
				req.umdType == "remove-require-unique" ||
				config.ignoreMissingDependency
			) {
				depName = generateName();
				depMap[specifierPath] = depName;
			}
			else {
				throw `Unknown UMD dependency: ${ req.specifier }`;
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
				req.context.declarator.get("init").replaceWith(
					T.Identifier(depName)
				);
			}
			else {
				// remove whole declarator/statement
				req.context.declarator.remove();
			}
		}
		else if (req.umdType == "named-dependency") {
			req.context.declarator.get("init").replaceWith(
				T.MemberExpression(
					T.Identifier(depName),
					T.Identifier(req.binding.source)
				)
			);
		}
		else if (req.umdType == "destructured-dependency") {
			req.context.declarator.get("init").replaceWith(
				T.Identifier(depName)
			);
		}
		else if (req.umdType == "indirect-target") {
			req.context.statement.replaceWith(
				T.ExpressionStatement(
					T.AssignmentExpression(
						"=",
						T.Identifier(req.binding.target),
						T.Identifier(depName)
					)
				)
			);
		}
		else if (req.umdType == "indirect-source-target") {
			for (let binding of (Array.isArray(req.binding) ? req.binding : [req.binding,])) {
				req.context.statement.insertBefore(
					T.ExpressionStatement(
						T.AssignmentExpression(
							"=",
							T.Identifier(binding.target),
							T.MemberExpression(
								T.Identifier(depName),
								T.Identifier(binding.source)
							)
						)
					)
				);
			}
			req.context.statement.remove();
		}
	}

	// setup substitute module-exports target
	var $module$exports = programPath.scope.generateUidIdentifier("exp").name;
	programPath.get("body.0").insertBefore(
		T.VariableDeclaration(
			"var",
			[
				T.VariableDeclarator(T.Identifier($module$exports),T.ObjectExpression([])),
			]
		)
	);
	programPath.get(`body.${ (programPath.node.body.length - 1) }`).insertAfter(
		T.ReturnStatement(T.Identifier($module$exports))
	);

	// convert all exports
	for (let expt of convertExports) {
		if (expt.umdType == "default-assignment") {
			expt.context.statement.get("expression.left").replaceWith(
				T.Identifier($module$exports)
			);
		}
		else if (expt.umdType == "named-export") {
			expt.context.statement.get("expression.left.object").replaceWith(
				T.Identifier($module$exports)
			);
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
				var funcPath = callExprPath.get("arguments.3");
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
						funcPath.node.params.push(T.Identifier(depName));
					}
				}
			},
		}
	});

	// add UMD wrapper to program
	var umdWrapper = T.clone(umdAST.program.body[0],/*deep=*/true,/*withoutLoc=*/true);
	programPath.unshiftContainer("body",umdWrapper);

	// get reference to UMD definition function
	var defFuncPath = programPath.get("body.0.expression.arguments.3.body");

	// add strict-mode directive to UMD definition function?
	if (
		programAST.program.directives.length > 0 &&
		programAST.program.directives[0].value.value == "use strict"
	) {
		defFuncPath.node.directives.push(
			T.Directive(T.DirectiveLiteral("use strict"))
		);
		programAST.program.directives.shift();
	}

	// move all the program's top-level statements into the UMD definition function
	while (programAST.program.body.length > 1) {
		let stmt = programPath.get(`body.1`);
		let newStmt = T.cloneDeep(stmt.node);
		defFuncPath.pushContainer("body",newStmt);
		stmt.remove();
	}

	return generate(programAST);
}
