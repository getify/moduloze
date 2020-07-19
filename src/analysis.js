"use strict";

var { default: traverse, } = require("@babel/traverse");
var T = require("@babel/types");
var { default: generate, } = require("@babel/generator");
var { parse, } = require("@babel/parser");

var {
	findParentStatement,
	isFunction,
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
	var exportReferences = new WeakMap();

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
				if (isModuleExports(path.node)) {
					let parentStatementPath = findParentStatement(path.parentPath);
					if (parentStatementPath) {
						exportStatements.add(parentStatementPath);
						if (!exportReferences.has(parentStatementPath)) {
							exportReferences.set(parentStatementPath,{
								type: (
									isAssignmentTarget(path) ? "assignment" : "expression"
								),
								refs: [],
							});
						}
						exportReferences.get(parentStatementPath).refs.push(path);
					}
				}
			}
		},
		Identifier: {
			exit(path) {
				// exports?
				if (
					path.node.name == "exports" &&
					// not part of a member expression? (intentionally excludes module.exports)
					!T.isMemberExpression(path.parent,{ property: path.node, }) &&
					(
						// in a left-hand assignment target postion?
						isAssignmentTarget(path) ||
						(
							// not a function parameter
							!isFunction(path.parentPath) &&
							// not a property in an object literal
							!T.isObjectProperty(path.parent,{ key: path.node, })
						)
					)
				) {
					let parentStatementPath = findParentStatement(path.parentPath);
					if (parentStatementPath) {
						exportStatements.add(parentStatementPath);
						if (!exportReferences.has(parentStatementPath)) {
							exportReferences.set(parentStatementPath,{
								type: (
									isAssignmentTarget(path) ? "assignment" : "expression"
								),
								refs: [],
							});
						}
						exportReferences.get(parentStatementPath).refs.push(path);
					}
				}
			}
		}
	};

	var programAST = parse(code,{ sourceFilename: codePath, });
	traverse(programAST,visitors);
	var convertRequires = analyzeRequires(requireStatements,requireCalls);
	var convertExports = analyzeExports(exportStatements,exportReferences);

	return {
		programAST,
		programPath,
		convertRequires,
		convertExports,
	};
}

