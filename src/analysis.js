"use strict";

var { default: traverse, } = require("@babel/traverse");
var T = require("@babel/types");
var { default: generate, } = require("@babel/generator");
var { parse, } = require("@babel/parser");

var {
	findParentStatement,
	isAssignmentTarget,
} = require("./helpers.js");

module.exports.identifyRequiresAndExports = identifyRequiresAndExports;
module.exports.analyzeRequires = analyzeRequires;
module.exports.analyzeExports = analyzeExports;


// ******************************

function identifyRequiresAndExports(codePath,code) {
	var programPath;
	var requireStatements = new Set();
	var exportStatements = new Set();
	var requireCalls = new WeakMap();
	var exportAssignments = new WeakMap();

	var visitors = {
		Program: {
			exit(path) {
				programPath = path;
			},
		},
		CallExpression: {
			exit(path) {
				// require(..) call?
				if (T.isIdentifier(path.node.callee,{ name: "require", })) {
					// require(" some string literal ") ?
					if (
						path.node.arguments.length == 1 &&
						T.isStringLiteral(path.node.arguments[0])
					) {
						let parentStatementPath = findParentStatement(path.parentPath);
						if (parentStatementPath) {
							requireStatements.add(parentStatementPath);
							if (!requireCalls.has(parentStatementPath)) {
								requireCalls.set(parentStatementPath,[]);
							}
							requireCalls.get(parentStatementPath).push(path);
						}
					}
					// non-string literals not supported
					else {
						throw new Error("Unsupported: require(..) statement without a single string-literal argument");
					}
				}
			}
		},
		MemberExpression: {
			exit(path) {
				// module.exports?
				if (
					T.isIdentifier(path.node.object,{ name: "module", }) &&
					T.isIdentifier(path.node.property,{ name: "exports" })
				) {
					// used as a left-hand assignment target?
					if (isAssignmentTarget(path)) {
						let parentStatementPath = findParentStatement(path.parentPath);
						if (parentStatementPath) {
							exportStatements.add(parentStatementPath);
							if (!exportAssignments.has(parentStatementPath)) {
								exportAssignments.set(parentStatementPath,[]);
							}
							exportAssignments.get(parentStatementPath).push(path);
						}
					}
					else {
						throw new Error("Unsupported: module.exports not used as an assignment target");
					}
				}
			}
		},
		Identifier: {
			exit(path) {
				// exports?
				if (
					path.node.name == "exports" &&
					// NOT part of a member expression like x.exports or x[exports]?
					// note: exports.x form is recognized, but x.exports and x[exports]
					//   aren't relevant export forms
					!T.isMemberExpression(path.parent,{ property: path.node, })
				) {
					// used as a left-hand assignment target?
					if (isAssignmentTarget(path)) {
						let parentStatementPath = findParentStatement(path.parentPath);
						if (parentStatementPath) {
							exportStatements.add(parentStatementPath);
							if (!exportAssignments.has(parentStatementPath)) {
								exportAssignments.set(parentStatementPath,[]);
							}
							exportAssignments.get(parentStatementPath).push(path);
						}
					}
					else {
						throw new Error("Unsupported: module.exports not used as an assignment target");
					}
				}
			}
		}
	};

	var programAST = parse(code,{ sourceFilename: codePath, });
	traverse(programAST,visitors);
	var convertRequires = analyzeRequires(requireStatements,requireCalls);
	var convertExports = analyzeExports(exportStatements,exportAssignments);

	return {
		programAST,
		programPath,
		convertRequires,
		convertExports,
	};
}

