"use strict";

var { default: traverse, } = require("@babel/traverse");
var T = require("@babel/types");
var babylon = require("babylon");

var requireStatements = new Set();
var exportStatements = new Set();
var requireCalls = new WeakMap();
var exportAssignments = new WeakMap();

var convertImports = [];
var convertExports = [];

var visitors = {
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
					console.error("Unsupported: require(..) statement without a single string-literal argument.");
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
					console.error("Unsupported: module.exports not used as an assignment target.");
				}
			}
		}
	},
	Identifier: {
		exit(path) {
			// exports?
			if (
				path.node.name == "exports" &&
				// NOT x.exports form?
				// note: exports.x is totally allowed, but x.exports
				//   isn't an export form we care about
				!(
					T.isMemberExpression(path.parent) &&
					path.parent.property == path.node
				)
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
					console.error("Unsupported: module.exports not used as an assignment target.");
				}
			}
		}
	}
};




build(

`
require("1.js");
var v2 = require("2.js");
var v3 = require("3.js").v3;
var v4 = require("4.js").v;
var v5 = require("5.js")["v"];
v6 = require("6.js");
v7 = require("7.js").v7;
v8 = require("8.js").v;
v9 = require("9.js")["v"];
var { v10 } = require("10.js");
var { v: v11 } = require("11.js");
var { "v": v12 } = require("12.js");
({ v13 } = require("13.js"));
({ v: v14 } = require("14.js"));
({ "v": v15 } = require("15.js"));

module.exports = 1;
module.exports = t2;
module.exports = t[3];
module.exports.t4 = 4;
module.exports.t5 = "t5";
module.exports.t6 = true;
module.exports.t7 = t7;
module.exports.t8 = v;
module.exports.t9 = null;
module.exports.t10 = undefined;
module.exports.t11 = t11();
exports = 12;
exports = t13;
exports = t[14];
exports.t15 = 15;
exports.t16 = "t16";
exports.t17 = true;
exports.t18 = t18;
exports.t19 = v;
exports.t20 = null;
exports.t21 = undefined;
exports.t22 = t22();
`

);

function build(code) {
	var ast = babylon.parse(code);
	traverse(ast,visitors);
	analyzeRequires();
	analyzeExports();
}