function analyzeRequires(requireStatements,requireCalls) {
	var convertRequires = [];

	for (let stmtPath of requireStatements) {
		if (!T.isProgram(stmtPath.parent)) {
			throw new Error("Require statements must be at the top-level of the program");
		}
		let stmtReqCalls = [ ...requireCalls.get(stmtPath), ];

		// standalone require(".."")?
		if (
			T.isExpressionStatement(stmtPath.node) &&
			T.isCallExpression(stmtPath.node.expression) &&
			stmtReqCalls.length == 1 &&
			stmtReqCalls[0].node == stmtPath.node.expression
		) {
			// unset entry to mark this require(..) expression as handled
			stmtReqCalls[0] = false;

			let call = stmtPath.node.expression;
			let specifier = call.arguments[0].extra.rawValue;

			// console.log(`import ${ specifier };`);
			convertRequires.push({
				esmType: "bare-import",
				umdType: "remove-require-unique",
				specifier,
				context: {
					statement: stmtPath,
				},
			});
		}
		// var/let/const declaration statement?
		else if (T.isVariableDeclaration(stmtPath.node)) {
			for (let [ declIdx, declNode, ] of stmtPath.node.declarations.entries()) {
				// no require(..) in this declaration, so skip?
				if (!hasRequireCalls(stmtPath,declNode.init,stmtReqCalls)) {
					continue;
				}

				let decl = stmtPath.get(`declarations.${ declIdx }`);

				// normal identifier declaration? var x = ..
				if (T.isIdentifier(declNode.id)) {
					// call as initialization assignment? var x = require(..)
					if (T.isCallExpression(declNode.init) &&
						stmtReqCalls.find(p => p.node == declNode.init)
					) {
						// unset entry to mark this require(..) expression as handled
						stmtReqCalls[stmtReqCalls.findIndex(p => p.node == declNode.init)] = false;

						let callPath = decl.get("init");
						let call = callPath.node;
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
								statement: stmtPath,
								declarator: decl,
								declarationIdx: declIdx,
								requireCall: callPath,
							},
						});
					}
					else if (
						// require(..) is part of a simple member expression?
						isSimpleMemberExpression(declNode.init,declNode) &&
						stmtReqCalls.find(p => p.node == declNode.init.object)
					) {
						// unset entry to mark this require(..) expression as handled
						stmtReqCalls[stmtReqCalls.findIndex(p => p.node == declNode.init.object)] = false;

						let callPath = decl.get("init.object");
						let call = callPath.node;
						let specifier = call.arguments[0].extra.rawValue;
						let target = declNode.id.name;
						let source =
							T.isIdentifier(declNode.init.property) ?
								declNode.init.property.name :
							T.isStringLiteral(declNode.init.property) ?
								declNode.init.property.value :
							undefined;

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
								statement: stmtPath,
								declarator: decl,
								declarationIdx: declIdx,
								requireCall: callPath,
							},
						});
					}
				}
				// destructuring assignment? var { x } = require(..)
				else if (
					T.isObjectPattern(declNode.id) &&
					T.isCallExpression(declNode.init) &&
					stmtReqCalls.find(p => p.node == declNode.init)
				) {
					// unset entry to mark this require(..) expression as handled
					stmtReqCalls[stmtReqCalls.findIndex(p => p.node == declNode.init)] = false;

					let callPath = decl.get("init");
					let call = callPath.node;
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

							bindings.push({
								source,
								target: targetProp.value.name,
							});
							continue;
						}

						// if we get here, the destructuring wasn't of a supported ESM import form
						throw new Error("Unsupported: destructuring pattern not ESM import-compatible");
					}

					// console.log(`import { ${ binding } } from ${ specifier };`);
					convertRequires.push({
						esmType: "named-import",
						umdType: "destructured-dependency",
						binding: bindings,
						specifier,
						context: {
							statement: stmtPath,
							declarator: decl,
							declarationIdx: declIdx,
							requireCall: callPath,
						},
					});
				}
			}
		}
		// non-declaration assignment statement?
		else if (
			T.isExpressionStatement(stmtPath.node) &&
			T.isAssignmentExpression(stmtPath.node.expression)
		) {
			let assignment = stmtPath.node.expression;

			// regular identifier assignment? x = ..
			if (T.isIdentifier(assignment.left)) {
				// simple call assignment? x = require(..)
				if (stmtReqCalls.find(p => p.node == assignment.right)) {
					// unset entry to mark this require(..) expression as handled
					stmtReqCalls[stmtReqCalls.findIndex(p => p.node == assignment.right)] = false;

					let callPath = stmtPath.get("expression.right");
					let call = callPath.node;
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
							uniqueTarget: stmtPath.scope.generateUidIdentifier("imp").name,
						},
						specifier,
						context: {
							statement: stmtPath,
							requireCall: callPath,
						},
					});
				}
				else if (
					// require(..) part of a simple member expression?
					isSimpleMemberExpression(assignment.right,assignment) &&
					stmtReqCalls.find(p => p.node == assignment.right.object)
				) {
					// unset entry to mark this require(..) expression as handled
					stmtReqCalls[stmtReqCalls.findIndex(p => p.node == assignment.right.object)] = false;

					let callPath = stmtPath.get("expression.right.object");
					let call = callPath.node;
					let specifier = call.arguments[0].extra.rawValue;
					let target = assignment.left.name;
					let source =
						T.isIdentifier(assignment.right.property) ?
							assignment.right.property.name :
						T.isStringLiteral(assignment.right.property) ?
							assignment.right.property.value :
						undefined;

					// console.log(`import { ${ binding } } from ${ specifier }; ${ target } = ${ target$1 };`);
					convertRequires.push({
						esmType: "named-import-indirect",
						umdType: "indirect-source-target",
						binding: {
							source,
							target,
							uniqueTarget: stmtPath.scope.generateUidIdentifier("imp").name,
						},
						specifier,
						context: {
							statement: stmtPath,
							requireCall: callPath,
						},
					});
				}
			}
			// destructuring assignment? { x } = require(..)
			else if (
				T.isObjectPattern(assignment.left) &&
				stmtReqCalls.find(p => p.node == assignment.right)
			) {
				// unset entry to mark this require(..) expression as handled
				stmtReqCalls[stmtReqCalls.findIndex(p => p.node == assignment.right)] = false;

				let callPath = stmtPath.get("expression.right");
				let call = callPath.node;
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

						bindings.push({
							source,
							target: targetProp.value.name,
							uniqueTarget: stmtPath.scope.generateUidIdentifier("imp").name,
						});
						continue;
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
							statement: stmtPath,
							requireCall: callPath,
						},
					});
				}
			}
			// default or named re-export? (aka, "combo")
			// ie, module.exports = require(..).. OR module.exports.x = require(..)..
			else if (
				isModuleExports(assignment.left) ||
				(
					isSimpleMemberExpression(assignment.left,assignment) &&
					isModuleExports(assignment.left.object)
				)
			) {
				let target = assignment.left;

				// require(..) by itself?
				if (stmtReqCalls.find(p => p.node == assignment.right)) {
					// unset entry to mark this require(..) expression as handled
					stmtReqCalls[stmtReqCalls.findIndex(p => p.node == assignment.right)] = false;

					let callPath = stmtPath.get("expression.right");
					let call = callPath.node;
					let specifier = call.arguments[0].extra.rawValue;

					// console.log(`import * as ${ target$1 } from ${ specifier }; ${ target } = ${ target$1 };`);
					// console.log(`import ${ target$1 } from ${ specifier }; ${ target } = ${ target$1 };`);
					convertRequires.push({
						esmType: "default-import-indirect",
						umdType: "indirect-target",
						binding: {
							source: "default",
							target,
							uniqueTarget: stmtPath.scope.generateUidIdentifier("imp").name,
						},
						specifier,
						context: {
							statement: stmtPath,
							requireCall: callPath,
						},
					});
				}
				// require(..).x form?
				else if (
					isSimpleMemberExpression(assignment.right,assignment) &&
					stmtReqCalls.find(p => p.node == assignment.right.object)
				) {
					// unset entry to mark this require(..) expression as handled
					stmtReqCalls[stmtReqCalls.findIndex(p => p.node == assignment.right.object)] = false;

					let callPath = stmtPath.get("expression.right.object");
					let call = callPath.node;
					let specifier = call.arguments[0].extra.rawValue;
					let source =
						T.isIdentifier(assignment.right.property) ?
							assignment.right.property.name :
						T.isStringLiteral(assignment.right.property) ?
							assignment.right.property.value :
						undefined;

					// console.log(`import { ${ binding } } from ${ specifier }; ${ target } = ${ target$1 };`);
					convertRequires.push({
						esmType: "named-import-indirect",
						umdType: "indirect-source-target",
						binding: {
							source,
							target,
							uniqueTarget: stmtPath.scope.generateUidIdentifier("imp").name,
						},
						specifier,
						context: {
							statement: stmtPath,
							requireCall: callPath,
						},
					});
				}
			}
		}

		// remove entries marked as handled
		stmtReqCalls = stmtReqCalls.filter(Boolean);

		// any unhandled require(..) occurences in this statement?
		// handle them as simple expression substitutions
		if (stmtReqCalls.length > 0) {
			convertRequires = [
				...convertRequires,
				...stmtReqCalls.map(function handleReqCall(reqCallPath){
					return analyzeRequireSubstitutions(stmtPath,reqCallPath);
				})
			];
		}
	}

	return convertRequires;
}