function analyzeRequires(requireStatements,requireCalls) {
	var convertRequires = [];

	for (let stmt of requireStatements) {
		if (!T.isProgram(stmt.parent)) {
			throw new Error("Require statements must be at the top-level of the program");
		}
		let stmtReqCalls = requireCalls.get(stmt);

		// standalone require(".."")?
		if (
			T.isExpressionStatement(stmt.node) &&
			T.isCallExpression(stmt.node.expression) &&
			stmtReqCalls.length == 1 &&
			stmtReqCalls[0].node == stmt.node.expression
		) {
			let call = stmt.node.expression;
			let specifier = call.arguments[0].extra.rawValue;

			// console.log(`import ${ specifier };`);
			convertRequires.push({
				esmType: "bare-import",
				umdType: "remove-require-unique",
				specifier,
				context: {
					statement: stmt,
				},
			});
			continue;
		}
		// var/let/const declaration statement?
		else if (T.isVariableDeclaration(stmt.node)) {
			for (let [declIdx,declNode,] of stmt.node.declarations.entries()) {
				let decl = stmt.get(`declarations.${ declIdx }`);

				// normal identifier declaration? var x = ..
				if (T.isIdentifier(declNode.id)) {
					// call as initialization assignment? var x = require(..)
					if (
						T.isCallExpression(declNode.init) &&
						stmtReqCalls.find(p => p.node == declNode.init)
					) {
						let call = declNode.init;
						let specifier = call.arguments[0].extra.rawValue;

						// console.log(`import * as ${ declNode.id.name } from ${ specifier };`);
						// console.log(`import ${ declNode.id.name } from ${ specifier };`);
						convertRequires.push({
							esmType: "default-import",
							umdType: "default-require",
							binding: {
								target: declNode.id.name
							},
							specifier,
							context: {
								statement: stmt,
								declarator: decl,
								declarationIdx: declIdx,
								requireCall: decl.get("init"),
							},
						});
						continue;
					}
					else if (
						// require(..) is part of a simple member expression?
						isSimpleMemberExpression(declNode.init) &&
						stmtReqCalls.find(p => p.node == declNode.init.object)
					) {
						let call = declNode.init.object;
						let specifier = call.arguments[0].extra.rawValue;
						let target = declNode.id.name;
						let source =
							T.isIdentifier(declNode.init.property) ?
								declNode.init.property.name :
							T.isStringLiteral(declNode.init.property) ?
								declNode.init.property.value :
							undefined;
						if (source) {
							// console.log(`import { ${ binding } } from ${ specifier };`);
							convertRequires.push({
								esmType: "named-import",
								umdType: "named-dependency",
								binding: {
									source,
									target,
								},
								specifier,
								context: {
									statement: stmt,
									declarator: decl,
									declarationIdx: declIdx,
									requireCall: decl.get("init.object"),
								},
							});
							continue;
						}
					}
					// otherwise, a variable declaration without a require(..) in it
					else {
						continue;
					}
				}
				// destructuring assignment? var { x } = require(..)
				else if (
					T.isObjectPattern(declNode.id) &&
					T.isCallExpression(declNode.init) &&
					stmtReqCalls.find(p => p.node == declNode.init)
				) {
					let call = declNode.init;
					let specifier = call.arguments[0].extra.rawValue;
					let pattern = declNode.id;
					let bindings = [];
					for (let targetProp of pattern.properties) {
						// simple destructuring target?
						if (
							!targetProp.computed &&
							T.isIdentifier(targetProp.value)
						) {
							let source =
								T.isIdentifier(targetProp.key) ? targetProp.key.name :
								T.isStringLiteral(targetProp.key) ? targetProp.key.value :
								undefined;
							if (source) {
								bindings.push({
									source,
									target: targetProp.value.name,
								});
								continue;
							}
						}

						// if we get here, the `require(..)` wasn't of a supported form
						throw new Error("Unsupported: destructuring pattern not ESM import-compatible");
					}

					if (bindings.length > 0) {
						// console.log(`import { ${ binding } } from ${ specifier };`);
						convertRequires.push({
							esmType: "named-import",
							umdType: "destructured-dependency",
							binding: bindings,
							specifier,
							context: {
								statement: stmt,
								declarator: decl,
								declarationIdx: declIdx,
								requireCall: decl.get("init"),
							},
						});
						continue;
					}
				}

				// if we get here, the require(..) wasn't of a supported form
				throw new Error("Unsupported: variable declaration not ESM import-compatible");
			}

			continue;
		}
		// non-declaration assignment statement?
		else if (
			T.isExpressionStatement(stmt.node) &&
			T.isAssignmentExpression(stmt.node.expression)
		) {
			let assignment = stmt.node.expression;

			// regular identifier assignment? x = ..
			if (T.isIdentifier(assignment.left)) {
				// simple call assignment? x = require(..)
				if (stmtReqCalls.find(p => p.node == assignment.right)) {
					let call = assignment.right;
					let specifier = call.arguments[0].extra.rawValue;
					let target = assignment.left.name;

					// console.log(`import * as ${ target$1 } from ${ specifier }; ${ target } = ${ target$1 };`);
					// console.log(`import ${ target$1 } from ${ specifier }; ${ target } = ${ target$1 };`);
					convertRequires.push({
						esmType: "default-import-indirect",
						umdType: "indirect-target",
						binding: {
							source: "default",
							target,
							uniqueTarget: stmt.scope.generateUidIdentifier("imp").name,
						},
						specifier,
						context: {
							statement: stmt,
							requireCall: stmt.get("expression.right"),
						},
					});
					continue;
				}
				else if (
					// require(..) part of a simple member expression?
					isSimpleMemberExpression(assignment.right) &&
					stmtReqCalls.find(p => p.node == assignment.right.object)
				) {
					let call = assignment.right.object;
					let specifier = call.arguments[0].extra.rawValue;
					let target = assignment.left.name;
					let source =
						T.isIdentifier(assignment.right.property) ?
							assignment.right.property.name :
						T.isStringLiteral(assignment.right.property) ?
							assignment.right.property.value :
						undefined;
					if (source) {
						// console.log(`import { ${ binding } } from ${ specifier }; ${ target } = ${ target$1 };`);
						convertRequires.push({
							esmType: "named-import-indirect",
							umdType: "indirect-source-target",
							binding: {
								source,
								target,
								uniqueTarget: stmt.scope.generateUidIdentifier("imp").name,
							},
							specifier,
							context: {
								statement: stmt,
								requireCall: stmt.get("expression.right.object"),
							},
						});
						continue;
					}
				}
			}
			// destructuring assignment? { x } = require(..)
			else if (
				T.isObjectPattern(assignment.left) &&
				stmtReqCalls.find(p => p.node == assignment.right)
			) {
				let call = assignment.right;
				let specifier = call.arguments[0].extra.rawValue;
				let pattern = assignment.left;
				let bindings = [];
				for (let targetProp of pattern.properties) {
					// simple destructuring target?
					if (
						!targetProp.computed &&
						T.isIdentifier(targetProp.value)
					) {
						let source =
							T.isIdentifier(targetProp.key) ? targetProp.key.name :
							T.isStringLiteral(targetProp.key) ? targetProp.key.value :
							undefined;
						if (source) {
							bindings.push({
								source,
								target: targetProp.value.name,
								uniqueTarget: stmt.scope.generateUidIdentifier("imp").name,
							});
							continue;
						}
					}

					// if we get here, the `require(..)` wasn't of a supported form
					throw new Error("Unsupported: destructuring pattern not ESM import-compatible");
				}

				if (bindings.length > 0) {
					// console.log(`import { ${ binding } } from ${ specifier }; ${ target } = ${ target$1 };`);
					convertRequires.push({
						esmType: "named-import-indirect",
						umdType: "indirect-source-target",
						binding: bindings,
						specifier,
						context: {
							statement: stmt,
							requireCall: stmt.get("expression.right"),
						},
					});
					continue;
				}
			}
			// default or named re-export?
			// ie, module.exports = require(..).. OR module.exports.x = require(..)..
			else if (
				isModuleExports(assignment.left) ||
				(
					T.isMemberExpression(assignment.left,{ computed: false, }) &&
					(
						T.isIdentifier(assignment.left.property) ||
						T.isStringLiteral(assignment.left.property)
					) &&
					isModuleExports(assignment.left.object)
				)
			) {
				let target = assignment.left;

				// require(..) by itself?
				if (stmtReqCalls.find(p => p.node == assignment.right)) {
					let call = assignment.right;
					let specifier = call.arguments[0].extra.rawValue;

					// console.log(`import * as ${ target$1 } from ${ specifier }; ${ target } = ${ target$1 };`);
					// console.log(`import ${ target$1 } from ${ specifier }; ${ target } = ${ target$1 };`);
					convertRequires.push({
						esmType: "default-import-indirect",
						umdType: "indirect-target",
						binding: {
							source: "default",
							target,
							uniqueTarget: stmt.scope.generateUidIdentifier("imp").name,
						},
						specifier,
						context: {
							statement: stmt,
							requireCall: stmt.get("expression.right"),
						},
					});
					continue;
				}
				// require(..).x form?
				else if (
					T.isMemberExpression(assignment.right,{ computed: false, }) &&
					stmtReqCalls.find(p => p.node == assignment.right.object)
				) {
					let call = assignment.right.object;
					let specifier = call.arguments[0].extra.rawValue;
					let source =
						T.isIdentifier(assignment.right.property) ?
							assignment.right.property.name :
						T.isStringLiteral(assignment.right.property) ?
							assignment.right.property.value :
						undefined;
					if (source) {
						// console.log(`import { ${ binding } } from ${ specifier }; ${ target } = ${ target$1 };`);
						convertRequires.push({
							esmType: "named-import-indirect",
							umdType: "indirect-source-target",
							binding: {
								source,
								target,
								uniqueTarget: stmt.scope.generateUidIdentifier("imp").name,
							},
							specifier,
							context: {
								statement: stmt,
								requireCall: stmt.get("expression.right.object"),
							},
						});
						continue;
					}
				}
			}
		}

		// if we get here, the require(..) wasn't of a supported form
		throw new Error("Unsupported: require(..) expression not ESM import-compatible");
	}

	return convertRequires;
}