function analyzeRequires() {
	for (let stmt of requireStatements) {
		let stmtReqCalls = requireCalls.get(stmt);

		// standalone require(".."")?
		if (
			T.isExpressionStatement(stmt.node) &&
			T.isCallExpression(stmt.node.expression) &&
			stmtReqCalls.length == 1 &&
			stmtReqCalls[0].node == stmt.node.expression
		) {
			let call = stmt.node.expression;
			let specifier = call.arguments[0].extra.raw;

			// console.log(`import ${ specifier };`);
			convertImports.push({
				esmType: "bare-import",
				specifier,
				context: {
					statement: stmt,
				},
			});
			continue;
		}
		// var/let/const declaration statement?
		else if (T.isVariableDeclaration(stmt.node)) {
			for (let [declIdx,decl,] of stmt.node.declarations.entries()) {
				// normal identifier declaration? var x = ..
				if (T.isIdentifier(decl.id)) {
					// call as initialization assignment? var x = require("..")
					if (
						T.isCallExpression(decl.init) &&
						stmtReqCalls.find(p => p.node == decl.init)
					) {
						let call = decl.init;
						let specifier = call.arguments[0].extra.raw;

						// console.log(`import * as ${ decl.id.name } from ${ specifier };`);
						// console.log(`import ${ decl.id.name } from ${ specifier };`);
						convertImports.push({
							esmType: "default-import",
							binding: decl.id.name,
							specifier,
							context: {
								statement: stmt,
								declaration: decl,
								declarationIdx: declIdx,
							},
						});
						continue;
					}
					else if (
						// require("..") is part of a simple member expression?
						T.isMemberExpression(decl.init) &&
						stmtReqCalls.find(p => p.node == decl.init.object) &&
						(
							// single property expression via . operator?
							// x = require("..").x
							T.isIdentifier(decl.init.property) ||
							// single property expression via [".."] operator?
							T.isStringLiteral(decl.init.property)
						)
					) {
						let call = decl.init.object;
						let specifier = call.arguments[0].extra.raw;
						let target = decl.id.name;
						let source =
							T.isIdentifier(decl.init.property) ?
								decl.init.property.name :
							T.isStringLiteral(decl.init.property) ?
								decl.init.property.value :
							undefined;
						if (source) {
							// console.log(`import { ${ binding } } from ${ specifier };`);
							convertImports.push({
								esmType: "named-import",
								binding: {
									source,
									target,
								},
								specifier,
								context: {
									statement: stmt,
									declaration: decl,
									declarationIdx: declIdx,
								},
							});
							continue;
						}
					}
					// otherwise, a variable declaration without a `require(..)` in it
					else {
						continue;
					}
				}
				// destructuring assignment? var { x } = require("..")
				else if (
					T.isObjectPattern(decl.id) &&
					T.isCallExpression(decl.init) &&
					stmtReqCalls.find(p => p.node == decl.init)
				) {
					let call = decl.init;
					let specifier = call.arguments[0].extra.raw;
					let pattern = decl.id;
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
						console.error("Unsupported: destructuring pattern not ESM import-compatible");
					}

					if (bindings.length > 0) {
						// console.log(`import { ${ binding } } from ${ specifier };`);
						convertImports.push({
							esmType: "named-import",
							binding: bindings,
							specifier,
							context: {
								statement: stmt,
								declaration: decl,
								declarationIdx: declIdx,
							},
						});
						continue;
					}
				}

				// if we get here, the `require(..)` wasn't of a supported form
				console.error("Unsupported: variable declaration not ESM import-compatible");
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
				// simple call assignment? x = require("..")
				if (stmtReqCalls.find(p => p.node == assignment.right)) {
					let call = assignment.right;
					let specifier = call.arguments[0].extra.raw;
					let target = assignment.left.name;

					// console.log(`import * as ${ target$1 } from ${ specifier }; ${ target } = ${ target$1 };`);
					// console.log(`import ${ target$1 } from ${ specifier }; ${ target } = ${ target$1 };`);
					convertImports.push({
						esmType: "default-import-indirect",
						binding: {
							target,
						},
						specifier,
						context: {
							statement: stmt,
						},
					});
					continue;
				}
				else if (
					// require("..") part of a simple member expression?
					T.isMemberExpression(assignment.right) &&
					stmtReqCalls.find(p => p.node == assignment.right.object) &&
					(
						// single property expression via . operator?
						// x = require("..").x
						T.isIdentifier(assignment.right.property) ||
						// single property expression via [".."] operator?
						// x = require("..")[".."]
						T.isStringLiteral(assignment.right.property)
					)
				) {
					let call = assignment.right.object;
					let specifier = call.arguments[0].extra.raw;
					let target = assignment.left.name;
					let source =
						T.isIdentifier(assignment.right.property) ?
							assignment.right.property.name :
						T.isStringLiteral(assignment.right.property) ?
							assignment.right.property.value :
						undefined;
					if (source) {
						// console.log(`import { ${ binding } } from ${ specifier }; ${ target } = ${ target$1 };`);
						convertImports.push({
							esmType: "named-import-indirect",
							binding: {
								source,
								target,
							},
							specifier,
							context: {
								statement: stmt,
							},
						});
						continue;
					}
				}
			}
			// destructuring assignment? { x } = require("..")
			else if (
				T.isObjectPattern(assignment.left) &&
				stmtReqCalls.find(p => p.node == assignment.right)
			) {
				let call = assignment.right;
				let specifier = call.arguments[0].extra.raw;
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
							});
							continue;
						}
					}

					// if we get here, the `require(..)` wasn't of a supported form
					console.error("Unsupported: destructuring pattern not ESM import-compatible");
				}

				if (bindings.length > 0) {
					console.log(bindings);

					// console.log(`import { ${ binding } } from ${ specifier };`);
					convertImports.push({
						esmType: "named-import-indirect",
						binding: bindings,
						specifier,
						context: {
							statement: stmt,
						},
					});
					continue;
				}
			}
		}

		// if we get here, the `require(..)` wasn't of a supported form
		console.error("Unsupported: require(..) statement not ESM import-compatible");
	}
}