function analyzeRequireSubstitutions(stmtPath,callPath) {
	var specifier = callPath.node.arguments[0].extra.rawValue;

	// require(..).x form?
	if (
		isSimpleMemberExpression(callPath.parent,callPath.parentPath.parent)
	) {
		let source =
			T.isIdentifier(callPath.parent.property) ?
				callPath.parent.property.name :
			T.isStringLiteral(callPath.parent.property) ?
				callPath.parent.property.value :
			undefined;

		// console.log(`import { ${ binding } } from ${ specifier }; ${ target } = ${ target$1 };`);
		return {
			esmType: "substitute-named-import-indirect",
			umdType: "substitute-indirect-source-target",
			binding: {
				source,
				uniqueTarget: stmtPath.scope.generateUidIdentifier("imp").name,
			},
			specifier,
			context: {
				statement: stmtPath,
				requireCall: callPath,
				expression: callPath.parentPath,
			},
		};
	}
	// assume just simple require(..) form
	else {
		// console.log(`import * as ${ target$1 } from ${ specifier }; ${ target } = ${ target$1 };`);
		// console.log(`import ${ target$1 } from ${ specifier }; ${ target } = ${ target$1 };`);
		return {
			esmType: "substitute-default-import-indirect",
			umdType: "substitute-indirect-target",
			binding: {
				source: "default",
				uniqueTarget: stmtPath.scope.generateUidIdentifier("imp").name,
			},
			specifier,
			context: {
				statement: stmtPath,
				requireCall: callPath,
			},
		};
	}
}