function analyzeExports(exportStatements,exportAssignments) {
	var convertExports = [];

	for (let stmt of exportStatements) {
		if (!T.isProgram(stmt.parent)) {
			throw new Error("Exports expressions must be at the top-level of the program");
		}
		let stmtExpAssignments = exportAssignments.get(stmt);

		// single export assignment?
		if (
			T.isExpressionStatement(stmt.node) &&
			T.isAssignmentExpression(stmt.node.expression) &&
			stmtExpAssignments.length == 1
		) {
			let assignment = stmt.node.expression;
			let target = assignment.left;
			let source = assignment.right;

			if (target == stmtExpAssignments[0].node) {
				// assigning to `exports` or `module.exports`?
				if (isModuleExports(target)) {
					// exporting an identifier?
					if (
						T.isIdentifier(source) &&
						source.name != "undefined"
					) {
						// console.log(`export default ${ source.name };`);
						convertExports.push({
							esmType: "default-export",
							umdType: "default-assignment",
							binding: {
								source,
							},
							context: {
								statement: stmt,
								exportsExpression: stmt.get("expression.left"),
							},
						});
						continue;
					}
					// exporting any other value/expression
					else {
						// console.log("export default ..;");
						convertExports.push({
							esmType: "default-export",
							umdType: "default-assignment",
							binding: {
								source,
							},
							context: {
								statement: stmt,
								exportsExpression: stmt.get("expression.left"),
							},
						});
						continue;
					}
				}
			}
			else if (T.isMemberExpression(target,{ object: stmtExpAssignments[0].node, computed: false, })) {
				let exportName =
					T.isIdentifier(target.property) ? target.property.name :
					T.isStringLiteral(target.property) ? target.property.value :
					undefined;

				// object (ie, object.property) of member-expression is `exports` or `module.exports`?
				if (isModuleExports(target.object)) {
					// exporting an identifier?
					if (
						T.isIdentifier(source) &&
						source.name != "undefined"
					) {
						// console.log(`export { ${ source.name } as ${ exportName } };`);
						convertExports.push({
							esmType: "named-export",
							umdType: "named-export",
							binding: {
								source: source.name,
								target: exportName,
							},
							context: {
								statement: stmt,
								exportsExpression: stmt.get("expression.left.object"),
							},
						});
						continue;
					}
					else if (T.isMemberExpression(source,{ computed: false, })) {
						let sourceName =
							T.isIdentifier(source.property) ? source.property.name :
							T.isStringLiteral(source.property) ? source.property.value :
							undefined;

						// console.log(`export var { ${ sourceName }: ${ exportName } } = ${ source.object }`);
						convertExports.push({
							esmType: "destructured-declaration-export",
							umdType: "named-export",
							binding: {
								sourceName,
								source: source.object,
								target: exportName,
							},
							context: {
								statement: stmt,
								exportsExpression: stmt.get("expression.left.object"),
							},
						});
						continue;
					}
					// exporting any other value/expression
					else {
						// console.log(`var ${ exportName }$1 = ..; export { ${exportName}$1 as ${ exportName } };`);
						convertExports.push({
							esmType: "named-declaration-export",
							umdType: "named-export",
							binding: {
								source,
								target: exportName,
								uniqueTarget: stmt.scope.generateUidIdentifier("exp").name,
							},
							context: {
								statement: stmt,
								exportsExpression: stmt.get("expression.left.object"),
							},
						});
						continue;
					}
				}
			}
		}

		// if we get here, the exports/module.exports wasn't of a supported form
		throw new Error("Unsupported: exports expression not ESM export-compatible");
	}

	return convertExports;
}

function isModuleExports(node) {
	return (
		T.isIdentifier(node,{ name: "exports", }) ||
		(
			T.isMemberExpression(node,{ computed: false, }) &&
			T.isIdentifier(node.object,{ name: "module", }) &&
			(
				T.isIdentifier(node.property,{ name: "exports", }) ||
				T.isStringLiteral(node.property,{ value: "exports", })
			)
		)
	);
}

function isSimpleMemberExpression(node) {
	return (
		T.isMemberExpression(node) &&
		(
			// single property expression via . operator? x.y
			(
				!node.computed &&
				T.isIdentifier(node.property)
			) ||
			// single property expression via [".."] operator? x["y"]
			(
				node.computed &&
				T.isStringLiteral(node.property)
			)
		)
	);
}