function analyzeExports() {
	for (let stmt of exportStatements) {
		let stmtExpAssignments = exportAssignments.get(stmt);

		// single export assignment?
		if (
			T.isExpressionStatement(stmt.node) &&
			T.isAssignmentExpression(stmt.node.expression) &&
			stmtExpAssignments.length == 1
		) {
			let assg = stmt.node.expression;
			let target = assg.left;
			let source = assg.right;

			if (target == stmtExpAssignments[0].node) {
				if (
					T.isIdentifier(target,{ name: "exports", }) ||
					(
						T.isMemberExpression(target) &&
						T.isIdentifier(target.object,{ name: "module", }) &&
						T.isIdentifier(target.property,{ name: "exports", })
					)
				) {
					let expVal = exportPrimitiveLiteralValue(source);

					// exporting a primitive/literal value?
					if (expVal) {
						// console.log(`export default ${ expVal };`);
						convertExports.push({
							esmType: "default-export-simple",
							binding: {
								source: expVal,
							},
							context: {
								statement: stmt,
							},
						});
						continue;
					}
					// exporting an identifier?
					else if (T.isIdentifier(source)) {
						// console.log(`export default ${ source.name };`);
						convertExports.push({
							esmType: "default-export-simple",
							binding: {
								source: source.name,
							},
							context: {
								statement: stmt,
							},
						});
						continue;
					}
					// exporting any other value/expression
					else {
						// console.log("export default ..;");
						convertExports.push({
							esmType: "default-export-complex",
							binding: {
								source,
							},
							context: {
								statement: stmt,
							},
						});
						continue;
					}
				}
			}
			else if (T.isMemberExpression(target,{ object: stmtExpAssignments[0].node, })) {
				let exportName =
					T.isIdentifier(target.property) ? target.property.name :
					T.isStringLiteral(target.property) ? target.property.value :
					undefined;
				target = target.object;

				if (
					T.isIdentifier(target,{ name: "exports", }) ||
					(
						T.isMemberExpression(target) &&
						T.isIdentifier(target.object,{ name: "module", }) &&
						T.isIdentifier(target.property,{ name: "exports", })
					)
				) {
					let expVal = exportPrimitiveLiteralValue(source);

					// exporting a primitive/literal value?
					if (expVal) {
						// console.log(`var ${ exportName }$1 = ${ expVal }; export { ${exportName}$1 as ${ exportName } };`);
						convertExports.push({
							esmType: "named-declaration-export-simple",
							binding: {
								source: expVal,
								target: exportName,
							},
							context: {
								statement: stmt,
							},
						});
						continue;
					}
					// exporting an identifier?
					else if (T.isIdentifier(source)) {
						// export == source?
						if (source.name == exportName) {
							// console.log(`export { ${ source.name } };`);
							convertExports.push({
								esmType: "named-export",
								binding: {
									source: source.name,
								},
								context: {
									statement: stmt,
								},
							});
							continue;
						}
						// export renamed
						else {
							// console.log(`export { ${ source.name } as ${ exportName } };`);
							convertExports.push({
								esmType: "named-export",
								binding: {
									source: source.name,
									target: exportName,
								},
								context: {
									statement: stmt,
								},
							});
							continue;
						}
					}
					// exporting any other value/expression
					else {
						// console.log(`var ${ exportName }$1 = ..; export { ${exportName}$1 as ${ exportName } };`);
						convertExports.push({
							esmType: "named-declaration-export-complex",
							binding: {
								source,
								target: exportName,
							},
							context: {
								statement: stmt,
							},
						});
						continue;
					}
				}
			}
		}

		// if we get here, the exports/module.exports wasn't of a supported form
		console.error("Unsupported: exports expression not ESM export-compatible");
	}
}

function exportPrimitiveLiteralValue(node) {
	if (T.isStringLiteral(node)) {
		return node.extra.raw;
	}
	else if (T.isIdentifier(node,{ name: "undefined", })) {
		return "undefined";
	}
	else if (T.isNullLiteral(node)) {
		return "null";
	}
	else if (
		T.isNumericLiteral(node) ||
		T.isBooleanLiteral(node)
	) {
		return String(node.value);
	}
}

function findParentStatement(path) {
	if (T.isProgram(path)) {
		return null;
	}
	else if (T.isStatement(path)) {
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