function analyzeExports(exportStatements,exportReferences) {
	var convertExports = [];

	for (let stmtPath of exportStatements) {
		if (!T.isProgram(stmtPath.parent)) {
			throw new Error("Exports expressions must be at the top-level of the program");
		}
		let stmtExportExpressions = exportReferences.get(stmtPath);
		let exprRefs = stmtExportExpressions.refs;

		if (stmtExportExpressions.type == "assignment") {
			// single export assignment?
			if (
				T.isExpressionStatement(stmtPath.node) &&
				T.isAssignmentExpression(stmtPath.node.expression) &&
				exprRefs.length == 1
			) {
				let assignment = stmtPath.node.expression;
				let target = assignment.left;
				let source = assignment.right;

				// assigning to `exports` or `module.exports`?
				if (target == exprRefs[0].node) {
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
								statement: stmtPath,
								exportsExpression: stmtPath.get("expression.left"),
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
								statement: stmtPath,
								exportsExpression: stmtPath.get("expression.left"),
							},
						});
						continue;
					}
				}
				// assigning to property on module.exports? module.exports.x = ..
				else if (
					T.isMemberExpression(target,{ object: exprRefs[0].node, }) &&
					isSimpleMemberExpression(target,assignment)
				) {
					let exportName =
						T.isIdentifier(target.property) ? target.property.name :
						T.isStringLiteral(target.property) ? target.property.value :
						undefined;

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
								statement: stmtPath,
								exportsExpression: stmtPath.get("expression.left.object"),
							},
						});
						continue;
					}
					// exporting member-expression that can be destructured?
					else if (isSimpleMemberExpression(source,assignment)) {
						let sourceName = (
							T.isIdentifier(source.property) ? source.property.name :
							T.isStringLiteral(source.property) ? source.property.value :
							undefined
						);

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
								statement: stmtPath,
								exportsExpression: stmtPath.get("expression.left.object"),
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
								uniqueTarget: stmtPath.scope.generateUidIdentifier("exp").name,
							},
							context: {
								statement: stmtPath,
								exportsExpression: stmtPath.get("expression.left.object"),
							},
						});
						continue;
					}
				}
			}
		}
		else if (stmtExportExpressions.type == "expression") {
			for (let ref of exprRefs) {
				convertExports.push({
					esmType: "substitute-module-exports-reference",
					umdType: "substitute-module-exports-reference",
					context: {
						statement: stmtPath,
						exportsExpression: ref,
					},
				});
			}
			continue;
		}

		// if we get here, the module.exports expression wasn't of a supported form
		throw new Error("Unsupported: exports expression not ESM export-compatible");
	}

	return convertExports;
}

function hasRequireCalls(stmtPath,node,stmtReqCalls) {
	for (let reqCall of stmtReqCalls) {
		let curPath = reqCall;
		while (curPath && curPath != stmtPath) {
			if (curPath.node == node) return true;
			curPath = curPath.parentPath;
		}
	}
	return false;
}

function isModuleExports(node) {
	return (
		T.isIdentifier(node,{ name: "exports", }) ||
		(
			T.isMemberExpression(node) &&
			T.isIdentifier(node.object,{ name: "module", }) &&
			(
				// single property expression via . operator? module.exports
				(
					!node.computed &&
					T.isIdentifier(node.property,{ name: "exports", })
				) ||
				// single property expression via [".."] operator? x["y"]
				(
					node.computed &&
					T.isStringLiteral(node.property,{ value: "exports", })
				)
			)
		)
	);
}

function isSimpleMemberExpression(node,parentNode) {
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
		) &&
		!T.isCallExpression(parentNode)
	);
}
